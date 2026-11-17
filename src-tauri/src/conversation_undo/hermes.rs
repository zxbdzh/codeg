use super::{failed, UndoIssue};
use crate::app_error::AppCommandError;
use crate::models::{ContentBlock, MessageTurn};
use crate::parsers::AgentEnv;
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
    let columns = value["columns"].as_array().unwrap();
    let column = |name: &str| {
        columns
            .iter()
            .position(|value| value == name)
            .ok_or_else(|| failed(format!("Hermes column {name} is unavailable")))
    };
    let role = column("role")?;
    let content = column("content")?;
    let timestamp = column("timestamp")?;
    let active = column("active")?;
    let compacted = columns.iter().position(|value| value == "compacted");
    let text = prompt
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let rows = value["rows"].as_array_mut().unwrap();
    let candidates = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| {
            row[role] == "user"
                && row[active] == 1
                && row[content].as_str() == Some(text.as_str())
                && row[timestamp].as_f64().is_some_and(|seconds| {
                    (seconds - prompt.timestamp.timestamp_millis() as f64 / 1000.0).abs() < 0.001
                })
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let [start] = candidates.as_slice() else {
        return Err(AppCommandError::invalid_input(
            "The original Hermes input cannot be uniquely located",
        ));
    };
    if compacted.is_some_and(|column| {
        rows.iter()
            .any(|row| row[column].as_i64().unwrap_or(0) != 0)
    }) {
        return Err(AppCommandError::invalid_input(
            "This compressed Hermes session requires its native rewind API",
        ));
    }
    for row in &mut rows[*start..] {
        if row[active] == 1 {
            row[active] = json!(0);
        }
    }
    let replacement = serde_json::to_vec(&value).map_err(|error| failed(error.to_string()))?;
    Ok((path, original, replacement))
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
