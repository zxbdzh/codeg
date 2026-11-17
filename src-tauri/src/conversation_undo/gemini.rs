use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

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

fn selected_index(value: &Value, prompt: &MessageTurn) -> Result<usize, AppCommandError> {
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
        .enumerate()
        .filter(|(_, message)| {
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
        [(index, _)] => Ok(*index),
        _ => Err(AppCommandError::invalid_input(
            "The exact saved Gemini user message could not be uniquely located",
        )),
    }
}

fn selected<'a>(value: &'a Value, prompt: &MessageTurn) -> Result<&'a Value, AppCommandError> {
    let index = selected_index(value, prompt)?;
    value["messages"]
        .as_array()
        .and_then(|messages| messages.get(index))
        .ok_or_else(|| {
            AppCommandError::invalid_input(
                "The exact saved Gemini user message could not be located",
            )
        })
}

pub(super) fn issues(
    env: &AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<Vec<UndoIssue>, AppCommandError> {
    use base64::Engine;
    let (path, _, value) = document(env, session_id)?;
    if !matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("json" | "jsonl")
    ) {
        return Ok(vec![UndoIssue {
            code: "unsupported_native_history".into(),
            label: "This Gemini history format needs native restore verification".into(),
        }]);
    }
    if path.extension().and_then(|extension| extension.to_str()) == Some("json")
        && !value["memoryScratchpad"].is_null()
    {
        return Ok(vec![UndoIssue {
            code: "unsupported_native_context".into(),
            label: "This legacy Gemini memory scratchpad needs exact rewind verification".into(),
        }]);
    }
    let message_index = selected_index(&value, prompt)?;
    let message = &value["messages"][message_index];
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
    let message_index = selected_index(&value, prompt)?;
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
    let replacement = match path.extension().and_then(|extension| extension.to_str()) {
        Some("jsonl") => {
            // JSONL 用 Gemini 自己的 rewind 记录，避免改写其追加式日志。
            format!("{}\n{}\n", raw.trim_end(), json!({"$rewindTo": message_id})).into_bytes()
        }
        Some("json") => {
            let mut truncated = value;
            let messages = truncated["messages"].as_array_mut().ok_or_else(|| {
                AppCommandError::invalid_input("The legacy Gemini history has no message array")
            })?;
            // 旧版读取器以单个 JSON 对象恢复会话，截断原数组才能保持其可读性与会话 ID。
            messages.truncate(message_index);
            serde_json::to_vec(&truncated).map_err(|error| failed(error.to_string()))?
        }
        _ => {
            return Err(AppCommandError::invalid_input(
                "This Gemini history format has no verified native rewind",
            ))
        }
    };
    Ok((path, raw.into_bytes(), replacement))
}

pub(super) fn is_legacy_migration(path: &Path, backup: &Value) -> bool {
    backup["path"]
        .as_str()
        .map(Path::new)
        .is_some_and(|original| {
            original.extension().and_then(|value| value.to_str()) == Some("json")
                && original.with_extension("jsonl") == path
        })
}

pub(super) fn history_digest(bytes: &[u8]) -> String {
    let first = bytes
        .split(|byte| *byte == b'\n')
        .find(|line| !line.iter().all(u8::is_ascii_whitespace))
        .and_then(|line| serde_json::from_slice::<Value>(line).ok());
    let session_id = first.as_ref().and_then(|record| {
        record["sessionId"]
            .as_str()
            .or_else(|| record["$set"]["sessionId"].as_str())
    });
    let mut hasher = Sha256::new();
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        let redundant_identity = session_id.is_some_and(|session_id| {
            serde_json::from_slice::<Value>(line)
                .is_ok_and(|record| record == json!({"$set": {"sessionId": session_id}}))
        });
        // 原生重连只重申相同身份，不改变对话；其余元数据、消息与附件仍逐字参与冲突校验。
        if !redundant_identity {
            hasher.update(line);
        }
    }
    format!("{:x}", hasher.finalize())
}

pub(super) fn migrated_reverted_matches(current: &[u8], backup: &Value) -> bool {
    let expected = &backup["geminiLegacyReverted"];
    let Some(messages) = expected["messages"].as_array() else {
        return false;
    };
    let Ok(bytes) = serde_json::to_vec(expected) else {
        return false;
    };
    if backup["revertedDigest"] != super::history::digest(&bytes) {
        return false;
    }
    let Some(session_id) = expected["sessionId"].as_str() else {
        return false;
    };
    if backup["sessionId"] != session_id {
        return false;
    }
    let Ok(raw) = std::str::from_utf8(current) else {
        return false;
    };
    let Ok(records) = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str::<Value>)
        .collect::<Result<Vec<_>, _>>()
    else {
        return false;
    };
    let metadata: serde_json::Map<String, Value> = [
        "sessionId",
        "projectHash",
        "startTime",
        "lastUpdated",
        "kind",
        "directories",
        "summary",
    ]
    .into_iter()
    .filter_map(|key| expected.get(key).map(|value| (key.into(), value.clone())))
    .collect();
    // 只放行原生初始化写出的完整迁移序列，不把新增消息、patch 或未知字段当作重连噪声。
    records.len() >= messages.len() + 2
        && records[0] == Value::Object(metadata)
        && records[1..messages.len() + 1] == messages[..]
        && records[messages.len() + 1..]
            .iter()
            .all(|record| record == &json!({"$set": {"sessionId": session_id}}))
}

pub(super) fn migrated_restore(original: &[u8]) -> Result<Vec<u8>, AppCommandError> {
    let value: Value =
        serde_json::from_slice(original).map_err(|error| failed(error.to_string()))?;
    Ok(format!("{}\n", json!({"$set": value})).into_bytes())
}
