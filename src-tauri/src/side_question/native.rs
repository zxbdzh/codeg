use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use super::{ConversationModel, PreparedQuestion};
use crate::acp::one_shot::OneShotError;
use crate::db::AppDatabase;
use crate::models::AgentType;

const RUNNER: &str = include_str!("native-runner.mjs");
const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCapability {
    pub supported: bool,
    pub images: bool,
}

pub(super) fn has_bridge(agent: AgentType) -> bool {
    matches!(
        agent,
        AgentType::Codex | AgentType::ClaudeCode | AgentType::Pi | AgentType::DeepSeek
    )
}

pub(super) async fn run(
    db: &AppDatabase,
    data_dir: &Path,
    source: &super::VerifiedSource,
    prepared: Option<&PreparedQuestion>,
    history: &[super::ContextEntry],
    cancel: &CancellationToken,
) -> Result<Value, OneShotError> {
    let ConversationModel {
        agent, id, effort, ..
    } = &source.model;
    if !has_bridge(*agent) {
        return Err(OneShotError::Unavailable(
            "This connection has no native side-question bridge".into(),
        ));
    }
    let node = which::which("node").map_err(|_| {
        OneShotError::Unavailable("Node.js is required for native side questions".into())
    })?;
    let runtime_env = crate::commands::acp::build_session_runtime_env(
        db,
        *agent,
        Some(&source.session_id),
        data_dir,
    )
    .await
    .map_err(|_| {
        OneShotError::Unavailable("Could not resolve the agent runtime settings".into())
    })?;
    let program = match agent {
        AgentType::Codex => {
            let configured = runtime_env
                .get("CODEX_PATH")
                .cloned()
                .or_else(|| std::env::var("CODEX_PATH").ok())
                .filter(|path| !path.trim().is_empty())
                .map(std::path::PathBuf::from);
            if configured.is_some() {
                configured
            } else {
                let runtime = crate::acp::codex_runtime::current().await;
                // 借用的全局安装不能证明就是主连接的运行时，无法核实时隐藏入口。
                if runtime.confirmed {
                    runtime.codex_js
                } else {
                    None
                }
            }
        }
        AgentType::ClaudeCode => {
            crate::commands::acp::resolve_npx_command_for(*agent, "claude-agent-acp").await
        }
        AgentType::Pi => {
            let configured = runtime_env
                .get("PI_ACP_PI_COMMAND")
                .cloned()
                .or_else(|| std::env::var("PI_ACP_PI_COMMAND").ok())
                .filter(|value| !value.trim().is_empty());
            // 自定义命令无法定位时拒绝借用全局 pi，以免旁问跑到不同运行时。
            match configured {
                Some(program) => which::which(program).ok(),
                None => which::which("pi").ok(),
            }
        }
        AgentType::DeepSeek => {
            crate::commands::acp::resolve_npx_command_for(*agent, "deepseek-acp").await
        }
        _ => None,
    }
    .ok_or_else(|| OneShotError::Unavailable("The native agent runtime is unavailable".into()))?;
    let mut command = crate::process::tokio_command(node);
    // stdin 是请求通道；脚本通过 -e 加载，源码和问题均不写入工作目录。
    let entry = format!(
        "{RUNNER}\nconst input = createInterface({{ input: process.stdin }}); \
         for await (const line of input) {{ try {{ \
         process.stdout.write(JSON.stringify(await execute(JSON.parse(line))) + '\\n'); \
         }} catch {{ process.stdout.write(JSON.stringify({{ error: \
         'The native side-question request failed' }}) + '\\n'); }} \
         input.close(); break; }}"
    );
    command
        .args(["--input-type=module", "-e", &entry])
        .current_dir(&source.working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (key, value) in runtime_env {
        if value.is_empty() {
            command.env_remove(key);
        } else {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().map_err(|_| {
        OneShotError::Unavailable("Could not start the native side-question bridge".into())
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| OneShotError::Failed("Native stdin is unavailable".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| OneShotError::Failed("Native stdout is unavailable".into()))?;
    let mut process = KillOnDrop(child);
    let mut request = serde_json::to_vec(&json!({
        "operation": if prepared.is_some() { "ask" } else { "probe" },
        "agent": agent,
        "program": program,
        "sessionId": source.session_id,
        "cwd": source.working_dir,
        "model": id,
        "effort": effort,
        "question": prepared.map(|question| &question.prompt),
        "images": prepared.map(|question| &question.images),
        "history": history,
    }))
    .map_err(|_| OneShotError::Failed("Could not encode the native side question".into()))?;
    request.push(b'\n');
    let operation = async {
        stdin
            .write_all(&request)
            .await
            .map_err(|_| OneShotError::Failed("Native input disconnected".into()))?;
        stdin
            .shutdown()
            .await
            .map_err(|_| OneShotError::Failed("Native input disconnected".into()))?;
        let mut output = Vec::new();
        stdout
            .take(MAX_OUTPUT_BYTES + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| OneShotError::Failed("Native output disconnected".into()))?;
        if output.len() as u64 > MAX_OUTPUT_BYTES {
            return Err(OneShotError::Failed(
                "The native side-question response is too large".into(),
            ));
        }
        let _ = process.0.wait().await;
        let response: Value = serde_json::from_slice(&output).map_err(|_| {
            OneShotError::Failed("The native bridge returned an invalid response".into())
        })?;
        if response.get("error").is_some() {
            return Err(OneShotError::Failed(
                "The native side-question request failed".into(),
            ));
        }
        Ok(response)
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(OneShotError::Cancelled),
        result = tokio::time::timeout(
            if prepared.is_some() { Duration::from_secs(30 * 60) } else { Duration::from_secs(15) },
            operation,
        ) => result.unwrap_or_else(|_| Err(OneShotError::Failed("The native side question timed out".into()))),
    }
}

struct KillOnDrop(tokio::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(Some(_))) {
            return;
        }
        if let Some(pid) = self.0.id() {
            let _ = kill_tree::blocking::kill_tree(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_verified_native_bridges_are_offered() {
        assert!(has_bridge(AgentType::Codex));
        assert!(has_bridge(AgentType::ClaudeCode));
        assert!(has_bridge(AgentType::Pi));
        assert!(has_bridge(AgentType::DeepSeek));
        assert!(!has_bridge(AgentType::Gemini));
    }
}
