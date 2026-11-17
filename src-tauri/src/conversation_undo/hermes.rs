use super::{failed, UndoIssue};
use crate::acp::types::PromptInputBlock;
use crate::app_error::AppCommandError;
use crate::models::MessageTurn;
use crate::parsers::AgentEnv;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn sql_error(error: rusqlite::Error) -> AppCommandError {
    failed(error.to_string())
}

pub(super) fn path(env: &AgentEnv) -> PathBuf {
    crate::parsers::hermes::resolve_hermes_home_dir_for_env(env).join("state.db")
}

fn snapshot(connection: &Connection, session_id: &str) -> Result<Value, AppCommandError> {
    use base64::Engine;
    let mut statement = connection
        .prepare("SELECT * FROM messages WHERE session_id = ?1 ORDER BY id")
        .map_err(sql_error)?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let mut rows = statement.query([session_id]).map_err(sql_error)?;
    let mut values = Vec::new();
    while let Some(row) = rows.next().map_err(sql_error)? {
        let mut value = Vec::new();
        for index in 0..columns.len() {
            use rusqlite::types::ValueRef;
            value.push(match row.get_ref(index).map_err(sql_error)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => json!(value),
                ValueRef::Real(value) => json!(value),
                ValueRef::Text(value) => json!(String::from_utf8_lossy(value)),
                ValueRef::Blob(value) => {
                    json!({"blob":base64::engine::general_purpose::STANDARD.encode(value)})
                }
            });
        }
        values.push(value);
    }
    Ok(json!({"columns":columns,"rows":values}))
}

pub(super) fn read(path: &Path, session_id: &str) -> Result<Vec<u8>, AppCommandError> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sql_error)?;
    serde_json::to_vec(&snapshot(&connection, session_id)?)
        .map_err(|error| failed(error.to_string()))
}

pub(super) fn publish(
    path: &Path,
    session_id: &str,
    expected: &[u8],
    replacement: &[u8],
) -> Result<(), AppCommandError> {
    let mut connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(sql_error)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(sql_error)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    let current = serde_json::to_vec(&snapshot(&transaction, session_id)?)
        .map_err(|error| failed(error.to_string()))?;
    if current != expected {
        return Err(super::history::conflict());
    }
    let replacement: Value =
        serde_json::from_slice(replacement).map_err(|error| failed(error.to_string()))?;
    let columns = replacement["columns"]
        .as_array()
        .ok_or_else(|| failed("Invalid Hermes backup"))?;
    let id = columns
        .iter()
        .position(|column| column == "id")
        .ok_or_else(|| failed("Hermes message identity missing"))?;
    let active = columns
        .iter()
        .position(|column| column == "active")
        .ok_or_else(|| failed("Hermes active flag missing"))?;
    for row in replacement["rows"]
        .as_array()
        .ok_or_else(|| failed("Invalid Hermes backup rows"))?
    {
        transaction
            .execute(
                "UPDATE messages SET active = ?1 WHERE session_id = ?2 AND id = ?3",
                rusqlite::params![row[active].as_i64(), session_id, row[id].as_i64()],
            )
            .map_err(sql_error)?;
    }
    // 只切换当前会话消息的有效位，其他会话、原始消息、FTS 与稳定行 ID 全部保留。
    transaction.commit().map_err(sql_error)
}

pub(super) fn replacement(
    env: &AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<(PathBuf, Vec<u8>, Vec<u8>), AppCommandError> {
    let path = path(env);
    let original = read(&path, session_id)?;
    let mut value: Value =
        serde_json::from_slice(&original).map_err(|error| failed(error.to_string()))?;
    let start = selected_index(&value, prompt)?;
    original_input(&value, start)?;
    let active = column(&value, "active")?;
    let rows = value["rows"].as_array_mut().unwrap();
    for row in &mut rows[start..] {
        if row[active] == 1 {
            row[active] = json!(0);
        }
    }
    let replacement = serde_json::to_vec(&value).map_err(|error| failed(error.to_string()))?;
    Ok((path, original, replacement))
}

fn column(value: &Value, name: &str) -> Result<usize, AppCommandError> {
    optional_column(value, name)
        .ok_or_else(|| failed(format!("Hermes column {name} is unavailable")))
}

fn optional_column(value: &Value, name: &str) -> Option<usize> {
    value["columns"]
        .as_array()?
        .iter()
        .position(|column| column == name)
}

fn selected_index(value: &Value, prompt: &MessageTurn) -> Result<usize, AppCommandError> {
    let role = column(value, "role")?;
    let content = column(value, "content")?;
    let timestamp = column(value, "timestamp")?;
    let active = column(value, "active")?;
    let projection =
        serde_json::to_value(&prompt.blocks).map_err(|error| failed(error.to_string()))?;
    let candidates = value["rows"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let blocks = crate::parsers::hermes::decode_hermes_content(row[content].as_str());
            let same = serde_json::to_value(blocks).ok()? == projection;
            (row[role] == "user"
                && row[active] == 1
                && same
                && row[timestamp].as_f64().is_some_and(|seconds| {
                    (seconds - prompt.timestamp.timestamp_millis() as f64 / 1000.0).abs() < 0.001
                }))
            .then_some(index)
        })
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [index] => Ok(*index),
        _ => Err(AppCommandError::invalid_input(
            "The original Hermes input cannot be uniquely located",
        )),
    }
}

fn original_input(value: &Value, index: usize) -> Result<Vec<PromptInputBlock>, AppCommandError> {
    let rows = value["rows"].as_array().unwrap();
    let row = &rows[index];
    let active = column(value, "active")?;
    if optional_column(value, "compacted").is_some_and(|column| {
        rows.iter()
            .any(|row| row[active] == 1 && row[column].as_i64().unwrap_or(0) != 0)
    }) {
        return Err(AppCommandError::invalid_input(
            "This active Hermes compaction requires verified native rewind",
        ));
    }
    let summary = optional_column(value, "_compressed_summary")
        .is_some_and(|column| row[column].as_i64().unwrap_or(0) != 0);
    let synthetic = optional_column(value, "display_kind").is_some_and(|column| {
        row[column]
            .as_str()
            .is_some_and(|kind| !kind.is_empty() && kind != "steer")
    });
    if summary || synthetic {
        // 摘要载体与真人指令共用一行，直接关闭 active 会丢失保留上下文，不能冒充普通消息。
        return Err(AppCommandError::invalid_input(
            "This Hermes summary carrier needs exact handoff splitting before Undo",
        ));
    }
    let content = row[column(value, "content")?].as_str().unwrap_or_default();
    let decoded = if let Some(encoded) = content.strip_prefix("\u{0000}json:") {
        serde_json::from_str::<Value>(encoded).map_err(|_| {
            AppCommandError::invalid_input("Original Hermes input encoding is damaged")
        })?
    } else {
        Value::String(content.to_owned())
    };
    if let Some(text) = decoded.as_str() {
        return Ok(vec![PromptInputBlock::Text {
            text: text.to_owned(),
        }]);
    }
    decoded
        .as_array()
        .ok_or_else(|| {
            AppCommandError::invalid_input(
                "The original Hermes input has an unverified content shape",
            )
        })?
        .iter()
        .map(|part| {
            if let Some(text) = part.as_str() {
                return Ok(PromptInputBlock::Text {
                    text: text.to_owned(),
                });
            }
            match part["type"].as_str() {
                Some("text") => Ok(PromptInputBlock::Text {
                    text: part["text"].as_str().unwrap_or_default().to_owned(),
                }),
                Some("image_url") => {
                    let (mime, data) =
                        inline_data(part["image_url"]["url"].as_str().unwrap_or_default())?;
                    if !mime.starts_with("image/") {
                        return Err(AppCommandError::invalid_input(
                            "Original Hermes image MIME is invalid",
                        ));
                    }
                    Ok(PromptInputBlock::Image {
                        data,
                        mime_type: mime,
                        uri: None,
                    })
                }
                Some("file") => {
                    let (mime, data) =
                        inline_data(part["file"]["file_data"].as_str().unwrap_or_default())?;
                    Ok(PromptInputBlock::Resource {
                        uri: format!(
                            "attachment://{}",
                            part["file"]["filename"]
                                .as_str()
                                .unwrap_or("attachment.bin")
                        ),
                        mime_type: Some(mime),
                        text: None,
                        blob: Some(data),
                    })
                }
                _ => Err(AppCommandError::invalid_input(
                    "The original Hermes input contains an unverified resource",
                )),
            }
        })
        .collect()
}

fn inline_data(uri: &str) -> Result<(String, String), AppCommandError> {
    let (mime, data) = uri
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
        .ok_or_else(|| {
            AppCommandError::invalid_input("Original Hermes attachment bytes are missing")
        })?;
    if data.is_empty() || STANDARD.decode(data).is_err() {
        return Err(AppCommandError::invalid_input(
            "Original Hermes attachment bytes are damaged",
        ));
    }
    Ok((mime.to_owned(), data.to_owned()))
}

pub(super) fn input(
    env: &AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<Vec<PromptInputBlock>, AppCommandError> {
    let bytes = read(&path(env), session_id)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| failed(error.to_string()))?;
    original_input(&value, selected_index(&value, prompt)?)
}

pub(super) fn issues(
    env: &AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<Vec<UndoIssue>, AppCommandError> {
    Ok(match replacement(env, session_id, prompt) {
        Ok(_) => Vec::new(),
        Err(error) => vec![UndoIssue {
            code: "boundary_unavailable".into(),
            label: error.message,
        }],
    })
}
