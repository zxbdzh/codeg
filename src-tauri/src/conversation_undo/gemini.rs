use std::path::PathBuf;

use serde_json::{json, Value};

use crate::app_error::AppCommandError;
use crate::models::{ContentBlock, MessageTurn};
use crate::parsers::{gemini::GeminiParser, AgentEnv};

use super::{failed, UndoIssue};

pub(super) fn path(env: &AgentEnv, session_id: &str) -> Result<PathBuf, AppCommandError> {
    document(env, session_id).map(|(path, _, _)| path)
}

fn document(env: &AgentEnv, session_id: &str) -> Result<(PathBuf, String, Value), AppCommandError> {
    GeminiParser::for_env(env)
        .undo_document(session_id)
        .map_err(|error| failed(error.to_string()))
}

fn selected<'a>(value: &'a Value, prompt: &MessageTurn) -> Result<&'a Value, AppCommandError> {
    let text = prompt
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let candidates = value["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| {
            let same_time = message["timestamp"]
                .as_str()
                .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
                .is_some_and(|time| time == prompt.timestamp);
            let saved_text = if let Some(text) = message["content"].as_str() {
                text.to_owned()
            } else {
                message["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            message["type"] == "user" && same_time && saved_text == text
        })
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [message] => Ok(message),
        _ => Err(AppCommandError::invalid_input(
            "The exact saved Gemini user message could not be uniquely located",
        )),
    }
}

pub(super) fn issues(
    env: &AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<Vec<UndoIssue>, AppCommandError> {
    use base64::Engine;
    let (path, _, value) = document(env, session_id)?;
    if path.extension().and_then(|extension| extension.to_str()) != Some("jsonl") {
        return Ok(vec![UndoIssue {
            code: "unsupported_native_history".into(),
            label: "This Gemini history format needs native restore verification".into(),
        }]);
    }
    let message = selected(&value, prompt)?;
    let mut issues = Vec::new();
    for (index, part) in message["content"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        if part["text"].is_string() {
            continue;
        }
        let inline = part.get("inlineData").or_else(|| part.get("inline_data"));
        let recoverable = inline.is_some_and(|inline| {
            let mime = inline["mimeType"]
                .as_str()
                .or_else(|| inline["mime_type"].as_str())
                .unwrap_or_default();
            let data = inline["data"].as_str().unwrap_or_default();
            !mime.is_empty()
                && !data.is_empty()
                && base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .is_ok()
        });
        if !recoverable {
            issues.push(UndoIssue {
                code: "missing_original_attachment".into(),
                label: format!("Gemini attachment #{}", index + 1),
            });
        }
    }
    Ok(issues)
}

pub(super) fn input(
    env: &AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<Vec<crate::acp::types::PromptInputBlock>, AppCommandError> {
    use crate::acp::types::PromptInputBlock;
    let (_, _, value) = document(env, session_id)?;
    let message = selected(&value, prompt)?;
    if let Some(text) = message["content"].as_str() {
        return Ok(vec![PromptInputBlock::Text {
            text: text.to_owned(),
        }]);
    }
    let mut blocks = Vec::new();
    for part in message["content"].as_array().into_iter().flatten() {
        if let Some(text) = part["text"].as_str() {
            blocks.push(PromptInputBlock::Text {
                text: text.to_owned(),
            });
            continue;
        }
        let inline = part
            .get("inlineData")
            .or_else(|| part.get("inline_data"))
            .ok_or_else(|| {
                AppCommandError::invalid_input("The original Gemini attachment is unavailable")
            })?;
        let mime = inline["mimeType"]
            .as_str()
            .or_else(|| inline["mime_type"].as_str())
            .unwrap_or_default()
            .to_owned();
        let data = inline["data"].as_str().unwrap_or_default().to_owned();
        if mime.starts_with("image/") {
            blocks.push(PromptInputBlock::Image {
                data,
                mime_type: mime,
                uri: None,
            });
        } else {
            // 直接恢复原生 inlineData 的原始字节；解析器显示文本不是附件原文的替代品。
            blocks.push(PromptInputBlock::Resource {
                uri: format!(
                    "attachment://{}",
                    inline["displayName"].as_str().unwrap_or("attachment.bin")
                ),
                mime_type: Some(mime),
                blob: Some(data),
                text: None,
            });
        }
    }
    Ok(blocks)
}

pub(super) fn replacement(
    env: &AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<(PathBuf, Vec<u8>, Vec<u8>), AppCommandError> {
    let (path, raw, value) = document(env, session_id)?;
    let message = selected(&value, prompt)?;
    let message_id = message["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            AppCommandError::invalid_input("The native Gemini message has no identity")
        })?;
    if !issues(env, session_id, prompt)?.is_empty() {
        return Err(AppCommandError::invalid_input(
            "The original Gemini input cannot be fully restored",
        ));
    }
    // 使用 Gemini 自己的 rewind 记录，保留原会话身份及原生元数据。
    let replacement = format!("{}\n{}\n", raw.trim_end(), json!({"$rewindTo": message_id}));
    Ok((path, raw.into_bytes(), replacement.into_bytes()))
}
