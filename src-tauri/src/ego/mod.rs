use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{process::Child, sync::Mutex as AsyncMutex};

pub mod api;
pub mod tools;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgoConfig {
    pub enabled: bool,
    pub endpoint: String,
    #[serde(default)]
    pub server_name: String,
}

struct Bridge {
    port: u16,
    token: String,
    lease: PathBuf,
    child: Child,
    heartbeat: tokio::task::JoinHandle<()>,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.heartbeat.abort();
        let _ = std::fs::remove_file(&self.lease);
    }
}

pub struct EgoService {
    root: PathBuf,
    runtime: AsyncMutex<Option<Bridge>>,
    client: reqwest::Client,
}

impl EgoService {
    pub async fn stream(&self, request: Value) -> Result<reqwest::Response, String> {
        // 先走同一监督器确认当前桥接；只读 session 不会接管或恢复任务。
        self.request(json!({"method": "session", "sessionId": request["sessionId"]}))
            .await?;
        let (port, token) = {
            let runtime = self.runtime.lock().await;
            let bridge = runtime.as_ref().ok_or("Ego 桥接未启动。")?;
            (bridge.port, bridge.token.clone())
        };
        let response = tokio::time::timeout(
            Duration::from_secs(10),
            self.client
                .post(format!("http://127.0.0.1:{port}/"))
                .bearer_auth(token)
                .json(&request)
                .send(),
        )
        .await
        .map_err(|_| "Ego 画面通道启动超时。".to_string())?
        .map_err(|_| "无法连接 Ego 画面通道。".to_string())?;
        if !response.status().is_success() {
            return Err("Ego 页面尚未就绪，请确认恢复后重试。".into());
        }
        Ok(response)
    }

    pub fn shared(data_dir: &Path) -> Arc<Self> {
        static SERVICES: OnceLock<Mutex<HashMap<PathBuf, Arc<EgoService>>>> = OnceLock::new();
        let root = data_dir.join("ego");
        let mut services = SERVICES
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        services
            .entry(root.clone())
            .or_insert_with(|| {
                Arc::new(Self {
                    root,
                    runtime: AsyncMutex::new(None),
                    client: reqwest::Client::builder()
                        .no_proxy()
                        .connect_timeout(Duration::from_secs(2))
                        .build()
                        .expect("loopback client"),
                })
            })
            .clone()
    }

    pub async fn config(&self) -> Result<EgoConfig, String> {
        match tokio::fs::read(self.root.join("config.json")).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "Ego 配置无法读取，请检查原文件。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(EgoConfig::default()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn configure(&self, config: EgoConfig) -> Result<Value, String> {
        if config.enabled {
            validate_endpoint(&config.endpoint)?;
        }
        if config.server_name.len() > 128 || config.server_name.contains(['\r', '\n', '\0']) {
            return Err("Ego 实例名称无效。".into());
        }
        let mut runtime = self.runtime.lock().await;
        if let Some(mut bridge) = runtime.take() {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                self.rpc(&bridge, &json!({"method": "shutdown"})),
            )
            .await;
            let _ = bridge.child.kill().await;
        }
        tokio::fs::create_dir_all(&self.root)
            .await
            .map_err(|error| error.to_string())?;
        let temporary = self
            .root
            .join(format!("config-{}.tmp", uuid::Uuid::new_v4()));
        tokio::fs::write(
            &temporary,
            serde_json::to_vec(&config).map_err(|error| error.to_string())?,
        )
        .await
        .map_err(|error| error.to_string())?;
        tokio::fs::rename(temporary, self.root.join("config.json"))
            .await
            .map_err(|error| error.to_string())?;
        Ok(json!({"configured": config.enabled}))
    }

    async fn start(&self, config: &EgoConfig) -> Result<Bridge, String> {
        validate_endpoint(&config.endpoint)?;
        let runtime_dir = self.root.join("runtime");
        tokio::fs::create_dir_all(&runtime_dir)
            .await
            .map_err(|error| error.to_string())?;
        for (name, source) in [
            ("broker.mjs", include_str!("../../ego/broker.mjs")),
            ("control.mjs", include_str!("../../ego/control.mjs")),
            ("cdp.mjs", include_str!("../../ego/cdp.mjs")),
            ("video.mjs", include_str!("../../ego/video.mjs")),
            ("rtc.mjs", include_str!("../../ego/rtc.mjs")),
            (
                "pixel-stream.mjs",
                include_str!("../../ego/pixel-stream.mjs"),
            ),
            ("pixel-png.mjs", include_str!("../../ego/pixel-png.mjs")),
            (
                "context-menu.mjs",
                include_str!("../../ego/context-menu.mjs"),
            ),
            (
                "agent.bundle.js",
                include_str!("../browser/js/agent.bundle.js"),
            ),
        ] {
            tokio::fs::write(runtime_dir.join(name), source)
                .await
                .map_err(|error| error.to_string())?;
        }
        let launch = uuid::Uuid::new_v4().to_string();
        let ready = runtime_dir.join(format!("ready-{launch}.json"));
        let lease = runtime_dir.join(format!("lease-{launch}"));
        tokio::fs::write(&lease, b"alive")
            .await
            .map_err(|error| error.to_string())?;
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let options = json!({
            "dataDir": self.root.join("sessions"), "endpoint": config.endpoint,
            "token": token, "readyPath": ready, "leasePath": lease,
            "agentBundlePath": runtime_dir.join("agent.bundle.js"),
            // Ego CLI 的隔离 Node 环境不保证继承环境变量，执行路径通过可信启动配置传入。
            "videoEncoder": std::env::var("CODEG_EGO_VIDEO_ENCODER").ok(),
            "pixelCodec": std::env::var("CODEG_EGO_PIXEL_CODEC").ok(),
            "rtcIceServers": std::env::var("CODEG_EGO_ICE_SERVERS")
                .ok().and_then(|value| serde_json::from_str::<Value>(&value).ok())
                .filter(Value::is_array).unwrap_or_else(|| json!([])),
        });
        let module = reqwest::Url::from_file_path(runtime_dir.join("broker.mjs"))
            .map_err(|_| "Ego 桥接脚本路径无效。")?;
        let script = format!(
            "const {{serve}} = await import({}); const {{server}} = await serve({}); await new Promise(resolve => server.on('close', resolve));",
            serde_json::to_string(module.as_str()).map_err(|error| error.to_string())?, options,
        );
        let executable = std::env::var_os("CODEG_EGO_CLI")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_default()
                    .join(".local/share/ego/active_version_dir/ego-browser.exe")
            });
        if !executable.is_file() {
            return Err("未找到 Ego CLI，请先安装原版 Ego。".into());
        }
        let mut command = tokio::process::Command::new(executable);
        command.arg("nodejs");
        if !config.server_name.is_empty() {
            command.arg(format!("--ego-server-name={}", config.server_name));
        }
        command.arg("-e").arg(&script);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 Ego 桥接：{error}"))?;
        // Ego CLI 在脚本结束前缓存 stdout；用每次启动独有的就绪文件确认真实监听端口。
        let result = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Ok(bytes) = tokio::fs::read(&ready).await {
                    let value: Value =
                        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
                    let port = value["port"]
                        .as_u64()
                        .filter(|port| *port > 0 && *port <= 65535)
                        .ok_or("Ego 就绪端口无效。")?;
                    return Ok::<u16, String>(port as u16);
                }
                if child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    return Err(
                        "Ego 桥接已退出，请确认指定的 Ego 实例正在运行并已开启本机页面通道。"
                            .into(),
                    );
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .map_err(|_| {
            "Ego 桥接启动超时，请检查 Ego 实例和页面通道；未重启或切换您的浏览器。".to_string()
        })??;
        let heartbeat = lease.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(3)).await;
                if !heartbeat.exists() {
                    break;
                }
                if tokio::fs::write(&heartbeat, b"alive").await.is_err() {
                    break;
                }
            }
        });
        let _ = tokio::fs::remove_file(ready).await;
        Ok(Bridge {
            port: result,
            token,
            lease,
            child,
            heartbeat,
        })
    }

    async fn rpc(&self, bridge: &Bridge, request: &Value) -> Result<Value, String> {
        self.rpc_at(bridge.port, &bridge.token, request).await
    }

    async fn rpc_at(&self, port: u16, token: &str, request: &Value) -> Result<Value, String> {
        let response = self
            .client
            .post(format!("http://127.0.0.1:{port}/"))
            .timeout(Duration::from_secs(if request["method"] == "agent" {
                24 * 60 * 60
            } else {
                30
            }))
            .bearer_auth(token)
            .json(request)
            .send()
            .await
            .map_err(|_| {
                "Ego 页面通道已中断；请恢复连接后检查页面，未重放未确认的操作。".to_string()
            })?;
        let value: Value = response
            .json()
            .await
            .map_err(|_| "Ego 页面通道返回了无效数据。".to_string())?;
        if let Some(error) = value.get("error") {
            return Err(format!(
                "{}: {}",
                error["code"].as_str().unwrap_or("ego_failed"),
                error["message"].as_str().unwrap_or("Ego 操作失败。")
            ));
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| "Ego 页面通道没有确认操作结果。".into())
    }

    pub async fn request(&self, request: Value) -> Result<Value, String> {
        let (port, token) = {
            let mut runtime = self.runtime.lock().await;
            // 与配置保存共用锁，避免旧请求在用户禁用或切换实例后重新启动旧桥接。
            let config = self.config().await?;
            if !config.enabled {
                return Err("Ego 页面集成尚未启用。".into());
            }
            let mut restart = false;
            if let Some(bridge) = runtime.as_mut() {
                restart = bridge
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some()
                    || !self
                        .rpc(bridge, &json!({"method": "health"}))
                        .await
                        .is_ok_and(|status| status["connected"] == true);
            }
            if restart {
                if let Some(mut bridge) = runtime.take() {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(2),
                        self.rpc(&bridge, &json!({"method": "shutdown"})),
                    )
                    .await;
                    let _ = bridge.child.kill().await;
                }
            }
            if runtime.is_none() {
                *runtime = Some(self.start(&config).await?);
            }
            let bridge = runtime.as_ref().ok_or("Ego 桥接未启动。")?;
            (bridge.port, bridge.token.clone())
        };
        self.rpc_at(port, &token, &request).await
    }
}

fn validate_endpoint(value: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(value).map_err(|_| "Ego 页面通道地址无效。")?;
    if parsed.scheme() != "http"
        || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || value
            .split('/')
            .nth(2)
            .is_some_and(|authority| authority.contains('@'))
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err("Ego 页面通道必须是本机回环 HTTP 地址。".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_stays_on_loopback_without_embedded_credentials() {
        assert!(validate_endpoint("http://127.0.0.1:9222").is_ok());
        assert!(validate_endpoint("http://localhost:9222/").is_ok());
        for endpoint in [
            "https://127.0.0.1:9222",
            "http://192.168.1.2:9222",
            "http://user@localhost:9222",
            "http://localhost:9222/json",
            "http://localhost:9222/?token=x",
        ] {
            assert!(validate_endpoint(endpoint).is_err(), "{endpoint}");
        }
    }

    #[tokio::test]
    #[ignore = "需要显式指定独立后台 Ego 的 CODEG_EGO_PROOF_ENDPOINT 与 CODEG_EGO_PROOF_SERVER"]
    async fn live_supervisor_preserves_page_and_waits_for_return() {
        let endpoint = std::env::var("CODEG_EGO_PROOF_ENDPOINT").expect("独立测试 endpoint");
        let server_name = std::env::var("CODEG_EGO_PROOF_SERVER").expect("独立测试 Ego 实例");
        let directory = tempfile::Builder::new()
            .prefix("codeg-ego-supervisor-")
            .tempdir_in("F:/tmp/ego")
            .unwrap();
        let service = EgoService::shared(directory.path());
        let config = EgoConfig {
            enabled: true,
            endpoint,
            server_name,
        };
        service.configure(config.clone()).await.unwrap();
        let opened = service
            .request(
                json!({"method": "agent", "sessionId": 9001, "kind": "open", "url": "about:blank"}),
            )
            .await
            .unwrap();
        let tab = opened["tab"]["tabId"].as_str().unwrap().to_owned();
        let state = service
            .request(json!({"method": "session", "sessionId": 9001}))
            .await
            .unwrap();
        let paused = service.request(json!({"method": "human", "sessionId": 9001, "clientId": "proof-device", "epoch": state["control"]["epoch"], "action": {"kind": "takeover"}})).await.unwrap();
        let pending_service = service.clone();
        let mut pending = tokio::spawn(async move {
            pending_service
                .request(json!({"method": "agent", "sessionId": 9001, "kind": "list"}))
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(150), &mut pending)
                .await
                .is_err()
        );
        service.request(json!({"method": "return", "sessionId": 9001, "clientId": "proof-device", "epoch": paused["control"]["epoch"]})).await.unwrap();
        let listed = tokio::time::timeout(Duration::from_secs(10), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(listed["tabs"][0]["tabId"], tab);
        service.configure(EgoConfig::default()).await.unwrap();
        service.configure(config).await.unwrap();
        let restored = service
            .request(json!({"method": "session", "sessionId": 9001}))
            .await
            .unwrap();
        assert_eq!(restored["control"]["recoveryRequired"], true);
        assert_eq!(restored["tabs"][0]["id"], tab);
        let confirmed = service.request(json!({"method": "restore", "sessionId": 9001, "clientId": "proof-device", "epoch": restored["control"]["epoch"]})).await.unwrap();
        assert_eq!(confirmed["control"]["recoveryRequired"], false);
        service
            .request(json!({"method": "agent", "sessionId": 9001, "kind": "close", "tabId": tab}))
            .await
            .unwrap();
        service.configure(EgoConfig::default()).await.unwrap();
    }
}
