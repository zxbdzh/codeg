//! 两种 wire protocol 的请求体与响应取值。
//!
//! 全部是纯函数：给定模型名与提示词产出 JSON，给定响应取出文本。真正的 HTTP
//! 调用在 `client` 里，这样这一层的失败与成功都能被测试钉住，不用打网络。

use serde_json::{json, Value};

use crate::acp::provider_models::{KeyHeader, ModelsProtocol};

/// 生成标题用的输出上限。标题最多十几个词，给多了只是让模型更容易胡写。
pub const MAX_TITLE_OUTPUT_TOKENS: u32 = 64;

/// 标签建议的输出上限。JSON 结构 + 每条一句理由，512 绰绰有余。
pub const MAX_SUGGESTION_OUTPUT_TOKENS: u32 = 512;

/// Anthropic 要求带上版本头，缺了直接 400。
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 一次的请求：地址、头、体。
#[derive(Debug, Clone, PartialEq)]
pub struct AiWireRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

/// 拼出完整端点。用户的 `api_url` 可能是 `https://api.openai.com/v1`、
/// `https://api.anthropic.com`，也可能已经把资源路径写全了，三种都要接住。
pub fn endpoint(api_url: &str, protocol: ModelsProtocol) -> String {
    let base = api_url.trim().trim_end_matches('/');
    let (suffix, full_tail, versioned_tail) = match protocol {
        ModelsProtocol::Openai => ("/chat/completions", "/chat/completions", "/v1/chat/completions"),
        ModelsProtocol::Anthropic | ModelsProtocol::Gemini => {
            ("/messages", "/messages", "/v1/messages")
        }
    };
    if base.ends_with(full_tail) {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}{suffix}")
    } else {
        format!("{base}{versioned_tail}")
    }
}

/// 鉴权头。每个协议有自己的惯例，提供方也可以显式要求换一种走法
/// （Anthropic 的某些中转要求把 key 放在 `Authorization: Bearer` 里）。
pub fn auth_headers(
    protocol: ModelsProtocol,
    key_header: Option<KeyHeader>,
    api_key: &str,
) -> Vec<(String, String)> {
    let header = key_header.unwrap_or(match protocol {
        ModelsProtocol::Openai => KeyHeader::Bearer,
        ModelsProtocol::Anthropic | ModelsProtocol::Gemini => KeyHeader::XApiKey,
    });
    match header {
        KeyHeader::Bearer => vec![("authorization".to_string(), format!("Bearer {api_key}"))],
        KeyHeader::XApiKey => vec![
            ("x-api-key".to_string(), api_key.to_string()),
            (
                "anthropic-version".to_string(),
                ANTHROPIC_VERSION.to_string(),
            ),
        ],
        KeyHeader::XGoogApiKey => vec![("x-goog-api-key".to_string(), api_key.to_string())],
    }
}

/// 请求体。除了消息本身只带必要参数：这个功能不需要温度与采样，给默认值
/// 就够，多写一个字段就是多一种被各家实现解释得不一样的可能。
pub fn request_body(
    protocol: ModelsProtocol,
    model: &str,
    prompt: &str,
    max_output_tokens: u32,
) -> Value {
    match protocol {
        ModelsProtocol::Openai => json!({
            "model": model,
            "messages": [{ "role": "user", "content": prompt }],
            "max_tokens": max_output_tokens,
            "temperature": 0,
        }),
        ModelsProtocol::Anthropic | ModelsProtocol::Gemini => json!({
            "model": model,
            "max_tokens": max_output_tokens,
            "messages": [{
                "role": "user",
                "content": [{ "type": "text", "text": prompt }],
            }],
        }),
    }
}

/// 从响应体里取回模型写的那段话。
pub fn extract_text(protocol: ModelsProtocol, body: &Value) -> Option<String> {
    let text = match protocol {
        ModelsProtocol::Openai => body
            .get("choices")?
            .get(0)?
            .get("message")?
            .get("content")?
            .as_str()?
            .to_string(),
        ModelsProtocol::Anthropic | ModelsProtocol::Gemini => body
            .get("content")?
            .as_array()?
            .iter()
            .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))?
            .get("text")?
            .as_str()?
            .to_string(),
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 从错误文本里抹掉密钥再交给上层。错误会被写进日志、显示在界面上，密钥
/// 不该跟着一起旅行。
pub fn scrub_secret(text: &str, api_key: &str) -> String {
    if api_key.is_empty() {
        return text.to_string();
    }
    text.replace(api_key, "[redacted]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_openai_base_url_grows_the_chat_completions_path() {
        assert_eq!(
            endpoint("https://api.openai.com/v1", ModelsProtocol::Openai),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://api.openai.com/", ModelsProtocol::Openai),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn a_base_url_that_already_names_the_resource_is_left_alone() {
        assert_eq!(
            endpoint(
                "https://relay.example.com/v1/chat/completions",
                ModelsProtocol::Openai
            ),
            "https://relay.example.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://api.anthropic.com/v1/messages", ModelsProtocol::Anthropic),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn an_anthropic_base_url_grows_the_messages_path() {
        assert_eq!(
            endpoint("https://api.anthropic.com", ModelsProtocol::Anthropic),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn each_protocol_sends_the_key_its_own_way() {
        assert_eq!(
            auth_headers(ModelsProtocol::Openai, None, "sk-1"),
            vec![("authorization".to_string(), "Bearer sk-1".to_string())]
        );
        assert_eq!(
            auth_headers(ModelsProtocol::Anthropic, None, "sk-2"),
            vec![
                ("x-api-key".to_string(), "sk-2".to_string()),
                ("anthropic-version".to_string(), "2023-06-01".to_string()),
            ]
        );
    }

    #[test]
    fn a_provider_can_override_the_key_header() {
        assert_eq!(
            auth_headers(ModelsProtocol::Anthropic, Some(KeyHeader::Bearer), "sk-3"),
            vec![("authorization".to_string(), "Bearer sk-3".to_string())]
        );
    }

    #[test]
    fn the_openai_body_is_a_single_user_message() {
        let body = request_body(ModelsProtocol::Openai, "gpt-4o-mini", "打个标签", 64);

        assert_eq!(body["model"], "gpt-4o-mini");
        assert_eq!(body["max_tokens"], 64);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "打个标签");
    }

    #[test]
    fn the_anthropic_body_wraps_the_prompt_in_a_text_block() {
        let body = request_body(ModelsProtocol::Anthropic, "claude-haiku", "起个标题", 64);

        assert_eq!(body["model"], "claude-haiku");
        assert_eq!(body["max_tokens"], 64);
        assert_eq!(body["messages"][0]["content"][0]["type"], "text");
        assert_eq!(body["messages"][0]["content"][0]["text"], "起个标题");
    }

    #[test]
    fn the_reply_text_comes_out_of_either_shape() {
        let openai = json!({
            "choices": [{ "message": { "role": "assistant", "content": "  修复标签刷新  " } }]
        });
        let anthropic = json!({
            "content": [
                { "type": "text", "text": "先这句" },
                { "type": "text", "text": "后这句" }
            ]
        });

        assert_eq!(
            extract_text(ModelsProtocol::Openai, &openai),
            Some("修复标签刷新".to_string())
        );
        assert_eq!(
            extract_text(ModelsProtocol::Anthropic, &anthropic),
            Some("先这句".to_string())
        );
    }

    #[test]
    fn an_empty_or_unknown_reply_is_no_text() {
        assert_eq!(extract_text(ModelsProtocol::Openai, &json!({})), None);
        assert_eq!(
            extract_text(
                ModelsProtocol::Openai,
                &json!({ "choices": [{ "message": { "content": "   " } }] })
            ),
            None
        );
        assert_eq!(
            extract_text(ModelsProtocol::Anthropic, &json!({ "content": [] })),
            None
        );
    }

    #[test]
    fn a_key_never_survives_into_an_error_message() {
        assert_eq!(
            scrub_secret("401 Unauthorized for key sk-abcd1234", "sk-abcd1234"),
            "401 Unauthorized for key [redacted]"
        );
        assert_eq!(scrub_secret("boom", ""), "boom");
    }
}
