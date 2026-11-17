use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use chrono::{Local, Utc};
use serde_json::{json, Value};

use crate::acp::manager::ConnectionManager;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::service::agent_setting_service;
use crate::db::AppDatabase;
use crate::models::{AgentType, ConversationDetail};
use crate::parsers::{codex::CodexParser, AgentEnv, AgentParser};

use super::history::{
    atomic_write, backup_path, digest, CommitRequest, CommitResult, ConversationRequest,
};
use super::{failed, HistoryClient, UndoPreview, UndoResult};

fn changed() -> AppCommandError {
    super::history::conflict()
}

fn history(
    env: &AgentEnv,
    session_id: &str,
) -> Result<(ConversationDetail, String), AppCommandError> {
    let detail = CodexParser::for_env(env)
        .get_conversation(session_id)
        .map_err(|error| failed(error.to_string()))?;
    if detail.summary.id != session_id {
        return Err(changed());
    }
    let revision =
        digest(&serde_json::to_vec(&detail.turns).map_err(|error| failed(error.to_string()))?);
    Ok((detail, revision))
}

async fn client(
    db: &AppDatabase,
    data_dir: &Path,
    session_id: &str,
) -> Result<HistoryClient, AppCommandError> {
    let runtime = crate::acp::codex_runtime::current().await;
    let program = runtime
        .codex_js
        .ok_or_else(|| failed("The Codex runtime could not be located"))?;
    let env = crate::commands::acp::build_session_runtime_env(
        db,
        AgentType::Codex,
        Some(session_id),
        data_dir,
    )
    .await
    .map_err(|error| failed(error.to_string()))?;
    HistoryClient::spawn(&program, env).await
}

async fn disconnect_idle(
    manager: &ConnectionManager,
    session_id: &str,
) -> Result<(), AppCommandError> {
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
    for (id, state, prompt_lock, pid) in entries {
        let state = state.read().await;
        if state.agent_type != AgentType::Codex || state.external_id.as_deref() != Some(session_id)
        {
            continue;
        }
        let guard = prompt_lock.try_lock_owned().map_err(|_| {
            AppCommandError::new(
                AppErrorCode::TurnInProgress,
                "Session work must stop before changing history",
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
                "Session work must stop before changing history",
            ));
        }
        drop(state);
        guards.push(guard);
        manager
            .disconnect(&id)
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
    Ok(())
}

pub(super) async fn commit(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: CommitRequest,
    selected: UndoPreview,
    allow_local_paths: bool,
) -> Result<CommitResult, AppCommandError> {
    disconnect_idle(manager, &selected.session_id).await?;
    let env = agent_setting_service::load_agent_env(&db.conn, AgentType::Codex).await;
    let mut native = client(db, data_dir, &selected.session_id).await?;
    let metadata = native
        .call(
            "thread/read",
            json!({
                "threadId": selected.session_id, "includeTurns": false,
            }),
        )
        .await?;
    if metadata["thread"]["id"] != selected.session_id
        || metadata["thread"]["historyMode"] != "paginated"
    {
        return Err(AppCommandError::invalid_input(
            "This Codex session does not support native Undo",
        ));
    }
    let resumed = native
        .call(
            "thread/resume",
            json!({
                "threadId": selected.session_id, "excludeTurns": true,
            }),
        )
        .await?;
    let (detail, revision) = history(&env, &selected.session_id)?;
    if revision != request.history_revision {
        return Err(changed());
    }
    let index = detail
        .turns
        .iter()
        .position(|turn| turn.id == request.source_turn_id)
        .ok_or_else(changed)?;
    let before_turn = CodexParser::for_env(&env)
        .undo_turn_id(&selected.session_id, &selected.prompt)
        .map_err(|error| failed(error.to_string()))?
        .ok_or_else(|| {
            AppCommandError::invalid_input(
                "This saved Codex message cannot yet be precisely reverted",
            )
        })?;
    let path = resumed["thread"]["path"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(|| failed("Codex did not return a history path"))?;
    let original = std::fs::read(&path).map_err(AppCommandError::io)?;
    if let Some(draft) = request.current_draft {
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
    let expected_revision = digest(
        &serde_json::to_vec(&detail.turns[..index]).map_err(|error| failed(error.to_string()))?,
    );
    let now = Utc::now();
    let mut backup = json!({
        "version": 1, "strategy": "codex-native",
        "conversationId": request.conversation_id, "agentType": "codex",
        "sessionId": selected.session_id, "createdAt": now,
        "expiresAt": now + chrono::Duration::days(7),
        "path": path, "originalPath": path,
        "original": String::from_utf8(original.clone()).map_err(|error| failed(error.to_string()))?,
        "originalDigest": digest(&original), "originalRevision": revision,
        "revertedRevision": expected_revision,
    });
    let saved = backup_path(data_dir, request.conversation_id);
    atomic_write(
        &saved,
        &serde_json::to_vec(&backup).map_err(|error| failed(error.to_string()))?,
    )?;
    if history(&env, &selected.session_id)?.1 != request.history_revision {
        return Err(changed());
    }
    let reverted = native
        .call(
            "thread/revert",
            json!({
                "threadId": selected.session_id, "beforeTurnId": before_turn,
            }),
        )
        .await?;
    if reverted["thread"]["id"] != selected.session_id {
        return Err(failed("Codex returned another session after Undo"));
    }
    backup["path"] = reverted["thread"]["path"].clone();
    native.close().await;
    if history(&env, &selected.session_id)?.1 != expected_revision {
        return Err(failed(
            "Codex did not preserve the confirmed history prefix",
        ));
    }
    atomic_write(
        &saved,
        &serde_json::to_vec(&backup).map_err(|error| failed(error.to_string()))?,
    )?;
    Ok(CommitResult {
        conversation_id: request.conversation_id,
        session_id: selected.session_id,
        prompt: selected.prompt,
    })
}

fn same_path(left: &Path, right: &Path) -> bool {
    matches!((std::fs::canonicalize(left), std::fs::canonicalize(right)), (Ok(left), Ok(right)) if left == right)
}

pub(super) fn redo_available(env: &AgentEnv, session_id: &str, backup: &Value) -> bool {
    let Some(path) = backup["path"].as_str() else {
        return false;
    };
    let current = CodexParser::for_env(env).undo_rollout_path(session_id);
    backup["strategy"] == "codex-native"
        && current.is_some_and(|current| same_path(&current, Path::new(path)))
        && history(env, session_id)
            .is_ok_and(|(_, revision)| backup["revertedRevision"] == revision)
}

struct PublicationGuard {
    _thread: Option<std::fs::File>,
    _coordination: std::fs::File,
}

fn publication_guard(home: &Path, session_id: &str) -> Result<PublicationGuard, AppCommandError> {
    let directory = home.join("thread-writer-locks");
    std::fs::create_dir_all(&directory).map_err(AppCommandError::io)?;
    let coordination = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join(".coordination.lock"))
        .map_err(AppCommandError::io)?;
    coordination
        .try_lock()
        .map_err(|error| failed(format!("Codex history is being published: {error}")))?;
    let thread = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join(format!("{session_id}.lock")))
    {
        Ok(file) => {
            file.try_lock()
                .map_err(|error| failed(format!("Codex still has an active writer: {error}")))?;
            Some(file)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(AppCommandError::io(error)),
    };
    Ok(PublicationGuard {
        _thread: thread,
        _coordination: coordination,
    })
}

fn rollout_uuid() -> uuid::Uuid {
    let mut bytes = uuid::Uuid::new_v4().into_bytes();
    let milliseconds = Utc::now().timestamp_millis() as u64;
    bytes[..6].copy_from_slice(&milliseconds.to_be_bytes()[2..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes)
}

pub(super) async fn redo(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: ConversationRequest,
    mut backup: Value,
) -> Result<UndoResult, AppCommandError> {
    let session_id = backup["sessionId"]
        .as_str()
        .ok_or_else(changed)?
        .to_string();
    uuid::Uuid::parse_str(&session_id).map_err(|_| changed())?;
    disconnect_idle(manager, &session_id).await?;
    let env = agent_setting_service::load_agent_env(&db.conn, AgentType::Codex).await;
    let mut native = client(db, data_dir, &session_id).await?;
    let metadata = native
        .call(
            "thread/read",
            json!({"threadId": session_id, "includeTurns": false}),
        )
        .await?;
    let active = metadata["thread"]["path"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(changed)?;
    let home = crate::parsers::codex::resolve_codex_home_dir_for_env(&env);
    let coordination = publication_guard(&home, &session_id)?;
    if !redo_available(&env, &session_id, &backup)
        || !same_path(
            &active,
            Path::new(backup["path"].as_str().ok_or_else(changed)?),
        )
    {
        return Err(changed());
    }
    let original = backup["original"]
        .as_str()
        .ok_or_else(changed)?
        .as_bytes()
        .to_vec();
    if backup["originalDigest"] != digest(&original) {
        return Err(failed("Redo backup is damaged"));
    }
    let now = Local::now();
    let directory = home
        .join("sessions")
        .join(now.format("%Y/%m/%d").to_string());
    std::fs::create_dir_all(&directory).map_err(AppCommandError::io)?;
    let restored = directory.join(format!(
        "rollout-{}-{session_id}_{}.jsonl",
        now.format("%Y-%m-%dT%H-%M-%S"),
        rollout_uuid(),
    ));
    backup["restorePath"] = json!(restored);
    atomic_write(
        &backup_path(data_dir, request.conversation_id),
        &serde_json::to_vec(&backup).map_err(|error| failed(error.to_string()))?,
    )?;
    // 创建新的历史代，不覆盖可能已被其他会话引用的旧 rollout。
    let mut staged = tempfile::NamedTempFile::new_in(&directory).map_err(AppCommandError::io)?;
    staged.write_all(&original).map_err(AppCommandError::io)?;
    staged.as_file().sync_all().map_err(AppCommandError::io)?;
    staged
        .persist_noclobber(&restored)
        .map_err(|error| AppCommandError::io(error.error))?;
    let connection = rusqlite::Connection::open_with_flags(
        home.join("state_5.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| failed(error.to_string()))?;
    connection
        .busy_timeout(Duration::from_secs(1))
        .map_err(|error| failed(error.to_string()))?;
    let previous: String = connection
        .query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1",
            [&session_id],
            |row| row.get(0),
        )
        .map_err(|error| failed(error.to_string()))?;
    if !same_path(Path::new(&previous), &active) {
        return Err(changed());
    }
    let updated = connection
        .execute(
            "UPDATE threads SET rollout_path = ?1 WHERE id = ?2 AND rollout_path = ?3",
            rusqlite::params![restored.to_string_lossy(), session_id, previous],
        )
        .map_err(|error| failed(error.to_string()))?;
    if updated != 1 {
        return Err(changed());
    }
    // 仍持有原生发布锁，校验真实协议所读取的活动指针；不清理其他历史代的投影缓存。
    let verified = tokio::time::timeout(
        Duration::from_secs(5),
        native.call(
            "thread/read",
            json!({"threadId": session_id, "includeTurns": false}),
        ),
    )
    .await;
    let valid = matches!(&verified, Ok(Ok(value)) if value["thread"]["id"] == session_id
        && value["thread"]["path"].as_str().is_some_and(|path| same_path(Path::new(path), &restored)));
    if !valid {
        connection
            .execute(
                "UPDATE threads SET rollout_path = ?1 WHERE id = ?2 AND rollout_path = ?3",
                rusqlite::params![previous, session_id, restored.to_string_lossy()],
            )
            .map_err(|error| failed(error.to_string()))?;
        return Err(failed(
            "Codex could not verify the restored history pointer",
        ));
    }
    drop(connection);
    drop(coordination);
    native.close().await;
    if let Err(error) = std::fs::remove_file(backup_path(data_dir, request.conversation_id)) {
        tracing::warn!(%error, "could not consume Codex Redo backup");
    }
    Ok(UndoResult {
        conversation_id: request.conversation_id,
        session_id,
    })
}
