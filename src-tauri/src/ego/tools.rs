use std::{path::Path, sync::Arc};

use async_trait::async_trait;
use base64::Engine;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::{
    acp::browser_tools::*,
    browser::{
        agent::ActionRequest,
        capture::{self, CaptureOutcome, CaptureRegion, CaptureRequest},
        console::ConsoleQuery,
        eval::EvalRequest,
    },
};

use super::EgoService;

pub struct RoutedBrowserTools {
    service: Arc<EgoService>,
    config: BrowserToolsRuntimeConfig,
    fallback: Arc<dyn BrowserToolAccess>,
}

impl RoutedBrowserTools {
    pub fn new(
        data_dir: &Path,
        config: BrowserToolsRuntimeConfig,
        fallback: Arc<dyn BrowserToolAccess>,
    ) -> Self {
        config.bind_ego(data_dir);
        Self {
            service: EgoService::shared(data_dir),
            config,
            fallback,
        }
    }
}

#[async_trait]
impl BrowserToolAccess for RoutedBrowserTools {
    async fn for_session(&self, session_id: Option<i32>) -> Option<Arc<dyn BrowserToolAccess>> {
        match self.service.config().await {
            Ok(config) if !config.enabled => return None,
            Err(_) => return Some(Arc::new(NoBrowserTabs)),
            _ => {}
        }
        Some(match session_id {
            Some(session_id) => Arc::new(SessionBrowserTools {
                service: self.service.clone(),
                config: self.config.clone(),
                session_id,
            }) as Arc<dyn BrowserToolAccess>,
            None => Arc::new(NoBrowserTabs),
        })
    }

    async fn list_tabs(&self) -> BrowserTabsOutcome {
        self.fallback.list_tabs().await
    }
    async fn snapshot(&self, tab_id: &str, max_chars: Option<usize>) -> BrowserSnapshotOutcome {
        self.fallback.snapshot(tab_id, max_chars).await
    }
    async fn act(&self, tab_id: &str, request: ActionRequest) -> BrowserActOutcome {
        self.fallback.act(tab_id, request).await
    }
    async fn console(&self, tab_id: &str, query: ConsoleQuery) -> BrowserConsoleOutcome {
        self.fallback.console(tab_id, query).await
    }
    async fn capture(&self, tab_id: &str, request: CaptureRequest) -> BrowserCaptureOutcome {
        self.fallback.capture(tab_id, request).await
    }
    async fn eval(&self, tab_id: &str, request: EvalRequest) -> BrowserEvalOutcome {
        self.fallback.eval(tab_id, request).await
    }
    async fn tab_op(&self, op: BrowserTabOp) -> BrowserTabOutcome {
        self.fallback.tab_op(op).await
    }
}

struct SessionBrowserTools {
    service: Arc<EgoService>,
    config: BrowserToolsRuntimeConfig,
    session_id: i32,
}

impl SessionBrowserTools {
    async fn call<T: DeserializeOwned>(&self, kind: &str, mut params: Value) -> Result<T, String> {
        if !self.config.is_enabled().await {
            return Err("browser_unavailable: 浏览器工具已关闭。".into());
        }
        params["method"] = json!("agent");
        params["sessionId"] = json!(self.session_id);
        params["kind"] = json!(kind);
        let result = self.service.request(params).await?;
        serde_json::from_value(result)
            .map_err(|error| format!("browser_read_failed: Ego 返回的数据不完整：{error}"))
    }
}

fn slug(error: &str) -> &str {
    error
        .split_once(':')
        .map(|(code, _)| code)
        .unwrap_or("browser_unavailable")
}

#[async_trait]
impl BrowserToolAccess for SessionBrowserTools {
    async fn list_tabs(&self) -> BrowserTabsOutcome {
        self.call("list", json!({}))
            .await
            .unwrap_or_else(|error| BrowserTabsOutcome::unavailable(&error))
    }

    async fn snapshot(&self, tab_id: &str, max_chars: Option<usize>) -> BrowserSnapshotOutcome {
        match self
            .call("snapshot", json!({"tabId": tab_id, "maxChars": max_chars}))
            .await
        {
            Ok(snapshot) => BrowserSnapshotOutcome::page(tab_id, snapshot),
            Err(error) => BrowserSnapshotOutcome::refused(tab_id, slug(&error), error.clone()),
        }
    }

    async fn act(&self, tab_id: &str, request: ActionRequest) -> BrowserActOutcome {
        match self
            .call("act", json!({"tabId": tab_id, "request": request}))
            .await
        {
            Ok(action) => BrowserActOutcome::done(tab_id, action),
            Err(error) => BrowserActOutcome::refused(tab_id, slug(&error), error.clone()),
        }
    }

    async fn console(&self, tab_id: &str, query: ConsoleQuery) -> BrowserConsoleOutcome {
        match self
            .call("console", json!({"tabId": tab_id, "query": query}))
            .await
        {
            Ok(console) => BrowserConsoleOutcome::lines(tab_id, console),
            Err(error) => BrowserConsoleOutcome::refused(tab_id, slug(&error), error.clone()),
        }
    }

    async fn capture(&self, tab_id: &str, request: CaptureRequest) -> BrowserCaptureOutcome {
        let result = async {
            let raw: Value = self
                .call("capture", json!({"tabId": tab_id, "request": request}))
                .await?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(raw["data"].as_str().ok_or("Ego 未返回截图。")?)
                .map_err(|error| error.to_string())?;
            let width = raw["cssWidth"].as_f64().ok_or("Ego 未返回页面尺寸。")?;
            let clip: Option<CaptureRegion> =
                serde_json::from_value(raw["clip"].clone()).map_err(|error| error.to_string())?;
            let fitted = capture::fit(
                &data,
                width,
                clip,
                capture::effective_max_width(request.max_width),
                request.format,
            )?;
            let image = image::load_from_memory(&data).map_err(|error| error.to_string())?;
            let region = clip.unwrap_or(CaptureRegion {
                x: 0.0,
                y: 0.0,
                width,
                height: f64::from(image.height()) * width / f64::from(image.width()),
            });
            Ok::<CaptureOutcome, String>(CaptureOutcome {
                mime: request.format.mime().into(),
                data: base64::engine::general_purpose::STANDARD.encode(fitted.bytes),
                width: fitted.width,
                height: fitted.height,
                url: raw["url"].as_str().unwrap_or("").into(),
                region,
                clipped: clip.is_some(),
            })
        }
        .await;
        match result {
            Ok(capture) => BrowserCaptureOutcome::image(tab_id, capture),
            Err(error) => BrowserCaptureOutcome::refused(tab_id, slug(&error), error.clone()),
        }
    }

    async fn eval(&self, tab_id: &str, request: EvalRequest) -> BrowserEvalOutcome {
        if !self.config.is_eval_enabled().await {
            return BrowserEvalOutcome::refused(
                tab_id,
                ERROR_EVAL_DISABLED,
                "请先启用 browser_eval；每段代码仍需人工确认。",
            );
        }
        if let Err(error) = crate::browser::eval::validate_code(&request.code) {
            return BrowserEvalOutcome::refused(tab_id, "browser_bad_code", error.message());
        }
        match self.call::<Value>("eval", json!({"tabId": tab_id, "code": request.code, "expression": crate::browser::eval::eval_call(&request.code)})).await {
            Ok(result) => {
                let answer = result["answer"].as_str().unwrap_or_default();
                if answer.len() > crate::browser::eval::MAX_EVAL_ANSWER_BYTES {
                    return BrowserEvalOutcome::refused(tab_id, ERROR_READ_FAILED, "页面代码返回内容过大。");
                }
                match serde_json::from_str::<crate::browser::eval::EvalAnswer>(answer) {
                    Ok(answer) => BrowserEvalOutcome::ran(tab_id, crate::browser::eval::EvalOutcome::from_answer(&answer, result["url"].as_str().unwrap_or_default().into())),
                    Err(_) => BrowserEvalOutcome::refused(tab_id, ERROR_READ_FAILED, "页面代码未返回有效结果。"),
                }
            }
            Err(error) => BrowserEvalOutcome::refused(tab_id, slug(&error), error.clone()),
        }
    }

    async fn tab_op(&self, op: BrowserTabOp) -> BrowserTabOutcome {
        let (kind, params) = match &op {
            BrowserTabOp::Open { url } => ("open", json!({"url": url})),
            BrowserTabOp::Navigate { tab_id, url } => {
                ("navigate", json!({"tabId": tab_id, "url": url}))
            }
            BrowserTabOp::Close { tab_id } => ("close", json!({"tabId": tab_id})),
        };
        match self.call::<Value>(kind, params).await {
            Ok(_) if kind == "close" => BrowserTabOutcome::closed(op.tab_id().unwrap_or_default()),
            Ok(value) => match serde_json::from_value(value["tab"].clone()) {
                Ok(tab) => BrowserTabOutcome::tab(tab, None),
                Err(error) => {
                    BrowserTabOutcome::refused(op.tab_id(), ERROR_READ_FAILED, error.to_string())
                }
            },
            Err(error) => BrowserTabOutcome::refused(op.tab_id(), slug(&error), error.clone()),
        }
    }
}
