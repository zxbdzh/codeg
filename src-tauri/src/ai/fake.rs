//! 测试用的假 AI 客户端。
//!
//! 它存在的理由就是那条 seam：所有"会花钱"的判断（缓存、节流、失败降级）都
//! 通过 [`AiClient`] 拿结果，于是它们可以在此处被确定地驱动，不用打网络、不用
//! 真密钥。

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;

use crate::ai::client::{AiClient, AiError, CompletionRequest};

/// 按脚本依次回答的假客户端。脚本用完之后一律失败——一个"没写好的期望"不
/// 该被静默当成成功。
pub struct FakeAiClient {
    replies: Mutex<VecDeque<Result<String, AiError>>>,
    requests: Mutex<Vec<CompletionRequest>>,
}

impl FakeAiClient {
    pub fn with_replies(replies: Vec<Result<String, AiError>>) -> Self {
        Self {
            replies: Mutex::new(replies.into()),
            requests: Mutex::new(Vec::new()),
        }
    }

    /// 一次回答，之后不再有脚本。
    pub fn replying(text: &str) -> Self {
        Self::with_replies(vec![Ok(text.to_string())])
    }

    /// 一次失败。
    pub fn failing(error: AiError) -> Self {
        Self::with_replies(vec![Err(error)])
    }

    pub fn request_count(&self) -> usize {
        self.requests.lock().expect("requests lock").len()
    }

    /// 每次调用送出去的那段提示词，按调用顺序。
    pub fn prompts(&self) -> Vec<String> {
        self.requests
            .lock()
            .expect("requests lock")
            .iter()
            .map(|request| prompt_of(&request.body))
            .collect()
    }

    /// 每次调用用的地址，按调用顺序。
    pub fn urls(&self) -> Vec<String> {
        self.requests
            .lock()
            .expect("requests lock")
            .iter()
            .map(|request| request.url.clone())
            .collect()
    }

    /// 每次调用带的头名字（不含值，值是密钥）。
    pub fn header_names(&self) -> Vec<Vec<String>> {
        self.requests
            .lock()
            .expect("requests lock")
            .iter()
            .map(|request| {
                request
                    .headers
                    .iter()
                    .map(|(name, _)| name.clone())
                    .collect()
            })
            .collect()
    }
}

#[async_trait]
impl AiClient for FakeAiClient {
    async fn complete(&self, request: CompletionRequest) -> Result<String, AiError> {
        self.requests.lock().expect("requests lock").push(request);
        self.replies
            .lock()
            .expect("replies lock")
            .pop_front()
            .unwrap_or_else(|| Err(AiError::Transport("no scripted reply left".to_string())))
    }
}

/// 从请求体里取出提示词，两种协议的形状都认。
fn prompt_of(body: &Value) -> String {
    if let Some(text) = body["messages"][0]["content"].as_str() {
        return text.to_string();
    }
    body["messages"][0]["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}
