use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::Connection;
use serde_json::{json, Value};

use super::failed;
use super::opencode::{insert, rows, sql_error};
use crate::acp::types::PromptInputBlock;
use crate::app_error::AppCommandError;
use crate::models::{ContentBlock, MessageTurn};

fn has_table(connection: &Connection, table: &str) -> Result<bool, AppCommandError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )
        .map_err(sql_error)
}

fn optional_rows(
    connection: &Connection,
    table: &str,
    query: &str,
    session: &str,
) -> Result<Vec<Value>, AppCommandError> {
    if has_table(connection, table)? {
        rows(connection, query, session)
    } else {
        Ok(Vec::new())
    }
}

pub(super) fn snapshot(connection: &Connection, session: &str) -> Result<Value, AppCommandError> {
    let sessions = rows(
        connection,
        "SELECT * FROM session_v2 WHERE id = ?1",
        session,
    )?;
    let selected = sessions
        .first()
        .ok_or_else(|| AppCommandError::not_found("The native OpenCode v2 session is missing"))?;
    if ["session", "message", "part"]
        .iter()
        .map(|table| has_table(connection, table))
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .all(|present| *present)
    {
        let legacy = rows(
            connection,
            "SELECT time_updated FROM session WHERE id = ?1",
            session,
        )?;
        if legacy.first().is_some_and(|legacy| {
            legacy["time_updated"].as_i64() >= selected["time_updated"].as_i64()
        }) {
            return Err(AppCommandError::invalid_input(
                "OpenCode has a newer or ambiguous legacy copy; open it in v2 before Undo",
            ));
        }
    }
    Ok(json!({
        "format": "opencode-v2",
        "session": sessions,
        "messages": rows(connection, "SELECT * FROM session_message WHERE session_id = ?1 ORDER BY seq,id", session)?,
        "parts": optional_rows(connection, "session_part", "SELECT * FROM session_part WHERE session_id = ?1 ORDER BY message_id,ordinal", session)?,
        "inbox": optional_rows(connection, "session_inbox", "SELECT * FROM session_inbox WHERE session_id = ?1 ORDER BY enqueued_seq,id", session)?,
        "instructions": optional_rows(connection, "instruction_state", "SELECT * FROM instruction_state WHERE session_id = ?1", session)?,
        "entries": optional_rows(connection, "instruction_entry", "SELECT * FROM instruction_entry WHERE session_id = ?1 ORDER BY key", session)?,
        "refs": optional_rows(connection, "blob_ref", "SELECT * FROM blob_ref WHERE session_id = ?1 ORDER BY message_id,hash", session)?,
        "blobs": if has_table(connection, "blob")? && has_table(connection, "blob_ref")? {
            rows(connection, "SELECT * FROM blob WHERE hash IN (SELECT hash FROM blob_ref WHERE session_id = ?1) ORDER BY hash", session)?
        } else { Vec::new() },
        "sequence": optional_rows(connection, "event_sequence", "SELECT * FROM event_sequence WHERE aggregate_id = ?1", session)?,
        "events": optional_rows(connection, "event", "SELECT * FROM event WHERE aggregate_id = ?1 ORDER BY seq,id", session)?,
    }))
}

fn projected_user_text(value: &Value, message: &Value) -> Vec<String> {
    let mut blocks = Vec::new();
    if let Some(text) = message["text"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        blocks.push(text.to_owned());
    }
    for file in message["files"].as_array().into_iter().flatten() {
        if file.get("mention").is_some() {
            continue;
        }
        let mime = file["mime"].as_str().unwrap_or("application/octet-stream");
        let name = file["name"]
            .as_str()
            .or_else(|| file["source"]["uri"].as_str());
        let media = file["uri"]
            .as_str()
            .and_then(|uri| uri.strip_prefix("media:"));
        let media_row = media.and_then(|hash| {
            value["blobs"]
                .as_array()?
                .iter()
                .find(|blob| blob["hash"] == hash)
        });
        let inline_image = mime.starts_with("image/")
            && file["data"].as_str().is_some_and(|data| !data.is_empty());
        let stored_image = media_row.is_some_and(|blob| {
            blob["mime"]
                .as_str()
                .is_some_and(|mime| mime.starts_with("image/"))
                && blob["data"]["blob"].as_str().is_some()
        });
        if inline_image || stored_image {
            continue;
        }
        if media.is_some() && media_row.is_none() {
            blocks.push(match name {
                Some(name) => format!("[media unavailable: {name} ({mime})]"),
                None => format!("[media unavailable: {mime}]"),
            });
        } else if let Some(name) = name {
            blocks.push(format!("@{name}"));
        }
    }
    blocks
}

fn selected_index(value: &Value, prompt: &MessageTurn) -> Result<usize, AppCommandError> {
    let prompt_text = prompt
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let messages = value["messages"]
        .as_array()
        .ok_or_else(|| failed("Invalid OpenCode v2 message snapshot"))?;
    let candidates = messages
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let data: Value = serde_json::from_str(row["data"].as_str()?).ok()?;
            let matches = row["type"] == "user"
                && projected_user_text(value, &data)
                    .iter()
                    .map(String::as_str)
                    .eq(prompt_text.iter().copied())
                && data["time"]["created"]
                    .as_i64()
                    .or(row["time_created"].as_i64())
                    == Some(prompt.timestamp.timestamp_millis());
            matches.then_some(index)
        })
        .collect::<Vec<_>>();
    match candidates.as_slice() {
        [index] => Ok(*index),
        _ => Err(AppCommandError::invalid_input(
            "The saved OpenCode v2 user message could not be uniquely located",
        )),
    }
}

fn file_data(value: &Value, file: &Value) -> Result<String, AppCommandError> {
    if let Some(data) = file["data"].as_str().filter(|data| !data.is_empty()) {
        STANDARD.decode(data).map_err(|_| {
            AppCommandError::invalid_input("OpenCode v2 attachment bytes are damaged")
        })?;
        return Ok(data.to_owned());
    }
    let hash = file["uri"]
        .as_str()
        .and_then(|uri| uri.strip_prefix("media:"))
        .filter(|hash| !hash.is_empty())
        .ok_or_else(|| {
            AppCommandError::invalid_input("Original OpenCode v2 attachment is missing")
        })?;
    value["blobs"]
        .as_array()
        .and_then(|blobs| blobs.iter().find(|blob| blob["hash"] == hash))
        .and_then(|blob| blob["data"]["blob"].as_str())
        .filter(|data| STANDARD.decode(data).is_ok())
        .map(str::to_owned)
        .ok_or_else(|| AppCommandError::invalid_input("Original OpenCode v2 media blob is missing"))
}

fn validate_resources(value: &Value, message: &Value) -> Result<(), AppCommandError> {
    if message["agents"]
        .as_array()
        .is_some_and(|agents| !agents.is_empty())
        || message["skills"]
            .as_array()
            .is_some_and(|skills| !skills.is_empty())
    {
        return Err(AppCommandError::invalid_input(
            "This OpenCode v2 agent or skill reference needs verified input restoration",
        ));
    }
    for file in message["files"].as_array().into_iter().flatten() {
        if file["source"]["type"] == "uri" {
            if !file["source"]["uri"]
                .as_str()
                .is_some_and(|uri| uri.starts_with("file:"))
            {
                return Err(AppCommandError::invalid_input(
                    "The original OpenCode v2 file reference is not a local file URI",
                ));
            }
        }
        if !is_file_reference(file) {
            file_data(value, file).map_err(|error| {
                AppCommandError::invalid_input(format!(
                    "{}: {}",
                    file["name"].as_str().unwrap_or("OpenCode attachment"),
                    error.message
                ))
            })?;
        }
    }
    Ok(())
}

fn is_file_reference(file: &Value) -> bool {
    if file["source"]["type"] != "uri" {
        return false;
    }
    let Some(uri) = file["source"]["uri"].as_str() else {
        return false;
    };
    let Some(path) = url::Url::parse(uri)
        .ok()
        .and_then(|uri| uri.to_file_path().ok())
    else {
        return false;
    };
    let root = crate::paths::codeg_uploads_root();
    let root = if root.is_absolute() {
        root
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&root))
            .unwrap_or(root)
    };
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let root = crate::paths::simplify_verbatim_path(&root);
    // 私有上传路径只是附件来源，不能把它当工作区引用重读当前文件；原始字节仍来自发送记录。
    #[cfg(windows)]
    {
        !std::path::PathBuf::from(path.to_string_lossy().to_lowercase()).starts_with(
            std::path::PathBuf::from(root.to_string_lossy().to_lowercase()),
        )
    }
    #[cfg(not(windows))]
    {
        !path.starts_with(root)
    }
}

pub(super) fn input(
    value: &Value,
    prompt: &MessageTurn,
) -> Result<Vec<PromptInputBlock>, AppCommandError> {
    let index = selected_index(value, prompt)?;
    let message: Value = serde_json::from_str(
        value["messages"][index]["data"]
            .as_str()
            .unwrap_or_default(),
    )
    .map_err(|error| failed(error.to_string()))?;
    validate_resources(value, &message)?;
    let mut blocks = Vec::new();
    if let Some(text) = message["text"].as_str().filter(|text| !text.is_empty()) {
        blocks.push(PromptInputBlock::Text {
            text: text.to_owned(),
        });
    }
    for file in message["files"].as_array().into_iter().flatten() {
        let mime = file["mime"].as_str().unwrap_or("application/octet-stream");
        let name = file["name"].as_str().unwrap_or("attachment.bin");
        if is_file_reference(file) {
            blocks.push(PromptInputBlock::ResourceLink {
                uri: file["source"]["uri"].as_str().unwrap().to_owned(),
                name: name.to_owned(),
                mime_type: Some(mime.to_owned()),
                description: file["description"].as_str().map(str::to_owned),
            });
            continue;
        }
        let data = file_data(value, file)?;
        if mime.starts_with("image/") {
            blocks.push(PromptInputBlock::Image {
                data,
                mime_type: mime.to_owned(),
                uri: None,
            });
        } else {
            blocks.push(PromptInputBlock::Resource {
                uri: format!("attachment://{name}"),
                mime_type: Some(mime.to_owned()),
                text: None,
                blob: Some(data),
            });
        }
    }
    Ok(blocks)
}

pub(super) fn replacement(
    mut value: Value,
    prompt: &MessageTurn,
) -> Result<Vec<u8>, AppCommandError> {
    let index = selected_index(&value, prompt)?;
    let session = &value["session"][0];
    if !session["revert"].is_null()
        || !session["time_suspended"].is_null()
        || !session["time_compacting"].is_null()
        || !value["inbox"].as_array().is_some_and(Vec::is_empty)
    {
        return Err(AppCommandError::invalid_input(
            "OpenCode v2 still has pending native work or an uncommitted revert",
        ));
    }
    if !value["events"].as_array().is_some_and(Vec::is_empty) {
        return Err(AppCommandError::invalid_input(
            "This OpenCode durable event log needs verified native rewind",
        ));
    }
    let message: Value = serde_json::from_str(
        value["messages"][index]["data"]
            .as_str()
            .unwrap_or_default(),
    )
    .map_err(|error| failed(error.to_string()))?;
    validate_resources(&value, &message)?;
    let boundary = value["messages"][index]["seq"]
        .as_i64()
        .ok_or_else(|| failed("OpenCode v2 message sequence is missing"))?;
    let kept = value["messages"].as_array().unwrap()[..index].to_vec();
    for key in ["parts", "refs"] {
        value[key].as_array_mut().unwrap().retain(|row| {
            kept.iter()
                .any(|message| message["id"] == row["message_id"])
        });
    }
    value["instructions"].as_array_mut().unwrap().retain(|row| {
        row["through_seq"]
            .as_i64()
            .is_some_and(|seq| seq < boundary)
    });
    let references = value["refs"].as_array().unwrap().clone();
    value["blobs"].as_array_mut().unwrap().retain(|row| {
        references
            .iter()
            .any(|reference| reference["hash"] == row["hash"])
    });
    value["messages"] = json!(kept);
    serde_json::to_vec(&value).map_err(|error| failed(error.to_string()))
}

fn keys_for(table: &str) -> &'static [&'static str] {
    match table {
        "session_part" => &["message_id", "ordinal"],
        "blob_ref" => &["message_id", "hash"],
        "instruction_state" => &["session_id"],
        _ => &["id"],
    }
}

pub(super) fn publish(
    connection: &Connection,
    session: &str,
    current: &Value,
    target: &Value,
) -> Result<(), AppCommandError> {
    if target["format"] != "opencode-v2"
        || ["session", "sequence", "events", "inbox", "entries"]
            .iter()
            .any(|key| current[*key] != target[*key])
    {
        return Err(super::history::conflict());
    }
    let tables = [
        ("parts", "session_part"),
        ("refs", "blob_ref"),
        ("instructions", "instruction_state"),
        ("messages", "session_message"),
    ];
    for (key, table) in tables {
        let current_rows = current[key]
            .as_array()
            .ok_or_else(|| failed("Invalid v2 snapshot"))?;
        let target_rows = target[key]
            .as_array()
            .ok_or_else(|| failed("Invalid v2 backup"))?;
        let keys = keys_for(table);
        for row in current_rows {
            if target_rows.iter().any(|saved| saved == row) {
                continue;
            }
            let predicates = keys
                .iter()
                .map(|key| format!("{key} = ?"))
                .collect::<Vec<_>>();
            let values = keys
                .iter()
                .map(|key| match &row[*key] {
                    Value::String(value) => Ok(rusqlite::types::Value::Text(value.clone())),
                    Value::Number(value) if value.is_i64() => {
                        Ok(rusqlite::types::Value::Integer(value.as_i64().unwrap()))
                    }
                    _ => Err(failed("Invalid OpenCode v2 row identity")),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut parameters = vec![rusqlite::types::Value::Text(session.to_owned())];
            parameters.extend(values);
            connection
                .execute(
                    &format!(
                        "DELETE FROM {table} WHERE session_id = ? AND {}",
                        predicates.join(" AND ")
                    ),
                    rusqlite::params_from_iter(parameters),
                )
                .map_err(sql_error)?;
        }
    }
    for blob in target["blobs"]
        .as_array()
        .ok_or_else(|| failed("Invalid v2 media backup"))?
    {
        let hash = blob["hash"]
            .as_str()
            .ok_or_else(|| failed("Invalid v2 media identity"))?;
        let existing = rows(connection, "SELECT * FROM blob WHERE hash = ?1", hash)?;
        match existing.as_slice() {
            [] => insert(connection, "blob", blob)?,
            [current] if current == blob => {}
            _ => return Err(super::history::conflict()),
        }
    }
    for (key, table) in tables.into_iter().rev() {
        let keys = keys_for(table);
        for row in target[key].as_array().unwrap() {
            let existing = current[key]
                .as_array()
                .unwrap()
                .iter()
                .find(|saved| keys.iter().all(|key| saved[*key] == row[*key]));
            match existing {
                Some(saved) if saved == row => {}
                Some(_) if table == "instruction_state" => insert(connection, table, row)?,
                Some(_) => return Err(super::history::conflict()),
                None => insert(connection, table, row)?,
            }
        }
    }
    Ok(())
}
