use super::{failed, UndoIssue};
use crate::app_error::AppCommandError;
use crate::models::{ContentBlock, MessageTurn};
use crate::parsers::{deepseek::DeepSeekParser, AgentEnv};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub(super) fn path(env: &AgentEnv, session: &str) -> Result<PathBuf, AppCommandError> {
    DeepSeekParser::for_env(env)
        .undo_log_path(session)
        .ok_or_else(|| AppCommandError::not_found("The native DeepSeek log is unavailable"))
}

pub(super) fn read(path: &Path) -> Result<Vec<u8>, AppCommandError> {
    let bytes = std::fs::read(path).map_err(AppCommandError::io)?;
    if path.extension().and_then(|value| value.to_str()) == Some("zstd") {
        zstd::stream::decode_all(bytes.as_slice()).map_err(AppCommandError::io)
    } else {
        Ok(bytes)
    }
}

pub(super) fn publish(
    path: &Path,
    expected: &[u8],
    replacement: &[u8],
) -> Result<(), AppCommandError> {
    let directory = path
        .parent()
        .ok_or_else(|| failed("DeepSeek log directory is missing"))?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("session.lock"))
        .map_err(AppCommandError::io)?;
    lock.try_lock()
        .map_err(|error| failed(format!("DeepSeek still has an active writer: {error}")))?;
    if read(path)? != expected {
        return Err(super::history::conflict());
    }
    let encoded = if path.extension().and_then(|value| value.to_str()) == Some("zstd") {
        // 原生读取器单独解压首帧做头部检查；合成一帧会被判为损坏日志。
        let header_end = replacement
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|position| position + 1)
            .ok_or_else(|| failed("DeepSeek session header is incomplete"))?;
        let mut frames =
            zstd::stream::encode_all(&replacement[..header_end], 3).map_err(AppCommandError::io)?;
        if header_end < replacement.len() {
            frames.extend(
                zstd::stream::encode_all(&replacement[header_end..], 3)
                    .map_err(AppCommandError::io)?,
            );
        }
        frames
    } else {
        replacement.to_vec()
    };
    super::history::atomic_write(path, &encoded)
}

pub(super) fn replacement(
    env: &AgentEnv,
    session: &str,
    prompt: &MessageTurn,
) -> Result<(PathBuf, Vec<u8>, Vec<u8>), AppCommandError> {
    let path = path(env, session)?;
    let original = read(&path)?;
    let text = prompt
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let raw = std::str::from_utf8(&original).map_err(|error| failed(error.to_string()))?;
    let mut offset = 0;
    let mut turn_start = None;
    let mut turn_has_user = false;
    let mut candidates = Vec::new();
    for line in raw.split_inclusive('\n') {
        let value: Value = serde_json::from_str(line).map_err(|error| failed(error.to_string()))?;
        if value["type"] == "session" && value["id"] != session {
            return Err(super::history::conflict());
        }
        if value["type"] == "turn/start" {
            turn_start = Some(offset);
            turn_has_user = false;
        }
        if value["type"] == "turn/end" {
            turn_start = None;
            turn_has_user = false;
        }
        if value["type"] == "user/message" && value["data"]["source"]["kind"] == "user" {
            let content = &value["data"]["content"];
            let saved = content
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if saved == text && value["time"].as_i64() == Some(prompt.timestamp.timestamp_millis())
            {
                if content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|part| part["type"] != "text")
                {
                    return Err(AppCommandError::invalid_input(
                        "The original DeepSeek attachment needs a verified content snapshot",
                    ));
                }
                // 轮首移除对应 turn/start；中途追加指令只截到自身，不能扩大到前一条输入。
                candidates.push(if turn_has_user {
                    offset
                } else {
                    turn_start.unwrap_or(offset)
                });
            }
            turn_has_user = true;
        }
        offset += line.len();
    }
    let [offset] = candidates.as_slice() else {
        return Err(AppCommandError::invalid_input(
            "The saved DeepSeek user message could not be uniquely located",
        ));
    };
    let replacement = original[..*offset].to_vec();
    Ok((path, original, replacement))
}

pub(super) fn issues(
    env: &AgentEnv,
    session: &str,
    prompt: &MessageTurn,
) -> Result<Vec<UndoIssue>, AppCommandError> {
    Ok(match replacement(env, session, prompt) {
        Ok(_) => Vec::new(),
        Err(error) => vec![UndoIssue {
            code: "boundary_unavailable".into(),
            label: error.message,
        }],
    })
}
