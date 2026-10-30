//! 真正发请求的那一层，以及一个可注入的 seam。
//!
//! `AiClient` trait 是本特性**唯一**新增的跨层 seam：生产环境用 [`HttpAiClient`]，
//! 测试用假实现返回预置回答或错误。上面所有会"花钱"的判断（节流、缓存、失败
//! 降级）都应该通过这个 trait 拿到结果，这样它们的测试不用打网络。

use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;

use crate::acp::provider_models::ModelsProtocol;
use crate::ai::wire;

/// 连接超时。与既有的提供方模型清单请求保持一致。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 总超时。比模型清单请求宽一些——生成比列清单慢，但 30 秒还没有第一个字
/// 就说明这条链路有问题，不该让界面一直转圈。
const TOTAL_TIMEOUT: Duration = Duration::from_secs(30);

/// 一次生成失败的原因。分类是为了让前端能给出不同的下一步提示。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiError {
    /// 401 / 403：密钥不对或没有权限。
    Unauthorized,
    /// 404：地址或模型名不对。
    NotFound,
    /// 超时或连不上。
    Transport(String),
    /// 回来了，但不是我们约定的形状。
    MalformedReply(String),
}

impl AiError {
    /// 前端显示这句话；错误码与设置页的提示共用一套文案。
    pub fn i18n_key(&self) -> &'static str {
        match self {
            AiError::Unauthorized => "aiAssistant.errorUnauthorized",
            AiError::NotFound => "aiAssistant.errorNotFound",
            AiError::Transport(_) => "aiAssistant.errorTransport",
            AiError::MalformedReply(_) => "aiAssistant.errorMalformed",
        }
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiError::Unauthorized => f.write_str("the provider rejected the api key"),
            AiError::NotFound => f.write_str("the provider or model was not found"),
            AiError::Transport(message) => write!(f, "the request failed: {message}"),
            AiError::MalformedReply(message) => write!(f, "unusable reply: {message}"),
        }
    }
}

impl std::error::Error for AiError {}

/// 一次请求的全部输入。
#[derive(Clone)]
pub struct CompletionRequest {
    pub protocol: ModelsProtocol,
    pub url: String,
    /// 已经包含密钥的头。**不要**给这个结构体派生 `Debug`：那会把密钥打进日志。
    pub headers: Vec<(String, String)>,
    pub body: Value,
    /// 密钥明文，仅用于把错误文本里的它抹掉。
    pub api_key: String,
}

impl std::fmt::Debug for CompletionRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompletionRequest")
            .field("protocol", &self.protocol)
            .field("url", &self.url)
            .field("header_names", &self.headers.iter().map(|(k, _)| k).collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

/// 让模型说一句话。
#[async_trait]
pub trait AiClient: Send + Sync {
    async fn complete(&self, request: CompletionRequest) -> Result<String, AiError>;
}

/// 走 HTTP 的生产实现。
pub struct HttpAiClient {
    client: reqwest::Client,
}

impl HttpAiClient {
    pub fn new() -> Result<Self, AiError> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            // 不跟随重定向：跟着跳一次就可能把 Authorization 头带去别的域名。
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| AiError::Transport(e.to_string()))?;
        Ok(Self { client })
    }
}

#[async_trait]
impl AiClient for HttpAiClient {
    async fn complete(&self, request: CompletionRequest) -> Result<String, AiError> {
        let mut builder = self.client.post(&request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }

        let response = builder
            .json(&request.body)
            .send()
            .await
            .map_err(|e| AiError::Transport(wire::scrub_secret(&e.to_string(), &request.api_key)))?;

        let status = response.status();
        let body_text = response.text().await.map_err(|e| {
            AiError::Transport(wire::scrub_secret(&e.to_string(), &request.api_key))
        })?;

        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(AiError::Unauthorized);
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(AiError::NotFound);
        }
        if !status.is_success() {
            return Err(AiError::Transport(format!(
                "{} {}",
                status.as_u16(),
                wire::scrub_secret(body_text.trim(), &request.api_key)
            )));
        }

        let parsed: Value = serde_json::from_str(&body_text).map_err(|_| {
            AiError::MalformedReply(wire::scrub_secret(body_text.trim(), &request.api_key))
        })?;
        wire::extract_text(request.protocol, &parsed).ok_or_else(|| {
            AiError::MalformedReply(wire::scrub_secret(body_text.trim(), &request.api_key))
        })
    }
}
