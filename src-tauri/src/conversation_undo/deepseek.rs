use super::{failed, UndoIssue};
use crate::acp::types::PromptInputBlock;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::models::{ContentBlock, MessageTurn};
use crate::parsers::{deepseek::DeepSeekParser, AgentEnv};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
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

fn object_relative(part: &Value) -> Result<PathBuf, AppCommandError> {
    let reference = &part["attachment"];
    let hash = reference["attachmentId"]
        .as_str()
        .and_then(|id| id.strip_prefix("sha256:"))
        .filter(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
        .ok_or_else(|| AppCommandError::invalid_input("DSH attachment identity is invalid"))?;
    if part["type"] == "file" {
        let name = reference["name"]
            .as_str()
            .filter(|name| {
                !name.is_empty()
                    && *name != "."
                    && *name != ".."
                    && !name.ends_with(['.', ' '])
                    && !name.chars().any(|character| {
                        character.is_control()
                            || matches!(
                                character,
                                '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'
                            )
                    })
            })
            .ok_or_else(|| AppCommandError::invalid_input("DSH stored file name is invalid"))?;
        return Ok(PathBuf::from("files")
            .join(&hash[..2])
            .join(hash)
            .join(name));
    }
    Ok(PathBuf::from("objects").join(&hash[..2]).join(hash))
}

fn referenced_attachments(log: &[u8]) -> Result<BTreeMap<PathBuf, Value>, AppCommandError> {
    let raw = std::str::from_utf8(log).map_err(|error| failed(error.to_string()))?;
    let mut references = BTreeMap::new();
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        let event: Value = serde_json::from_str(line).map_err(|error| failed(error.to_string()))?;
        for content in [
            &event["data"]["content"],
            &event["data"]["message"]["content"],
        ] {
            for part in content
                .as_array()
                .into_iter()
                .flatten()
                .filter(|part| matches!(part["type"].as_str(), Some("image" | "file")))
            {
                let relative = object_relative(part)?;
                if references
                    .get(&relative)
                    .is_some_and(|previous| previous != part)
                {
                    return Err(AppCommandError::invalid_input(
                        "DSH attachment references disagree",
                    ));
                }
                references.insert(relative, part.clone());
            }
        }
    }
    Ok(references)
}

pub(super) fn read_snapshot(path: &Path, env: &AgentEnv) -> Result<Vec<u8>, AppCommandError> {
    snapshot_log(&read(path)?, env)
}

fn snapshot_log(log: &[u8], env: &AgentEnv) -> Result<Vec<u8>, AppCommandError> {
    let root = crate::parsers::deepseek::resolve_deepseek_attachments_root_for_env(env);
    let mut assets = Vec::new();
    for (relative, part) in referenced_attachments(log)? {
        let path = root.join(&relative);
        let data = match std::fs::metadata(&path) {
            Ok(metadata)
                if metadata.is_file()
                    && metadata.len() <= crate::web::handlers::files::UPLOAD_MAX_BYTES =>
            {
                Some(STANDARD.encode(std::fs::read(path).map_err(AppCommandError::io)?))
            }
            Ok(_) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(AppCommandError::io(error)),
        };
        assets.push(json!({"relative":relative,"part":part,"data":data}));
    }
    serde_json::to_vec(&json!({
        "format":"dsh-undo-v1",
        "log":std::str::from_utf8(log).map_err(|error|failed(error.to_string()))?,
        "attachmentRoot":root,
        "assets":assets,
    }))
    .map_err(|error| failed(error.to_string()))
}

fn decode_snapshot(bytes: &[u8]) -> Option<Value> {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .filter(|value| value["format"] == "dsh-undo-v1")
}

pub(super) fn history_digest(bytes: &[u8]) -> String {
    if let Some(value) = decode_snapshot(bytes) {
        if value["assets"].as_array().is_some_and(Vec::is_empty) {
            return super::history::digest(value["log"].as_str().unwrap_or_default().as_bytes());
        }
    }
    super::history::digest(bytes)
}

pub(super) fn reverted_matches(bytes: &[u8], expected: &str) -> bool {
    let Some(mut snapshot) = decode_snapshot(bytes) else {
        return false;
    };
    let Some(log) = snapshot["log"].as_str() else {
        return false;
    };
    let Some((prefix, last)) = log.strip_suffix('\n').and_then(|log| log.rsplit_once('\n')) else {
        return false;
    };
    let Ok(marker) = serde_json::from_str::<Value>(last) else {
        return false;
    };
    let next_seq = prefix
        .rsplit('\n')
        .next()
        .and_then(|line| serde_json::from_str::<Value>(line).ok())
        .and_then(|event| {
            if event["type"] == "session" {
                Some(0)
            } else {
                event["seq"].as_u64()?.checked_add(1)
            }
        });
    // 原生重连只追加空的种子结束标记；仅忽略这一条尾部记录，仍核对完整前缀和附件。
    if marker.as_object().is_none_or(|fields| fields.len() != 4)
        || marker["type"] != "session/end-seed"
        || marker["data"]
            .as_object()
            .is_none_or(|data| !data.is_empty())
        || marker["time"].as_i64().is_none()
        || next_seq.is_none()
        || marker["seq"].as_u64() != next_seq
    {
        return false;
    }
    snapshot["log"] = json!(format!("{prefix}\n"));
    serde_json::to_vec(&snapshot).is_ok_and(|snapshot| history_digest(&snapshot) == expected)
}

fn verified_attachment(part: &Value, bytes: &[u8]) -> Result<(), AppCommandError> {
    let reference = &part["attachment"];
    let expected = reference["attachmentId"].as_str().unwrap_or_default();
    let media_type = reference["mediaType"].as_str().unwrap_or_default();
    let image_matches = if part["type"] == "image" {
        image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .ok()
            .is_some_and(|reader| {
                let correct_format = reader
                    .format()
                    .is_some_and(|format| format.to_mime_type() == media_type);
                correct_format
                    && reader.into_dimensions().is_ok_and(|(width, height)| {
                        reference["width"].as_u64() == Some(u64::from(width))
                            && reference["height"].as_u64() == Some(u64::from(height))
                    })
            })
    } else {
        true
    };
    if format!("sha256:{:x}", Sha256::digest(bytes)) != expected
        || reference["bytes"].as_u64() != Some(bytes.len() as u64)
        || !image_matches
        || (part["type"] == "image"
            && (!matches!(
                media_type,
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            ) || reference["width"].as_u64().is_none_or(|width| width == 0)
                || reference["height"]
                    .as_u64()
                    .is_none_or(|height| height == 0)))
    {
        return Err(AppCommandError::invalid_input(format!(
            "{}: original DSH attachment is missing or failed integrity verification",
            reference["name"].as_str().unwrap_or("DSH attachment")
        )));
    }
    Ok(())
}

fn restore_assets(current: &Value, target: &Value) -> Result<(), AppCommandError> {
    use std::io::Write;
    if current["attachmentRoot"] != target["attachmentRoot"] {
        return Err(super::history::conflict());
    }
    let root = PathBuf::from(
        current["attachmentRoot"]
            .as_str()
            .ok_or_else(|| failed("DSH attachment root missing"))?,
    );
    let mut missing = Vec::new();
    for asset in target["assets"]
        .as_array()
        .ok_or_else(|| failed("DSH attachment backup missing"))?
    {
        let relative = object_relative(&asset["part"])?;
        if serde_json::to_value(&relative).map_err(|error| failed(error.to_string()))?
            != asset["relative"]
        {
            return Err(failed("DSH attachment backup path is invalid"));
        }
        let bytes = STANDARD
            .decode(asset["data"].as_str().unwrap_or_default())
            .map_err(|_| failed("DSH attachment backup is damaged"))?;
        verified_attachment(&asset["part"], &bytes)?;
        let path = root.join(relative);
        match std::fs::read(&path) {
            Ok(current) if current == bytes => {}
            Ok(_) => return Err(super::history::conflict()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push((path, bytes))
            }
            Err(error) => return Err(AppCommandError::io(error)),
        }
    }
    for (path, bytes) in missing {
        let directory = path
            .parent()
            .ok_or_else(|| failed("DSH attachment directory missing"))?;
        std::fs::create_dir_all(directory).map_err(AppCommandError::io)?;
        let mut staged = tempfile::NamedTempFile::new_in(directory).map_err(AppCommandError::io)?;
        staged.write_all(&bytes).map_err(AppCommandError::io)?;
        staged.as_file().sync_all().map_err(AppCommandError::io)?;
        if let Err(error) = staged.persist_noclobber(&path) {
            if std::fs::read(&path).map_err(AppCommandError::io)? != bytes {
                return Err(AppCommandError::io(error.error));
            }
        }
    }
    Ok(())
}

pub(super) fn publish(
    path: &Path,
    env: &AgentEnv,
    expected: &[u8],
    replacement: &[u8],
) -> Result<(), AppCommandError> {
    let directory = path
        .parent()
        .ok_or_else(|| failed("DeepSeek log directory is missing"))?;
    let _writer = writer_guard(&directory.join("session.lock"))?;
    let current = read_snapshot(path, env)?;
    if history_digest(&current) != history_digest(expected) {
        return Err(super::history::conflict());
    }
    let target = decode_snapshot(replacement);
    if let Some(target) = &target {
        restore_assets(&decode_snapshot(&current).unwrap(), target)?;
    }
    let replacement = target
        .as_ref()
        .and_then(|value| value["log"].as_str())
        .map(str::as_bytes)
        .unwrap_or(replacement);
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

fn writer_busy() -> AppCommandError {
    AppCommandError::new(
        AppErrorCode::TurnInProgress,
        "DSH still has an active native writer; conversation history has been kept",
    )
}

#[cfg(windows)]
struct WriterGuard(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for WriterGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Threading::ReleaseSemaphore(
                self.0,
                1,
                std::ptr::null_mut(),
            );
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn writer_guard(path: &Path) -> Result<WriterGuard, AppCommandError> {
    use sha2::{Digest, Sha256};
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{CreateSemaphoreW, WaitForSingleObject};
    let absolute = std::path::absolute(path).map_err(AppCommandError::io)?;
    let mut path = PathBuf::new();
    for component in crate::paths::simplify_verbatim_path(&absolute).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                path.pop();
            }
            component => path.push(component.as_os_str()),
        }
    }
    let identity = path.to_string_lossy().to_lowercase();
    // 原生使用 path.resolve 而不是 realpath；解析 junction 会得到另一个锁名，导致误放行。
    // Windows 持有命名信号量，文件锁不与其互斥，名称必须完全复用原生算法。
    let name = format!(
        "Local\\dsh-session-lock-{:x}",
        Sha256::digest(identity.as_bytes())
    );
    let name = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    unsafe {
        let handle = CreateSemaphoreW(std::ptr::null(), 1, 1, name.as_ptr());
        if handle.is_null() {
            return Err(AppCommandError::io(std::io::Error::last_os_error()));
        }
        if WaitForSingleObject(handle, 0) == WAIT_OBJECT_0 {
            Ok(WriterGuard(handle))
        } else {
            CloseHandle(handle);
            Err(writer_busy())
        }
    }
}

#[cfg(not(windows))]
fn writer_guard(path: &Path) -> Result<std::fs::File, AppCommandError> {
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(AppCommandError::io)?;
    lock.try_lock().map_err(|_| writer_busy())?;
    Ok(lock)
}

pub(super) fn replacement(
    env: &AgentEnv,
    session: &str,
    prompt: &MessageTurn,
) -> Result<(PathBuf, Vec<u8>, Vec<u8>), AppCommandError> {
    let path = path(env, session)?;
    let original = read_snapshot(&path, env)?;
    let value = decode_snapshot(&original).ok_or_else(|| failed("DSH snapshot is invalid"))?;
    let log = value["log"]
        .as_str()
        .ok_or_else(|| failed("DSH native log is missing"))?;
    let text = prompt
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let raw = log;
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
            let root = crate::parsers::deepseek::resolve_deepseek_attachments_root_for_env(env);
            let texts = content
                .as_array()
                .into_iter()
                .flatten()
                .filter(|part| part["type"] == "text")
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let mut projected = if texts.trim().is_empty() {
                Vec::new()
            } else {
                vec![texts]
            };
            for part in content
                .as_array()
                .into_iter()
                .flatten()
                .filter(|part| matches!(part["type"].as_str(), Some("image" | "file")))
            {
                if part["type"] == "file" {
                    projected.push(format!(
                        "@{}",
                        part["attachment"]["name"].as_str().unwrap_or("file")
                    ));
                    continue;
                }
                if let ContentBlock::Text { text } =
                    crate::parsers::deepseek::attachment_image_block(
                        part.get("attachment"),
                        Some(&root),
                    )
                {
                    projected.push(text);
                }
            }
            if projected.join("\n") == text
                && value["time"].as_i64() == Some(prompt.timestamp.timestamp_millis())
            {
                if content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|part| !matches!(part["type"].as_str(), Some("text" | "image" | "file")))
                {
                    return Err(AppCommandError::invalid_input(
                        "The original DeepSeek attachment needs a verified content snapshot",
                    ));
                }
                original_input(env, content)?;
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
    let replacement = snapshot_log(&log.as_bytes()[..*offset], env)?;
    Ok((path, original, replacement))
}

fn original_input(
    env: &AgentEnv,
    content: &Value,
) -> Result<Vec<PromptInputBlock>, AppCommandError> {
    let root = crate::parsers::deepseek::resolve_deepseek_attachments_root_for_env(env);
    content
        .as_array()
        .ok_or_else(|| failed("DSH original input is invalid"))?
        .iter()
        .map(|part| match part["type"].as_str() {
            Some("text") => Ok(PromptInputBlock::Text {
                text: part["text"]
                    .as_str()
                    .ok_or_else(|| failed("DSH text is invalid"))?
                    .to_owned(),
            }),
            Some("image" | "file") => {
                let relative = object_relative(part)?;
                let path = root.join(relative);
                let label = part["attachment"]["name"]
                    .as_str()
                    .unwrap_or("DSH attachment");
                let metadata = std::fs::metadata(&path).map_err(|_| {
                    AppCommandError::invalid_input(format!(
                        "{label}: original DSH attachment is missing"
                    ))
                })?;
                if metadata.len() > crate::web::handlers::files::UPLOAD_MAX_BYTES {
                    return Err(AppCommandError::invalid_input(format!(
                        "{label}: attachment exceeds the upload limit"
                    )));
                }
                let bytes = std::fs::read(path).map_err(AppCommandError::io)?;
                verified_attachment(part, &bytes)?;
                if part["type"] == "file" {
                    return Ok(PromptInputBlock::Resource {
                        uri: format!("attachment://{label}"),
                        mime_type: attachment_mime(label),
                        text: None,
                        blob: Some(STANDARD.encode(bytes)),
                    });
                }
                Ok(PromptInputBlock::Image {
                    data: STANDARD.encode(bytes),
                    mime_type: part["attachment"]["mediaType"].as_str().unwrap().to_owned(),
                    uri: None,
                })
            }
            _ => Err(AppCommandError::invalid_input(
                "This DSH input kind needs verified restoration",
            )),
        })
        .collect()
}

fn attachment_mime(name: &str) -> Option<String> {
    let extension = Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    let mime = match extension.as_str() {
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    };
    Some(mime.to_owned())
}

pub(super) fn input(
    env: &AgentEnv,
    session: &str,
    prompt: &MessageTurn,
) -> Result<Vec<PromptInputBlock>, AppCommandError> {
    replacement(env, session, prompt)?;
    let log = read(&path(env, session)?)?;
    let raw = std::str::from_utf8(&log).map_err(|error| failed(error.to_string()))?;
    let matches = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|event| {
            event["type"] == "user/message"
                && event["data"]["source"]["kind"] == "user"
                && event["time"].as_i64() == Some(prompt.timestamp.timestamp_millis())
        })
        .collect::<Vec<_>>();
    let [event] = matches.as_slice() else {
        return Err(AppCommandError::invalid_input(
            "DSH original input is ambiguous",
        ));
    };
    original_input(env, &event["data"]["content"])
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
