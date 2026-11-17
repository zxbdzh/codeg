use super::{failed, UndoIssue};
use crate::acp::types::PromptInputBlock;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::models::{ContentBlock, MessageTurn};
use crate::parsers::{cline::cline_data_dir_for_env, AgentEnv};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{types::ValueRef, Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn sql_error(error: rusqlite::Error) -> AppCommandError {
    failed(error.to_string())
}

fn validate_session(session: &str) -> Result<(), AppCommandError> {
    if session.is_empty()
        || session.starts_with('.')
        || !session
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AppCommandError::invalid_input(
            "Invalid Cline session identity",
        ));
    }
    Ok(())
}

pub(super) fn path(env: &AgentEnv, session: &str) -> Result<PathBuf, AppCommandError> {
    validate_session(session)?;
    Ok(cline_data_dir_for_env(env)
        .join("sessions")
        .join(session)
        .join(format!("{session}.messages.json")))
}

fn validate_path(path: &Path, session: &str) -> Result<PathBuf, AppCommandError> {
    validate_session(session)?;
    let expected_file = format!("{session}.messages.json");
    let session_dir = path
        .parent()
        .filter(|directory| directory.file_name().and_then(|name| name.to_str()) == Some(session))
        .ok_or_else(|| AppCommandError::invalid_input("Invalid Cline message path"))?;
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_file.as_str())
        || session_dir.parent().is_none_or(|directory| {
            directory.file_name().and_then(|name| name.to_str()) != Some("sessions")
        })
    {
        return Err(AppCommandError::invalid_input("Invalid Cline message path"));
    }
    Ok(session_dir.to_path_buf())
}

fn sqlite_rows(
    connection: &Connection,
    query: &str,
    session: &str,
) -> Result<Value, AppCommandError> {
    let mut statement = connection.prepare(query).map_err(sql_error)?;
    let columns = statement
        .column_names()
        .iter()
        .map(|name| name.to_string())
        .collect::<Vec<_>>();
    let mut rows = statement.query([session]).map_err(sql_error)?;
    let mut values = Vec::new();
    while let Some(row) = rows.next().map_err(sql_error)? {
        let mut value = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            value.push(match row.get_ref(index).map_err(sql_error)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(number) => json!(number),
                ValueRef::Real(number) => json!(number),
                ValueRef::Text(bytes) => Value::String(
                    std::str::from_utf8(bytes)
                        .map_err(|error| failed(error.to_string()))?
                        .to_owned(),
                ),
                ValueRef::Blob(bytes) => json!({
                    "blob": STANDARD.encode(bytes)
                }),
            });
        }
        values.push(value);
    }
    Ok(json!({"columns": columns, "rows": values}))
}

fn related_session_files(session_dir: &Path) -> Result<Vec<String>, AppCommandError> {
    let mut files = std::fs::read_dir(session_dir)
        .map_err(AppCommandError::io)?
        .map(|entry| {
            let entry = entry.map_err(AppCommandError::io)?;
            if !entry.file_type().map_err(AppCommandError::io)?.is_file() {
                return Ok(None);
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            Ok(
                (name.ends_with(".messages.json") || name.ends_with(".compaction.json"))
                    .then_some(name),
            )
        })
        .collect::<Result<Vec<_>, AppCommandError>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, AppCommandError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppCommandError::io(error)),
    }
}

fn snapshot(path: &Path, session: &str) -> Result<Value, AppCommandError> {
    let session_dir = validate_path(path, session)?;
    let data_dir = session_dir
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| AppCommandError::invalid_input("Invalid Cline data directory"))?;
    let manifest_path = session_dir.join(format!("{session}.json"));
    let compaction_path = session_dir.join(format!("{session}.compaction.json"));
    let index_path = data_dir.join("db").join("sessions.db");
    let manifest = std::fs::read(&manifest_path).map_err(AppCommandError::io)?;
    let messages = std::fs::read(path).map_err(AppCommandError::io)?;
    let compaction = read_optional(&compaction_path)?;
    let connection = Connection::open_with_flags(&index_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(sql_error)?;
    let session_row = sqlite_rows(
        &connection,
        "SELECT * FROM sessions WHERE session_id = ?1",
        session,
    )?;
    let child_rows = sqlite_rows(
        &connection,
        "SELECT * FROM sessions WHERE parent_session_id = ?1 ORDER BY session_id",
        session,
    )?;
    let has_spawn_queue: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subagent_spawn_queue')",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    let pending_spawns = if has_spawn_queue {
        sqlite_rows(
            &connection,
            "SELECT * FROM subagent_spawn_queue WHERE root_session_id = ?1 AND consumed_at IS NULL ORDER BY id",
            session,
        )?
    } else {
        json!({"columns": [], "rows": []})
    };

    Ok(json!({
        "version": 1,
        "sessionId": session,
        "manifest": STANDARD.encode(manifest),
        "messages": STANDARD.encode(messages),
        "compaction": compaction.map(|bytes| STANDARD.encode(bytes)),
        "relatedFiles": related_session_files(&session_dir)?,
        "sessionIndex": session_row,
        "childIndex": child_rows,
        "pendingSpawns": pending_spawns,
    }))
}

fn column<'a>(table: &'a Value, row: &'a [Value], name: &str) -> Option<&'a Value> {
    let index = table["columns"]
        .as_array()?
        .iter()
        .position(|column| column.as_str() == Some(name))?;
    row.get(index)
}

fn same_path(left: &str, right: &Path) -> bool {
    let left = crate::paths::simplify_verbatim_path(Path::new(left));
    let right = crate::paths::simplify_verbatim_path(right);
    if cfg!(windows) {
        // SDK 与 Rust 可能使用不同分隔符；按组件比较同一原生路径，不对未知索引路径发起文件访问。
        left.components()
            .map(|part| part.as_os_str().to_string_lossy().to_ascii_lowercase())
            .eq(right
                .components()
                .map(|part| part.as_os_str().to_string_lossy().to_ascii_lowercase()))
    } else {
        left == right
    }
}

pub(super) fn ensure_local_backend(env: &AgentEnv) -> Result<(), AppCommandError> {
    // 未覆盖时沿用 Codeg 登记的 local；Hub 的内存上下文不能靠改文件安全回退。
    if env
        .override_for("CLINE_SESSION_BACKEND_MODE")
        .is_some_and(|mode| !mode.trim().eq_ignore_ascii_case("local"))
    {
        return Err(AppCommandError::invalid_input(
            "Cline Undo requires the verified local session backend; hub or auto context has been kept",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // 无权查询并不代表进程已经退出；遇到权限不明必须保留历史。
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }
        let mut exit_code = 0;
        let queried = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        queried == 0 || exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return true;
    };
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}

#[cfg(not(any(windows, unix)))]
fn process_alive(_pid: u32) -> bool {
    true
}

fn ensure_owner_stopped(value: &Value) -> Result<(), AppCommandError> {
    let manifest = decode_snapshot(&decode_field(value, "manifest")?)?;
    let mut owners = vec![(manifest["status"].clone(), manifest["pid"].clone())];
    if let Some(rows) = value["sessionIndex"]["rows"].as_array() {
        for row in rows.iter().filter_map(Value::as_array) {
            owners.push((
                column(&value["sessionIndex"], row, "status")
                    .cloned()
                    .unwrap_or_default(),
                column(&value["sessionIndex"], row, "pid")
                    .cloned()
                    .unwrap_or_default(),
            ));
        }
    }
    for (status, pid) in owners {
        let active = matches!(status.as_str(), Some("idle" | "running" | "pending"));
        let known_status =
            active || matches!(status.as_str(), Some("completed" | "failed" | "cancelled"));
        let owner_unverified = match &pid {
            Value::Null => active,
            Value::Number(_) => pid.as_u64().is_none_or(|pid| {
                if pid == 0 {
                    active
                } else {
                    u32::try_from(pid).map_or(true, process_alive)
                }
            }),
            _ => true,
        };
        // 完成状态不证明热缓存已退出；活动状态缺少 PID 也不能当作已停止。
        if !known_status || owner_unverified {
            return Err(AppCommandError::new(
                AppErrorCode::TurnInProgress,
                "The native Cline owner is still running; conversation history has been kept",
            ));
        }
    }
    Ok(())
}

fn ensure_supported(value: &Value, path: &Path, session: &str) -> Result<(), AppCommandError> {
    if value["version"] != 1 || value["sessionId"] != session {
        return Err(AppCommandError::invalid_input(
            "Cline session snapshot identity changed",
        ));
    }
    // Compaction 和子会话会改变模型实际看到的上下文，缺少对应恢复语义时必须拒绝。
    if !value["compaction"].is_null()
        || value["relatedFiles"].as_array().is_none_or(|files| {
            files.iter().any(|file| {
                file.as_str()
                    .is_some_and(|name| name.ends_with(".compaction.json"))
            })
        })
    {
        return Err(AppCommandError::invalid_input(
            "Cline compaction context cannot be rewound exactly",
        ));
    }

    let expected_messages = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppCommandError::invalid_input("Invalid Cline message path"))?;
    let related_files = value["relatedFiles"]
        .as_array()
        .ok_or_else(|| failed("Cline session file index is unavailable"))?;
    if !related_files
        .iter()
        .any(|file| file.as_str() == Some(expected_messages))
        || related_files.iter().any(|file| {
            file.as_str()
                .is_some_and(|name| name.ends_with(".messages.json") && name != expected_messages)
        })
    {
        return Err(AppCommandError::invalid_input(
            "Cline child-session messages are not supported",
        ));
    }

    let root_rows = value["sessionIndex"]["rows"]
        .as_array()
        .ok_or_else(|| failed("Cline session index is unavailable"))?;
    let [root_row] = root_rows.as_slice() else {
        return Err(AppCommandError::invalid_input(
            "Cline session index does not uniquely identify this session",
        ));
    };
    let root_row = root_row
        .as_array()
        .ok_or_else(|| failed("Cline session index row is invalid"))?;
    if column(&value["sessionIndex"], root_row, "session_id").and_then(Value::as_str)
        != Some(session)
        || column(&value["sessionIndex"], root_row, "parent_session_id")
            .is_some_and(|parent| !parent.is_null())
        || column(&value["sessionIndex"], root_row, "is_subagent")
            .and_then(Value::as_i64)
            .is_none_or(|is_subagent| is_subagent != 0)
        || column(&value["sessionIndex"], root_row, "messages_path")
            .and_then(Value::as_str)
            .is_none_or(|stored_path| !same_path(stored_path, path))
    {
        return Err(AppCommandError::invalid_input(
            "Cline session index does not match its native messages file",
        ));
    }
    if value["childIndex"]["rows"]
        .as_array()
        .is_none_or(|children| !children.is_empty())
        || value["pendingSpawns"]["rows"]
            .as_array()
            .is_none_or(|spawns| !spawns.is_empty())
    {
        return Err(AppCommandError::invalid_input(
            "Cline child-agent context or queued spawn cannot be rewound exactly",
        ));
    }

    let manifest_bytes = STANDARD
        .decode(value["manifest"].as_str().unwrap_or_default())
        .map_err(|error| failed(error.to_string()))?;
    let manifest: Value =
        serde_json::from_slice(&manifest_bytes).map_err(|error| failed(error.to_string()))?;
    if manifest["session_id"] != session {
        return Err(AppCommandError::invalid_input(
            "Cline manifest identity does not match the selected session",
        ));
    }
    if manifest
        .get("compaction_path")
        .is_some_and(|path| !path.is_null())
        || manifest["messages_path"]
            .as_str()
            .is_some_and(|stored_path| !same_path(stored_path, path))
    {
        return Err(AppCommandError::invalid_input(
            "Cline redirected history or compaction context requires verified native rewind",
        ));
    }
    Ok(())
}

pub(super) fn read(path: &Path, session: &str) -> Result<Vec<u8>, AppCommandError> {
    serde_json::to_vec(&snapshot(path, session)?).map_err(|error| failed(error.to_string()))
}

fn text_parts(content: &Value) -> Vec<&str> {
    match content {
        Value::String(text) => vec![text],
        Value::Array(items) => items
            .iter()
            .filter(|item| item["type"] == "text")
            .filter_map(|item| item["text"].as_str())
            .collect(),
        _ => Vec::new(),
    }
}

fn has_user_wrapper(text: &str) -> bool {
    text.contains("<user_input") || text.contains("<user_command")
}

fn rewrite_wrapper(text: &str, tag: &str, keep_inner: bool) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut result = text.to_owned();
    let mut from = 0;
    while let Some(relative) = result[from..].find(&open) {
        let start = from + relative;
        let after_name = start + open.len();
        let rest = &result[after_name..];
        if !rest
            .chars()
            .next()
            .is_some_and(|character| character == '>' || character.is_whitespace())
        {
            from = after_name;
            continue;
        }
        let Some(tag_end) = rest.find('>') else {
            break;
        };
        let inner_start = after_name + tag_end + 1;
        let Some(close_relative) = result[inner_start..].find(&close) else {
            break;
        };
        let inner_end = inner_start + close_relative;
        let inner = if keep_inner {
            result[inner_start..inner_end].to_owned()
        } else {
            String::new()
        };
        let tail = result[inner_end + close.len()..].to_owned();
        result = format!("{}{}{}", &result[..start], inner, tail);
        from = start;
    }
    result
}

fn clean_user_text(text: &str) -> String {
    let text = rewrite_wrapper(text, "user_input", true);
    let text = rewrite_wrapper(&text, "user_command", true);
    rewrite_wrapper(&text, "mode_notice", false)
        .trim()
        .to_owned()
}

fn projected_user_texts(message: &Value) -> Vec<String> {
    let texts = text_parts(&message["content"]);
    let has_wrapped_input = texts.iter().any(|text| has_user_wrapper(text));
    let has_tool_result = message["content"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["type"] == "tool_result"));
    texts
        .into_iter()
        .filter(|text| {
            if has_wrapped_input {
                has_user_wrapper(text)
            } else {
                !has_tool_result
            }
        })
        .map(clean_user_text)
        .filter(|text| {
            !text.is_empty()
                && text != "The user approved switching to act mode. Continue with the approved plan now."
        })
        .collect()
}

fn wrapped_input(text: &str) -> Result<Vec<String>, AppCommandError> {
    let mut result = Vec::new();
    let mut from = 0;
    while from < text.len() {
        let next = ["user_input", "user_command"]
            .iter()
            .filter_map(|tag| {
                text[from..]
                    .find(&format!("<{tag}"))
                    .map(|relative| (from + relative, *tag))
            })
            .min_by_key(|(start, _)| *start);
        let Some((start, tag)) = next else {
            break;
        };
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        let after_name = start + open.len();
        let rest = &text[after_name..];
        if !rest
            .chars()
            .next()
            .is_some_and(|character| character == '>' || character.is_whitespace())
        {
            from = after_name;
            continue;
        }
        let Some(tag_end) = rest.find('>') else {
            return Err(AppCommandError::invalid_input(
                "Cline input wrapper is incomplete",
            ));
        };
        let inner_start = after_name + tag_end + 1;
        let Some(close_relative) = text[inner_start..].find(&close) else {
            return Err(AppCommandError::invalid_input(
                "Cline input wrapper is incomplete",
            ));
        };
        let inner_end = inner_start + close_relative;
        result.push(text[inner_start..inner_end].to_owned());
        from = inner_end + close.len();
    }
    Ok(result)
}

fn image_input(block: &Value) -> Result<PromptInputBlock, AppCommandError> {
    let source = &block["source"];
    if source["type"] != "base64" {
        return Err(AppCommandError::invalid_input(
            "Cline image attachment has no embedded original bytes",
        ));
    }
    let data = source["data"]
        .as_str()
        .or_else(|| block["data"].as_str())
        .unwrap_or_default();
    let (data, data_mime) = if let Some(data_uri) = data.strip_prefix("data:") {
        let (mime, encoded) = data_uri
            .split_once(";base64,")
            .ok_or_else(|| AppCommandError::invalid_input("Cline image data URI is invalid"))?;
        (encoded, Some(mime))
    } else {
        (data, None)
    };
    let mime = source["media_type"]
        .as_str()
        .or_else(|| source["mime_type"].as_str())
        .or_else(|| block["mimeType"].as_str())
        .or(data_mime)
        .unwrap_or_default();
    if data.is_empty() || !mime.starts_with("image/") || STANDARD.decode(data).is_err() {
        return Err(AppCommandError::invalid_input(
            "Cline image attachment bytes or MIME type are invalid",
        ));
    }
    Ok(PromptInputBlock::Image {
        data: data.to_owned(),
        mime_type: mime.to_owned(),
        uri: None,
    })
}

fn original_input(message: &Value) -> Result<Vec<PromptInputBlock>, AppCommandError> {
    let texts = text_parts(&message["content"]);
    let has_wrapped_input = texts.iter().any(|text| has_user_wrapper(text));
    let has_tool_result = message["content"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["type"] == "tool_result"));
    let mut input = Vec::new();
    match &message["content"] {
        Value::String(text) => {
            let parts = if has_wrapped_input {
                wrapped_input(text)?
            } else {
                vec![text.clone()]
            };
            input.extend(
                parts
                    .into_iter()
                    .map(|text| PromptInputBlock::Text { text }),
            );
        }
        Value::Array(items) => {
            for item in items {
                match item["type"].as_str() {
                    Some("text") => {
                        let text = item["text"].as_str().unwrap_or_default();
                        if has_wrapped_input {
                            let parts = wrapped_input(text)?;
                            input.extend(
                                parts
                                    .into_iter()
                                    .map(|text| PromptInputBlock::Text { text }),
                            );
                        } else if !has_tool_result {
                            input.push(PromptInputBlock::Text {
                                text: text.to_owned(),
                            });
                        }
                    }
                    Some("image") if has_wrapped_input || !has_tool_result => {
                        input.push(image_input(item)?);
                    }
                    Some("tool_result") | Some("thinking") | Some("tool_use") => {}
                    Some(other) => {
                        return Err(AppCommandError::invalid_input(format!(
                            "Cline input contains an unsupported content block: {other}"
                        )));
                    }
                    None => {
                        return Err(AppCommandError::invalid_input(
                            "Cline input contains a content block without a type",
                        ));
                    }
                }
            }
        }
        _ => {
            return Err(AppCommandError::invalid_input(
                "Cline input has an unsupported native content shape",
            ));
        }
    }
    if input.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Cline original input could not be recovered",
        ));
    }
    Ok(input)
}

fn prompt_texts(prompt: &MessageTurn) -> Result<Vec<String>, AppCommandError> {
    let texts = prompt
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(Ok(text.clone())),
            ContentBlock::Image { .. } => None,
            _ => Some(Err(AppCommandError::invalid_input(
                "Cline prompt projection contains unsupported blocks",
            ))),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if texts.is_empty()
        && !prompt
            .blocks
            .iter()
            .any(|block| matches!(block, ContentBlock::Image { .. }))
    {
        return Err(AppCommandError::invalid_input(
            "Cline prompt projection is empty",
        ));
    }
    Ok(texts)
}

fn select_message(messages: &Value, prompt: &MessageTurn) -> Result<usize, AppCommandError> {
    let expected = prompt_texts(prompt)?;
    let candidates = messages["messages"]
        .as_array()
        .ok_or_else(|| failed("Cline message list is unavailable"))?
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            if message["role"] != "user" || projected_user_texts(message) != expected {
                return None;
            }
            let timestamp = message["ts"].as_i64();
            (timestamp
                .is_none_or(|value| value <= 0 || value == prompt.timestamp.timestamp_millis()))
            .then_some(index)
        })
        .collect::<Vec<_>>();
    let [index] = candidates.as_slice() else {
        return Err(AppCommandError::invalid_input(
            "The original Cline user message cannot be uniquely located",
        ));
    };
    let message = &messages["messages"][*index];
    original_input(message)?;
    Ok(*index)
}

fn decode_snapshot(snapshot: &[u8]) -> Result<Value, AppCommandError> {
    serde_json::from_slice(snapshot).map_err(|error| failed(error.to_string()))
}

fn decode_field(value: &Value, name: &str) -> Result<Vec<u8>, AppCommandError> {
    STANDARD
        .decode(value[name].as_str().unwrap_or_default())
        .map_err(|error| failed(error.to_string()))
}

fn history_snapshot(bytes: &[u8]) -> Result<Value, AppCommandError> {
    let mut value = decode_snapshot(bytes)?;
    let mut manifest = decode_snapshot(&decode_field(&value, "manifest")?)?;
    let runtime_fields = [
        "pid",
        "status",
        "status_lock",
        "exit_code",
        "ended_at",
        "updated_at",
    ];
    for name in runtime_fields {
        manifest
            .as_object_mut()
            .ok_or_else(|| failed("Cline manifest is not an object"))?
            .remove(name);
    }
    value["manifest"] = manifest;
    let columns = value["sessionIndex"]["columns"]
        .as_array()
        .ok_or_else(|| failed("Cline index columns are invalid"))?
        .clone();
    for row in value["sessionIndex"]["rows"]
        .as_array_mut()
        .ok_or_else(|| failed("Cline index rows are invalid"))?
    {
        for (index, name) in columns.iter().enumerate() {
            if name
                .as_str()
                .is_some_and(|name| runtime_fields.contains(&name))
            {
                row[index] = Value::Null;
            }
        }
    }
    let mut messages = decode_snapshot(&decode_field(&value, "messages")?)?;
    // 原生每次落盘会刷新文档时间；消息本身的 ts、内容、工具配对和重放字段仍全部参与校验。
    messages
        .as_object_mut()
        .ok_or_else(|| failed("Cline messages document is not an object"))?
        .remove("updated_at");
    value["messages"] = messages;
    Ok(value)
}

pub(super) fn history_digest(bytes: &[u8]) -> String {
    history_snapshot(bytes)
        .and_then(|value| serde_json::to_vec(&value).map_err(|error| failed(error.to_string())))
        .map_or_else(
            |_| super::history::digest(bytes),
            |bytes| super::history::digest(&bytes),
        )
}

pub(super) fn replacement(
    env: &AgentEnv,
    session: &str,
    prompt: &MessageTurn,
) -> Result<(PathBuf, Vec<u8>, Vec<u8>), AppCommandError> {
    ensure_local_backend(env)?;
    let path = path(env, session)?;
    let original = read(&path, session)?;
    let mut snapshot = decode_snapshot(&original)?;
    ensure_supported(&snapshot, &path, session)?;
    let mut messages = decode_snapshot(&decode_field(&snapshot, "messages")?)?;
    let selected = select_message(&messages, prompt)?;
    let native_messages = messages["messages"]
        .as_array_mut()
        .ok_or_else(|| failed("Cline message list is unavailable"))?;
    let message = native_messages
        .get_mut(selected)
        .ok_or_else(|| failed("Cline selected message disappeared"))?;
    let has_wrapped_input = text_parts(&message["content"])
        .iter()
        .any(|text| has_user_wrapper(text));
    let has_tool_result = message["content"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["type"] == "tool_result"));
    let has_retained_content = match message["content"].as_array_mut() {
        Some(items) => {
            items.retain(|item| match item["type"].as_str() {
                Some("tool_result") => true,
                Some("text") if has_wrapped_input => {
                    !has_user_wrapper(item["text"].as_str().unwrap_or_default())
                }
                Some("text") => has_tool_result,
                _ => false,
            });
            !items.is_empty()
        }
        None => false,
    };
    if has_retained_content {
        native_messages.truncate(selected + 1);
    } else {
        native_messages.truncate(selected);
    }

    snapshot["messages"] = Value::String(
        STANDARD.encode(serde_json::to_vec(&messages).map_err(|error| failed(error.to_string()))?),
    );
    let replacement = serde_json::to_vec(&snapshot).map_err(|error| failed(error.to_string()))?;
    Ok((path, original, replacement))
}

pub(super) fn publish(
    path: &Path,
    session: &str,
    expected: &[u8],
    replacement: &[u8],
) -> Result<(), AppCommandError> {
    let latest = read(path, session)?;
    if history_digest(&latest) != history_digest(expected) {
        return Err(super::history::conflict());
    }
    let current = decode_snapshot(&latest)?;
    let target = decode_snapshot(replacement)?;
    ensure_supported(&current, path, session)?;
    ensure_supported(&target, path, session)?;
    ensure_owner_stopped(&current)?;
    let mut target_context = target.clone();
    target_context["messages"] = current["messages"].clone();
    if history_digest(
        &serde_json::to_vec(&target_context).map_err(|error| failed(error.to_string()))?,
    ) != history_digest(&latest)
    {
        return Err(AppCommandError::invalid_input(
            "Cline session metadata changed during history replacement",
        ));
    }
    let mut messages = decode_field(&target, "messages")?;
    let mut parsed_messages: Value =
        serde_json::from_slice(&messages).map_err(|error| failed(error.to_string()))?;
    if parsed_messages["messages"].as_array().is_none() {
        return Err(failed("Cline replacement message list is invalid"));
    }
    let current_messages = decode_snapshot(&decode_field(&current, "messages")?)?;
    if parsed_messages.get("updated_at") != current_messages.get("updated_at") {
        // 只恢复消息数组，不把重连后的运行时间戳、manifest 和索引中的旧 PID 回写。
        let document = parsed_messages.as_object_mut().unwrap();
        match current_messages.get("updated_at") {
            Some(updated_at) => {
                document.insert("updated_at".into(), updated_at.clone());
            }
            None => {
                document.remove("updated_at");
            }
        }
        messages =
            serde_json::to_vec(&parsed_messages).map_err(|error| failed(error.to_string()))?;
    }
    if read(path, session)? != latest {
        return Err(super::history::conflict());
    }
    super::history::atomic_write(path, &messages)
}

pub(super) fn input(
    env: &AgentEnv,
    session: &str,
    prompt: &MessageTurn,
) -> Result<Vec<PromptInputBlock>, AppCommandError> {
    ensure_local_backend(env)?;
    let path = path(env, session)?;
    let snapshot = decode_snapshot(&read(&path, session)?)?;
    ensure_supported(&snapshot, &path, session)?;
    let messages = decode_snapshot(&decode_field(&snapshot, "messages")?)?;
    let index = select_message(&messages, prompt)?;
    original_input(&messages["messages"][index])
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
