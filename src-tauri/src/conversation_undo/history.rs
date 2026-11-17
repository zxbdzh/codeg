use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::acp::manager::ConnectionManager;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::service::{agent_setting_service, conversation_service};
use crate::db::AppDatabase;
use crate::models::{AgentType, ContentBlock, MessageTurn};

use super::{failed, preview, PreviewRequest};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitRequest {
    pub conversation_id: i32,
    pub source_turn_id: String,
    pub history_revision: String,
    #[serde(default)]
    pub current_draft: Option<crate::commands::prompt_stash::StashSnapshot>,
    #[serde(default)]
    pub stop_confirmed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub conversation_id: i32,
    pub session_id: String,
    pub prompt: MessageTurn,
    pub input: Vec<crate::acp::types::PromptInputBlock>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationRequest {
    pub conversation_id: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedoStatus {
    pub available: bool,
    pub has_backup: bool,
    pub expires_at: Option<String>,
}

pub async fn redo_status(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: ConversationRequest,
) -> Result<RedoStatus, AppCommandError> {
    let _backup_guard = super::operations::backup(manager, request.conversation_id)?;
    let row = conversation_service::get_by_id(&db.conn, request.conversation_id)
        .await
        .map_err(AppCommandError::from)?;
    let path = backup_path(data_dir, request.conversation_id);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RedoStatus {
                available: false,
                has_backup: false,
                expires_at: None,
            });
        }
        Err(error) => return Err(AppCommandError::io(error)),
    };
    let backup: Value =
        serde_json::from_slice(&bytes).map_err(|error| failed(error.to_string()))?;
    let expires_at = backup["expiresAt"]
        .as_str()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
    if expires_at.is_some_and(|expires_at| expires_at <= Utc::now()) {
        // 与撤回、恢复共用操作锁，避免清理刚被下一次 Undo 替换的新备份。
        std::fs::remove_file(&path).map_err(AppCommandError::io)?;
        return Ok(RedoStatus {
            available: false,
            has_backup: false,
            expires_at: None,
        });
    }
    let env = agent_setting_service::load_agent_env(&db.conn, row.agent_type).await;
    if row.agent_type == AgentType::Codex {
        return Ok(RedoStatus {
            available: row
                .external_id
                .as_deref()
                .is_some_and(|session_id| super::codex::redo_available(&env, session_id, &backup)),
            has_backup: true,
            expires_at: expires_at.map(|value| value.to_rfc3339()),
        });
    }
    let native = match (row.agent_type, row.external_id.as_deref()) {
        (agent_type, Some(session_id))
            if backup["version"] == 1
                && backup["sessionId"] == session_id
                && backup["agentType"] == agent_type.as_wire().as_ref() =>
        {
            native_path(agent_type, &env, session_id).ok()
        }
        _ => None,
    };
    let available = native
        .and_then(|path| {
            read_native(
                row.agent_type,
                &path,
                row.external_id.as_deref().unwrap_or_default(),
            )
            .ok()
        })
        .is_some_and(|current| backup["revertedDigest"] == digest(&current));
    Ok(RedoStatus {
        available: available && expires_at.is_some(),
        has_backup: true,
        expires_at: expires_at.map(|value| value.to_rfc3339()),
    })
}

pub async fn clear_redo(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: ConversationRequest,
) -> Result<(), AppCommandError> {
    let _backup_guard = super::operations::backup(manager, request.conversation_id)?;
    conversation_service::get_by_id(&db.conn, request.conversation_id)
        .await
        .map_err(AppCommandError::from)?;
    match std::fs::remove_file(backup_path(data_dir, request.conversation_id)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppCommandError::io(error)),
    }
}

pub async fn redo(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: ConversationRequest,
) -> Result<super::UndoResult, AppCommandError> {
    let _backup_guard = super::operations::backup(manager, request.conversation_id)?;
    let row = conversation_service::get_by_id(&db.conn, request.conversation_id)
        .await
        .map_err(AppCommandError::from)?;
    let backup_file = backup_path(data_dir, request.conversation_id);
    let backup: Value =
        serde_json::from_slice(&std::fs::read(&backup_file).map_err(AppCommandError::io)?)
            .map_err(|error| failed(error.to_string()))?;
    let session_id = row
        .external_id
        .ok_or_else(|| AppCommandError::invalid_input("The conversation has no saved session"))?;
    let _spawn_guard = super::operations::begin(manager, row.agent_type, &session_id)?;
    if backup["version"] != 1
        || backup["conversationId"] != request.conversation_id
        || backup["sessionId"] != session_id
        || backup["agentType"] != row.agent_type.as_wire().as_ref()
    {
        return Err(AppCommandError::invalid_input(
            "Redo backup does not belong to this session",
        ));
    }
    let expires_at = backup["expiresAt"]
        .as_str()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .ok_or_else(|| failed("Redo backup has no valid expiration"))?;
    if expires_at <= Utc::now() {
        return Err(AppCommandError::invalid_input("Redo backup has expired"));
    }
    let original = backup["original"]
        .as_str()
        .ok_or_else(|| failed("Redo backup is incomplete"))?
        .as_bytes();
    if backup["originalDigest"] != digest(original) {
        return Err(failed("Redo backup is damaged"));
    }
    if row.agent_type == AgentType::Codex {
        let db = AppDatabase {
            conn: db.conn.clone(),
        };
        let manager = manager.clone_ref();
        let data_dir = data_dir.to_path_buf();
        let backup = backup.clone();
        return tokio::spawn(async move {
            let _guard = _spawn_guard;
            let _backup_guard = _backup_guard;
            super::codex::redo(&db, &manager, &data_dir, request, backup).await
        })
        .await
        .map_err(|error| failed(error.to_string()))?;
    }
    let env = agent_setting_service::load_agent_env(&db.conn, row.agent_type).await;
    let path = native_path(row.agent_type, &env, &session_id)?;
    if backup["path"].as_str() != path.to_str() {
        return Err(conflict());
    }
    let current = read_native(row.agent_type, &path, &session_id)?;
    if backup["revertedDigest"] != digest(&current) {
        return Err(conflict());
    }
    let connections = {
        let connections = manager.connections.lock().await;
        connections
            .values()
            .map(|connection| {
                (
                    connection.id.clone(),
                    connection.state.clone(),
                    connection.prompt_lock.clone(),
                    connection.child_pid.clone(),
                )
            })
            .collect::<Vec<_>>()
    };
    let mut guards = Vec::new();
    for (connection_id, state, prompt_lock, pid) in connections {
        let state = state.read().await;
        if state.agent_type != row.agent_type || state.external_id.as_deref() != Some(&session_id) {
            continue;
        }
        let guard = prompt_lock.try_lock_owned().map_err(|_| {
            AppCommandError::new(
                AppErrorCode::TurnInProgress,
                "Session work is still running",
            )
        })?;
        if state.turn_in_flight
            || state.agent_initiated_turn
            || state.live_message.is_some()
            || !state.active_tool_calls.is_empty()
            || !state.active_delegations.is_empty()
            || state.background_outstanding > 0
            || state.pending_permission.is_some()
            || state.pending_question.is_some()
            || state.pending_plan_approval.is_some()
            || state.remote_control.is_some()
            || state
                .async_tasks
                .values()
                .any(|task| !crate::acp::types::async_task_state_is_terminal(&task.state))
        {
            return Err(AppCommandError::new(
                AppErrorCode::TurnInProgress,
                "Session work must stop before Redo",
            ));
        }
        drop(state);
        guards.push(guard);
        manager
            .disconnect(&connection_id)
            .await
            .map_err(|error| failed(error.to_string()))?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while pid.load(Ordering::SeqCst) != 0 {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .map_err(|_| failed("The previous session is still shutting down"))?;
    }
    // 已续聊或被原生 CLI 改动的历史不能被备份覆盖，退出旧连接后再核对一次。
    if read_native(row.agent_type, &path, &session_id)? != current {
        return Err(conflict());
    }
    publish_native(row.agent_type, &path, &session_id, &current, original)?;
    if let Err(error) = std::fs::remove_file(&backup_file) {
        // 历史已恢复，清理失败不把成功恢复报告为失败；指纹校验会阻止再次恢复。
        tracing::warn!(%error, "could not consume Redo backup");
    }
    Ok(super::UndoResult {
        conversation_id: request.conversation_id,
        session_id,
    })
}

pub(super) fn conflict() -> AppCommandError {
    AppCommandError::invalid_input("Conversation history changed; refresh and confirm Undo again")
        .with_i18n("historyChanged", Default::default())
}

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppCommandError> {
    let parent = path
        .parent()
        .ok_or_else(|| failed("History path has no parent"))?;
    std::fs::create_dir_all(parent).map_err(AppCommandError::io)?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(AppCommandError::io)?;
    staged.write_all(bytes).map_err(AppCommandError::io)?;
    staged.as_file().sync_all().map_err(AppCommandError::io)?;
    staged
        .persist(path)
        .map_err(|error| AppCommandError::io(error.error))?;
    Ok(())
}

pub(super) fn backup_path(data_dir: &Path, conversation_id: i32) -> PathBuf {
    data_dir
        .join("conversation-undo")
        .join(format!("{conversation_id}.json"))
}

pub async fn commit(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    mut request: CommitRequest,
    allow_local_paths: bool,
) -> Result<CommitResult, AppCommandError> {
    let mut selected = preview(
        db,
        manager,
        PreviewRequest {
            conversation_id: request.conversation_id,
            source_turn_id: request.source_turn_id.clone(),
        },
    )
    .await?;
    let _backup_guard = super::operations::backup(manager, request.conversation_id)?;
    let _spawn_guard = super::operations::begin(
        manager,
        conversation_service::get_by_id(&db.conn, request.conversation_id)
            .await
            .map_err(AppCommandError::from)?
            .agent_type,
        &selected.session_id,
    )?;
    if !selected.issues.is_empty() {
        return Err(AppCommandError::invalid_input(
            "The original input cannot be fully restored; resolve the listed issues before Undo",
        )
        .with_detail(
            serde_json::to_string(&selected.issues).map_err(|error| failed(error.to_string()))?,
        ));
    }
    if selected.history_revision != request.history_revision {
        return Err(conflict());
    }
    let row = conversation_service::get_by_id(&db.conn, request.conversation_id)
        .await
        .map_err(AppCommandError::from)?;
    if request.stop_confirmed
        && matches!(
            row.agent_type,
            AgentType::ClaudeCode
                | AgentType::Codex
                | AgentType::Gemini
                | AgentType::Pi
                | AgentType::Hermes
                | AgentType::OpenCode
                | AgentType::DeepSeek
        )
    {
        super::stop::stop_work(db, manager, row.agent_type, &selected.session_id).await?;
    }
    // 停止任务会等待原生进程落盘；等待期间其他客户端修改的历史同样必须拒绝。
    let stopped = preview(
        db,
        manager,
        PreviewRequest {
            conversation_id: request.conversation_id,
            source_turn_id: request.source_turn_id.clone(),
        },
    )
    .await?;
    let confirmed_running_turn =
        request.stop_confirmed && selected.tasks.iter().any(|task| task.kind == "turn");
    if stopped.history_revision != selected.history_revision
        && !(confirmed_running_turn
            && stopped.history_anchor_revision == selected.history_anchor_revision)
    {
        return Err(conflict());
    }
    request.history_revision = stopped.history_revision.clone();
    selected = stopped;
    if row.agent_type == AgentType::Codex {
        let db = AppDatabase {
            conn: db.conn.clone(),
        };
        let manager = manager.clone_ref();
        let data_dir = data_dir.to_path_buf();
        return tokio::spawn(async move {
            let _guard = _spawn_guard;
            let _backup_guard = _backup_guard;
            super::codex::commit(
                &db,
                &manager,
                &data_dir,
                request,
                selected,
                allow_local_paths,
            )
            .await
        })
        .await
        .map_err(|error| failed(error.to_string()))?;
    }
    let env = agent_setting_service::load_agent_env(&db.conn, row.agent_type).await;
    let (path, original, replacement) = match row.agent_type {
        AgentType::ClaudeCode => {
            let path = native_path(row.agent_type, &env, &selected.session_id)?;
            let original = std::fs::read(&path).map_err(AppCommandError::io)?;
            let replacement = claude_prefix(&original, &selected.prompt)?;
            (path, original, replacement)
        }
        AgentType::Gemini => {
            super::gemini::replacement(&env, &selected.session_id, &selected.prompt)?
        }
        AgentType::Pi => super::pi::replacement(&env, &selected.session_id, &selected.prompt)?,
        AgentType::Hermes => {
            super::hermes::replacement(&env, &selected.session_id, &selected.prompt)?
        }
        AgentType::OpenCode => {
            super::opencode::replacement(&env, &selected.session_id, &selected.prompt)?
        }
        AgentType::DeepSeek => {
            super::deepseek::replacement(&env, &selected.session_id, &selected.prompt)?
        }
        _ => {
            return Err(AppCommandError::invalid_input(
                "Precise history Undo has not been verified for this agent",
            ))
        }
    };
    let entries = {
        let connections = manager.connections.lock().await;
        connections
            .values()
            .map(|connection| {
                (
                    connection.id.clone(),
                    connection.state.clone(),
                    connection.prompt_lock.clone(),
                    connection.child_pid.clone(),
                )
            })
            .collect::<Vec<_>>()
    };
    let mut guards = Vec::new();
    for (connection_id, state, prompt_lock, pid) in entries {
        let state = state.read().await;
        if state.agent_type != row.agent_type
            || state.external_id.as_deref() != Some(&selected.session_id)
        {
            continue;
        }
        let guard = prompt_lock.try_lock_owned().map_err(|_| {
            AppCommandError::new(
                AppErrorCode::TurnInProgress,
                "Session work is still running",
            )
        })?;
        if state.turn_in_flight
            || state.agent_initiated_turn
            || state.live_message.is_some()
            || !state.active_tool_calls.is_empty()
            || !state.active_delegations.is_empty()
            || state.background_outstanding > 0
            || state.pending_permission.is_some()
            || state.pending_question.is_some()
            || state.pending_plan_approval.is_some()
            || state.remote_control.is_some()
            || state
                .async_tasks
                .values()
                .any(|task| !crate::acp::types::async_task_state_is_terminal(&task.state))
        {
            return Err(AppCommandError::new(
                AppErrorCode::TurnInProgress,
                "Session work must stop before Undo",
            ));
        }
        drop(state);
        guards.push(guard);
        manager
            .disconnect(&connection_id)
            .await
            .map_err(|error| failed(error.to_string()))?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while pid.load(Ordering::SeqCst) != 0 {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .map_err(|_| failed("The previous session is still shutting down"))?;
    }
    if read_native(row.agent_type, &path, &selected.session_id)? != original {
        return Err(conflict());
    }
    if let Some(draft) = request.current_draft {
        // 复用现有收藏的附件副本与去重规则；收藏失败时不修改原生历史。
        crate::commands::prompt_stash::save_core(
            db,
            &crate::commands::prompt_stash::stash_root(),
            draft,
            allow_local_paths,
            format!("conv:{}", request.conversation_id),
            None,
        )
        .await?;
    }
    let now = Utc::now();
    let input = super::input::snapshot(data_dir, selected.input)?;
    // 原生历史落盘前先持久化原文；备份失败时绝不截断有效对话。
    let backup = json!({
        "version": 1,
        "conversationId": request.conversation_id,
        "agentType": row.agent_type,
        "sessionId": selected.session_id,
        "createdAt": now,
        "expiresAt": now + chrono::Duration::days(7),
        "path": path,
        "original": String::from_utf8(original.clone()).map_err(|error| failed(error.to_string()))?,
        "originalDigest": digest(&original),
        "revertedDigest": digest(&replacement),
    });
    atomic_write(
        &backup_path(data_dir, request.conversation_id),
        &serde_json::to_vec(&backup).map_err(|error| failed(error.to_string()))?,
    )?;
    if read_native(row.agent_type, &path, &selected.session_id)? != original {
        return Err(conflict());
    }
    publish_native(
        row.agent_type,
        &path,
        &selected.session_id,
        &original,
        &replacement,
    )?;
    Ok(CommitResult {
        conversation_id: request.conversation_id,
        session_id: selected.session_id,
        prompt: selected.prompt,
        input,
    })
}

fn native_path(
    agent_type: AgentType,
    env: &crate::parsers::AgentEnv,
    session_id: &str,
) -> Result<PathBuf, AppCommandError> {
    match agent_type {
        AgentType::ClaudeCode => claude_path(
            &crate::parsers::claude::resolve_claude_projects_dir_for_env(env),
            session_id,
        ),
        AgentType::Gemini => super::gemini::path(env, session_id),
        AgentType::Pi => super::pi::path(env, session_id),
        AgentType::Hermes => Ok(super::hermes::path(env)),
        AgentType::OpenCode => super::opencode::path(env),
        AgentType::DeepSeek => super::deepseek::path(env, session_id),
        _ => Err(AppCommandError::invalid_input(
            "Precise history Undo has not been verified for this agent",
        )),
    }
}

fn read_native(
    agent: AgentType,
    path: &Path,
    session_id: &str,
) -> Result<Vec<u8>, AppCommandError> {
    match agent {
        AgentType::Hermes => super::hermes::read(path, session_id),
        AgentType::OpenCode => super::opencode::read(path, session_id),
        AgentType::DeepSeek => super::deepseek::read(path),
        _ => std::fs::read(path).map_err(AppCommandError::io),
    }
}

fn publish_native(
    agent: AgentType,
    path: &Path,
    session_id: &str,
    expected: &[u8],
    replacement: &[u8],
) -> Result<(), AppCommandError> {
    match agent {
        AgentType::Hermes => super::hermes::publish(path, session_id, expected, replacement),
        AgentType::OpenCode => super::opencode::publish(path, session_id, expected, replacement),
        AgentType::DeepSeek => super::deepseek::publish(path, expected, replacement),
        _ => {
            if read_native(agent, path, session_id)? != expected {
                return Err(conflict());
            }
            atomic_write(path, replacement)
        }
    }
}

fn claude_path(projects: &Path, session_id: &str) -> Result<PathBuf, AppCommandError> {
    if session_id.is_empty()
        || session_id.starts_with('.')
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AppCommandError::invalid_input("Invalid session identity"));
    }
    for project in std::fs::read_dir(projects).map_err(AppCommandError::io)? {
        let project = project.map_err(AppCommandError::io)?;
        if project.file_type().map_err(AppCommandError::io)?.is_dir() {
            let candidate = project.path().join(format!("{session_id}.jsonl"));
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(AppCommandError::not_found(
        "Native session history is missing",
    ))
}

pub(super) fn attachment_issues(
    agent_type: AgentType,
    env: &crate::parsers::AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<Vec<super::UndoIssue>, AppCommandError> {
    use base64::Engine;
    let path = native_path(agent_type, env, session_id)?;
    let original = std::fs::read(path).map_err(AppCommandError::io)?;
    let prefix = match claude_prefix(&original, prompt) {
        Ok(prefix) => prefix,
        Err(error) => {
            return Ok(vec![super::UndoIssue {
                code: "boundary_unavailable".into(),
                label: error.message,
            }])
        }
    };
    let source = std::str::from_utf8(&original[prefix.len()..])
        .map_err(|error| failed(error.to_string()))?;
    let record: Value = serde_json::from_str(source.lines().next().unwrap_or_default())
        .map_err(|error| failed(error.to_string()))?;
    let mut issues = Vec::new();
    for (index, block) in record["message"]["content"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let kind = block["type"].as_str().unwrap_or_default();
        if kind == "text" {
            continue;
        }
        let label = block["name"]
            .as_str()
            .or_else(|| block["title"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{kind} #{}", index + 1));
        if kind == "image" || kind == "document" {
            // 只认可历史中的原始字节，不拿同一路径后来修改的文件冒充原附件。
            let data = block["source"]["data"]
                .as_str()
                .or_else(|| block["data"].as_str())
                .unwrap_or_default();
            let data = data
                .strip_prefix("data:")
                .and_then(|data| data.split_once(";base64,").map(|(_, data)| data))
                .unwrap_or(data);
            if !(kind == "document" && block["source"]["type"] == "text" && !data.is_empty())
                && (data.is_empty()
                    || base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .is_err())
            {
                issues.push(super::UndoIssue {
                    code: "missing_original_attachment".into(),
                    label,
                });
            }
        } else {
            issues.push(super::UndoIssue {
                code: "unsupported_original_attachment".into(),
                label,
            });
        }
    }
    Ok(issues)
}

pub(super) fn claude_input(
    agent_type: AgentType,
    env: &crate::parsers::AgentEnv,
    session_id: &str,
    prompt: &MessageTurn,
) -> Result<Vec<crate::acp::types::PromptInputBlock>, AppCommandError> {
    use crate::acp::types::PromptInputBlock;
    let original =
        std::fs::read(native_path(agent_type, env, session_id)?).map_err(AppCommandError::io)?;
    let prefix = claude_prefix(&original, prompt)?;
    let source = std::str::from_utf8(&original[prefix.len()..])
        .map_err(|error| failed(error.to_string()))?;
    let record: Value = serde_json::from_str(source.lines().next().unwrap_or_default())
        .map_err(|error| failed(error.to_string()))?;
    let mut input = Vec::new();
    for block in record["message"]["content"]
        .as_array()
        .into_iter()
        .flatten()
    {
        match block["type"].as_str() {
            Some("text") => input.push(PromptInputBlock::Text {
                text: block["text"].as_str().unwrap_or_default().to_owned(),
            }),
            Some("image") => {
                let source = &block["source"];
                input.push(PromptInputBlock::Image {
                    data: source["data"].as_str().unwrap_or_default().to_owned(),
                    mime_type: source["media_type"]
                        .as_str()
                        .unwrap_or("image/png")
                        .to_owned(),
                    uri: None,
                });
            }
            Some("document") => {
                let source = &block["source"];
                let text = (source["type"] == "text")
                    .then(|| source["data"].as_str().unwrap_or_default().to_owned());
                input.push(PromptInputBlock::Resource {
                    uri: format!(
                        "attachment://{}",
                        block["title"].as_str().unwrap_or("attachment.bin")
                    ),
                    mime_type: source["media_type"].as_str().map(str::to_owned),
                    blob: text
                        .is_none()
                        .then(|| source["data"].as_str().unwrap_or_default().to_owned()),
                    text,
                });
            }
            _ => {}
        }
    }
    Ok(input)
}

fn claude_prefix(original: &[u8], prompt: &MessageTurn) -> Result<Vec<u8>, AppCommandError> {
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
    let mut candidates = Vec::new();
    for line in original.split_inclusive('\n') {
        let value: Value = serde_json::from_str(line).map_err(|error| failed(error.to_string()))?;
        let same_id = prompt
            .agent_message_id
            .as_deref()
            .is_some_and(|id| value["uuid"].as_str() == Some(id));
        let same_time = value["timestamp"]
            .as_str()
            .and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
            .is_some_and(|timestamp| timestamp == prompt.timestamp);
        let same_text = value["message"]["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
                    == text
            })
            .unwrap_or(false);
        let matches = if prompt.agent_message_id.is_some() {
            same_id
        } else {
            same_time && same_text
        };
        if value["type"] == "user" && matches {
            candidates.push(offset);
        }
        offset += line.len();
    }
    // 文本和时间可能重复；无法唯一定位时宁可暂停，也不能截掉更早的对话。
    if let [offset] = candidates.as_slice() {
        return Ok(original.as_bytes()[..*offset].to_vec());
    }
    Err(AppCommandError::invalid_input(
        "The exact saved user message could not be uniquely located",
    ))
}
