use std::io::{BufRead, BufReader};
use std::path::PathBuf;

use super::{failed, UndoIssue};
use crate::app_error::AppCommandError;
use crate::models::{ContentBlock, MessageTurn};
use crate::parsers::{pi::resolve_pi_sessions_dir_for_env, AgentEnv};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

pub(super) fn path(env: &AgentEnv, session_id: &str) -> Result<PathBuf, AppCommandError> {
    let root = resolve_pi_sessions_dir_for_env(env);
    let mut candidates = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .max_depth(3)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !entry.file_type().is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        let file = std::fs::File::open(path).map_err(AppCommandError::io)?;
        let header = BufReader::new(file)
            .lines()
            .take(32)
            .filter_map(Result::ok)
            .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
            .find(|record| record["type"] == "session");
        let named = path
            .file_stem()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name == session_id || name.ends_with(&format!("_{session_id}")));
        if header
            .as_ref()
            .is_some_and(|header| header["id"] == session_id)
            || named
        {
            candidates.push(path.to_owned());
        }
    }
    match candidates.as_slice() {
        [path] => Ok(path.clone()),
        _ => Err(AppCommandError::invalid_input(
            "The native Pi session file could not be uniquely located",
        )),
    }
}

struct Selection {
    offset: usize,
    record: Value,
    needs_cursor: bool,
}

fn select(original: &[u8], prompt: &MessageTurn) -> Result<Selection, AppCommandError> {
    let original = std::str::from_utf8(original).map_err(|error| failed(error.to_string()))?;
    let text = prompt
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut offset = 0;
    let mut last_id = None;
    let mut candidates = Vec::new();
    let mut parents = std::collections::BTreeMap::<String, Option<String>>::new();
    for line in original.split_inclusive('\n') {
        if line.trim().is_empty() {
            offset += line.len();
            continue;
        }
        let value: Value = serde_json::from_str(line).map_err(|error| failed(error.to_string()))?;
        if value["type"] == "session" {
            offset += line.len();
            continue;
        }
        let id = value["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                AppCommandError::invalid_input("The Pi tree contains an entry without an identity")
            })?
            .to_owned();
        let parent =
            match value.get("parentId") {
                Some(Value::Null) => None,
                Some(Value::String(parent)) if parents.contains_key(parent) => Some(parent.clone()),
                _ => return Err(AppCommandError::invalid_input(
                    "The Pi parent chain is incomplete or points forward; history has been kept",
                )),
            };
        if parents.contains_key(&id) {
            return Err(AppCommandError::invalid_input(
                "The Pi tree contains duplicate entry identities",
            ));
        }
        let message = &value["message"];
        let saved_text = message["content"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                message["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            });
        let same_time = value["timestamp"]
            .as_str()
            .and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
            .is_some_and(|time| time == prompt.timestamp);
        if value["type"] == "message"
            && message["role"] == "user"
            && same_time
            && saved_text == text
        {
            if message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|part| !matches!(part["type"].as_str(), Some("text" | "image")))
            {
                return Err(AppCommandError::invalid_input(
                    "The original Pi input contains unavailable attachments",
                ));
            }
            for (index, part) in message["content"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                if part["type"] != "image" {
                    continue;
                }
                let data = part["data"].as_str().unwrap_or_default();
                // 解析器会省略缺少字节的图片；撤回校验必须检查原生记录，避免把残缺输入当作完整原文。
                if data.is_empty() || STANDARD.decode(data).is_err() {
                    return Err(AppCommandError::invalid_input(format!(
                        "Pi image #{} has no usable original bytes; restore it before Undo",
                        index + 1
                    )));
                }
            }
            candidates.push(Selection {
                offset,
                record: value.clone(),
                needs_cursor: parent != last_id,
            });
        }
        parents.insert(id.clone(), parent);
        last_id = Some(id);
        offset += line.len();
    }
    let [selection] = candidates.as_slice() else {
        return Err(AppCommandError::invalid_input(
            "The saved Pi user message could not be uniquely located",
        ));
    };
    let selected_id = selection.record["id"].as_str().unwrap();
    let mut cursor = last_id.as_deref();
    let mut on_active_path = false;
    while let Some(id) = cursor {
        on_active_path |= id == selected_id;
        cursor = parents.get(id).and_then(Option::as_deref);
    }
    if !on_active_path {
        return Err(AppCommandError::invalid_input(
            "The selected Pi message is not on the active native parent chain",
        ));
    }
    Ok(candidates.remove(0))
}

fn prefix(original: &[u8], prompt: &MessageTurn) -> Result<Vec<u8>, AppCommandError> {
    let selected = select(original, prompt)?;
    let mut kept = original[..selected.offset].to_vec();
    if selected.needs_cursor {
        // 原生 custom 节点不进入模型上下文，只把同一会话的活动叶指回目标父节点，避免复活旁支。
        let cursor = serde_json::json!({
            "type": "custom",
            "id": uuid::Uuid::new_v4().simple().to_string(),
            "parentId": selected.record["parentId"],
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "customType": "codeg.undo.cursor",
            "data": {"version": 1},
        });
        if !kept.ends_with(b"\n") {
            kept.push(b'\n');
        }
        kept.extend_from_slice(format!("{cursor}\n").as_bytes());
    }
    Ok(kept)
}

pub(super) fn issues(
    env: &AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<Vec<UndoIssue>, AppCommandError> {
    match replacement(env, session_id, prompt) {
        Ok(_) => Ok(Vec::new()),
        Err(error) => Ok(vec![UndoIssue {
            code: "boundary_unavailable".into(),
            label: error.message,
        }]),
    }
}

pub(super) fn replacement(
    env: &AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<(PathBuf, Vec<u8>, Vec<u8>), AppCommandError> {
    let path = path(env, session_id)?;
    let original = std::fs::read(&path).map_err(AppCommandError::io)?;
    let replacement = prefix(&original, prompt)?;
    Ok((path, original, replacement))
}

pub(super) fn input(
    env: &AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<Vec<crate::acp::types::PromptInputBlock>, AppCommandError> {
    use crate::acp::types::PromptInputBlock;
    let original = std::fs::read(path(env, session_id)?).map_err(AppCommandError::io)?;
    let record = select(&original, prompt)?.record;
    let content = &record["message"]["content"];
    if let Some(text) = content.as_str() {
        return Ok(vec![PromptInputBlock::Text {
            text: text.to_owned(),
        }]);
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .map(|block| match block["type"].as_str() {
            Some("text") => Ok(PromptInputBlock::Text {
                text: block["text"].as_str().unwrap_or_default().to_owned(),
            }),
            Some("image") => Ok(PromptInputBlock::Image {
                data: block["data"].as_str().unwrap_or_default().to_owned(),
                mime_type: block["mimeType"].as_str().unwrap_or("image/png").to_owned(),
                uri: None,
            }),
            _ => Err(AppCommandError::invalid_input(
                "The original Pi input contains an unverified content block",
            )),
        })
        .collect()
}
