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

fn prefix(original: &[u8], prompt: &MessageTurn) -> Result<Vec<u8>, AppCommandError> {
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
    for line in original.split_inclusive('\n') {
        let value: Value = serde_json::from_str(line).map_err(|error| failed(error.to_string()))?;
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
                    .join("\n")
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
            // Pi 的最后一条物理记录决定树叶；非线性边界未经验证时不能复活旧分支。
            let parent = value["parentId"].as_str().map(str::to_owned);
            if parent != last_id {
                return Err(AppCommandError::invalid_input(
                    "This Pi tree boundary needs native verification before Undo",
                ));
            }
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
            candidates.push(offset);
        }
        if value["type"] != "session" {
            last_id = value["id"].as_str().map(str::to_owned);
        }
        offset += line.len();
    }
    match candidates.as_slice() {
        [offset] => Ok(original.as_bytes()[..*offset].to_vec()),
        _ => Err(AppCommandError::invalid_input(
            "The saved Pi user message could not be uniquely located",
        )),
    }
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
