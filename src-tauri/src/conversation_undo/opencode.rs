use super::{failed, UndoIssue};
use crate::app_error::AppCommandError;
use crate::models::{ContentBlock, MessageTurn};
use crate::parsers::AgentEnv;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

pub(super) fn sql_error(error: rusqlite::Error) -> AppCommandError {
    failed(error.to_string())
}

pub(super) fn path(env: &AgentEnv) -> Result<PathBuf, AppCommandError> {
    crate::parsers::opencode::resolve_opencode_db_path_for_env(env)
        .filter(|path| path.is_file())
        .ok_or_else(|| AppCommandError::invalid_input("OpenCode has no saved database"))
}

pub(super) fn rows(
    connection: &Connection,
    query: &str,
    session: &str,
) -> Result<Vec<Value>, AppCommandError> {
    let mut statement = connection.prepare(query).map_err(sql_error)?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    let values = statement
        .query_map([session], |row| {
            let mut value = Map::new();
            for (index, name) in columns.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let item = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(value) => json!(value),
                    ValueRef::Real(value) => json!(value),
                    ValueRef::Text(value) => json!(String::from_utf8_lossy(value)),
                    ValueRef::Blob(bytes) => {
                        use base64::Engine;
                        json!({"blob": base64::engine::general_purpose::STANDARD.encode(bytes)})
                    }
                };
                value.insert(name.to_owned(), item);
            }
            Ok(Value::Object(value))
        })
        .map_err(sql_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_error)?;
    Ok(values)
}

fn snapshot(connection: &Connection, session: &str) -> Result<Value, AppCommandError> {
    let v2 = connection
        .query_row(
            "SELECT COUNT(*) FROM session_v2 WHERE id = ?1",
            [session],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);
    if v2 > 0 {
        return super::opencode_v2::snapshot(connection, session);
    }
    Ok(json!({
        "messages":rows(connection,"SELECT * FROM message WHERE session_id = ?1 ORDER BY time_created,id",session)?,
        "parts":rows(connection,"SELECT * FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id = ?1) ORDER BY time_created,id",session)?
    }))
}

pub(super) fn read(path: &Path, session: &str) -> Result<Vec<u8>, AppCommandError> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sql_error)?;
    serde_json::to_vec(&snapshot(&connection, session)?).map_err(|error| failed(error.to_string()))
}

pub(super) fn insert(
    connection: &Connection,
    table: &str,
    row: &Value,
) -> Result<(), AppCommandError> {
    let row = row
        .as_object()
        .ok_or_else(|| failed("Invalid OpenCode backup row"))?;
    let mut names = Vec::new();
    let mut values = Vec::new();
    for (name, value) in row {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(failed("Invalid OpenCode column identity"));
        }
        names.push(format!("\"{name}\""));
        values.push(match value {
            Value::Null => rusqlite::types::Value::Null,
            Value::String(value) => rusqlite::types::Value::Text(value.clone()),
            Value::Number(value) if value.is_i64() => {
                rusqlite::types::Value::Integer(value.as_i64().unwrap())
            }
            Value::Number(value) => rusqlite::types::Value::Real(value.as_f64().unwrap()),
            Value::Object(value) if value.get("blob").and_then(Value::as_str).is_some() => {
                use base64::Engine;
                rusqlite::types::Value::Blob(
                    base64::engine::general_purpose::STANDARD
                        .decode(value["blob"].as_str().unwrap())
                        .map_err(|_| failed("Invalid OpenCode backup blob"))?,
                )
            }
            _ => return Err(failed("Invalid OpenCode backup value")),
        });
    }
    let placeholders = vec!["?"; names.len()].join(",");
    connection
        .execute(
            &format!(
                "INSERT INTO {table} ({}) VALUES ({placeholders})",
                names.join(",")
            ),
            rusqlite::params_from_iter(values),
        )
        .map_err(sql_error)?;
    Ok(())
}

pub(super) fn publish(
    path: &Path,
    session: &str,
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
    let current = snapshot(&transaction, session)?;
    if serde_json::to_vec(&current).map_err(|error| failed(error.to_string()))? != expected {
        return Err(super::history::conflict());
    }
    let target: Value =
        serde_json::from_slice(replacement).map_err(|error| failed(error.to_string()))?;
    if current["format"] == "opencode-v2" {
        super::opencode_v2::publish(&transaction, session, &current, &target)?;
        return transaction.commit().map_err(sql_error);
    }
    // 原生 ID 保持原样；只删除撤回段，已有前缀不删不重建，更不触碰 OpenCode 的文件快照。
    for (key, table) in [("parts", "part"), ("messages", "message")] {
        let target_rows = target[key]
            .as_array()
            .ok_or_else(|| failed("Invalid OpenCode backup"))?;
        for row in current[key].as_array().unwrap() {
            if !target_rows.iter().any(|saved| saved["id"] == row["id"]) {
                transaction
                    .execute(
                        &format!("DELETE FROM {table} WHERE id = ?1"),
                        [row["id"].as_str()],
                    )
                    .map_err(sql_error)?;
            }
        }
    }
    for (key, table) in [("messages", "message"), ("parts", "part")] {
        let current_rows = current[key].as_array().unwrap();
        for row in target[key].as_array().unwrap() {
            if !current_rows.iter().any(|saved| saved["id"] == row["id"]) {
                insert(&transaction, table, row)?;
            }
        }
    }
    transaction.commit().map_err(sql_error)
}

pub(super) fn replacement(
    env: &AgentEnv,
    session: &str,
    prompt: &MessageTurn,
) -> Result<(PathBuf, Vec<u8>, Vec<u8>), AppCommandError> {
    let path = path(env)?;
    let original = read(&path, session)?;
    let mut value: Value =
        serde_json::from_slice(&original).map_err(|error| failed(error.to_string()))?;
    if value["format"] == "opencode-v2" {
        let replacement = super::opencode_v2::replacement(value, prompt)?;
        return Ok((path, original, replacement));
    }
    let text = prompt
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let messages = value["messages"].as_array().unwrap();
    let parts = value["parts"].as_array().unwrap();
    let candidates = messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            let data: Value = serde_json::from_str(message["data"].as_str().unwrap_or_default())
                .unwrap_or_default();
            let content = parts
                .iter()
                .filter(|part| part["message_id"] == message["id"])
                .filter_map(|part| serde_json::from_str::<Value>(part["data"].as_str()?).ok())
                .filter_map(|part| part["text"].as_str().map(str::to_owned))
                .collect::<Vec<_>>()
                .join("\n");
            data["role"] == "user"
                && data["time"]["created"]
                    .as_i64()
                    .or(message["time_created"].as_i64())
                    == Some(prompt.timestamp.timestamp_millis())
                && content == text
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let [start] = candidates.as_slice() else {
        return Err(AppCommandError::invalid_input(
            "The saved OpenCode user message could not be uniquely located",
        ));
    };
    let selected_id = &messages[*start]["id"];
    if parts
        .iter()
        .filter(|part| part["message_id"] == *selected_id)
        .any(|part| {
            serde_json::from_str::<Value>(part["data"].as_str().unwrap_or_default())
                .map_or(true, |part| part["type"] != "text")
        })
    {
        return Err(AppCommandError::invalid_input(
            "The original OpenCode attachment needs a saved input snapshot",
        ));
    }
    let kept = messages[..*start].to_vec();
    let kept_parts = parts
        .iter()
        .filter(|part| {
            kept.iter()
                .any(|message| message["id"] == part["message_id"])
        })
        .cloned()
        .collect::<Vec<_>>();
    value["messages"] = json!(kept);
    value["parts"] = json!(kept_parts);
    let replacement = serde_json::to_vec(&value).map_err(|error| failed(error.to_string()))?;
    Ok((path, original, replacement))
}

pub(super) fn input(
    env: &AgentEnv,
    session: &str,
    prompt: &MessageTurn,
) -> Result<Vec<crate::acp::types::PromptInputBlock>, AppCommandError> {
    let path = path(env)?;
    let current = read(&path, session)?;
    let value: Value =
        serde_json::from_slice(&current).map_err(|error| failed(error.to_string()))?;
    if value["format"] == "opencode-v2" {
        return super::opencode_v2::input(&value, prompt);
    }
    Ok(super::input::from_turn(prompt))
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
