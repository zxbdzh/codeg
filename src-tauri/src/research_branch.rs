//! 持久研究旁支：主连接只读，原生 fork 只发往可清理的独立连接。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::acp::connection::ConnectionCommand;
use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::{ConnectionStatus, SessionConfigKindInfo};
use crate::acp::SessionState;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::error::DbError;
use crate::db::service::{
    agent_setting_service, conversation_service, folder_service, research_branch_service as service,
};
use crate::db::AppDatabase;
use crate::models::{ContentBlock, MessageTurn, TurnRole};
use crate::side_question::{AskRequest, ContextEntry, ContextRole};
use crate::web::event_bridge::{
    emit_event, ConversationChange, EventEmitter, CONVERSATION_CHANGED_EVENT,
};

pub use service::ResearchBranchInfo;

pub(crate) const TEMPORARY_OWNER: &str = "research_branch";

pub(crate) fn is_temporary_owner(owner: &str) -> bool {
    owner == TEMPORARY_OWNER
}

pub(crate) fn temporary_cleanup_allowed(expected_id: &str, actual_id: &str, owner: &str) -> bool {
    expected_id == actual_id && is_temporary_owner(owner)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRequest {
    pub connection_id: String,
    pub source_conversation_id: i32,
    pub request_id: String,
}

#[derive(Serialize)]
pub struct SummaryAnswer {
    pub summary: String,
}

pub fn db_error(error: DbError) -> AppCommandError {
    match error {
        DbError::NotFound(message) => AppCommandError::not_found(message),
        DbError::Validation(message) => AppCommandError::invalid_input(message),
        DbError::Conflict(message) => AppCommandError::already_exists(message),
        other => AppCommandError::from(other),
    }
}

fn acp_error(error: AcpError) -> AppCommandError {
    let code = error.code().unwrap_or("research_fork_failed");
    let app_code = if matches!(error, AcpError::TurnInProgress) {
        AppErrorCode::TurnInProgress
    } else {
        AppErrorCode::TaskExecutionFailed
    };
    AppCommandError::new(app_code, error.to_string())
        .with_detail(serde_json::json!({"acpCode": code}).to_string())
}

fn validate_request_id(value: &str) -> Result<(), AppCommandError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AppCommandError::invalid_input(
            "requestId must contain 1–128 ASCII letters, digits, - or _",
        ));
    }
    Ok(())
}

fn request_lock(key: String) -> Arc<AsyncMutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

fn idle_gate(state: &SessionState) -> Result<(), AcpError> {
    if state.turn_in_flight
        || state.agent_initiated_turn
        || state.status == ConnectionStatus::Prompting
        || state.live_message.is_some()
        || !state.active_tool_calls.is_empty()
        || state.pending_permission.is_some()
        || state.pending_question.is_some()
        || state.pending_plan_approval.is_some()
        || !state.active_delegations.is_empty()
        || state.background_outstanding > 0
        || state
            .async_tasks
            .values()
            .any(|task| !crate::acp::types::async_task_state_is_terminal(&task.state))
    {
        return Err(AcpError::TurnInProgress);
    }
    if state.status != ConnectionStatus::Connected || !state.selectors_ready {
        return Err(AcpError::protocol(
            "Research fork requires a ready idle connection",
        ));
    }
    if !state.fork_supported {
        return Err(AcpError::protocol(
            "This connection does not support session/fork",
        ));
    }
    Ok(())
}

struct TemporaryConnection {
    manager: ConnectionManager,
    id: String,
    child_pid: Option<Arc<std::sync::atomic::AtomicU32>>,
}

impl Drop for TemporaryConnection {
    fn drop(&mut self) {
        let manager = self.manager.clone_ref();
        let id = self.id.clone();
        let child_pid = self.child_pid.clone();
        tokio::spawn(async move {
            manager.disconnect_research_connection(&id).await;
            if let Some(pid) = child_pid {
                // driver 可能已移除 map 项；保留原始 PID cell 才能确认 S2 的写锁已释放。
                manager.reap_research_process(pid).await;
            }
        });
    }
}

// 协议没有可靠的跨代理 delete；记录 S2 后再提交 DB，失败重试复用 S2 而非重复 fork。
#[derive(Debug, Serialize, Deserialize)]
struct Recovery {
    request_id: String,
    source_conversation_id: i32,
    source_session_id: String,
    branch_session_id: String,
    source_turn_id: Option<String>,
}

fn recovery_path(data_dir: &Path, request_id: &str) -> PathBuf {
    // 哈希避免 Windows 保留文件名、大小写折叠及调用者可控路径。
    data_dir
        .join("research-branch-recovery")
        .join(format!("{:x}.jsonl", Sha256::digest(request_id.as_bytes())))
}

async fn read_recovery(path: &Path) -> Result<Option<Recovery>, AppCommandError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let record = bytes
                .split(|byte| *byte == b'\n')
                .rev()
                .find_map(|line| serde_json::from_slice::<Recovery>(line).ok())
                .ok_or_else(|| {
                    AppCommandError::task_execution_failed("Invalid research fork recovery record")
                })?;
            if record.branch_session_id.is_empty() {
                return Err(AppCommandError::task_execution_failed("Research fork outcome is unknown after interruption; refusing to fork again with this requestId"));
            }
            Ok(Some(record))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppCommandError::io(error)),
    }
}

async fn persist(
    db: &AppDatabase,
    record: &Recovery,
) -> Result<ResearchBranchInfo, AppCommandError> {
    service::create(
        &db.conn,
        &record.request_id,
        record.source_conversation_id,
        &record.source_session_id,
        &record.branch_session_id,
        record.source_turn_id.clone(),
    )
    .await
    .map_err(db_error)
}

async fn append_recovery(
    path: &Path,
    record: &Recovery,
    create: bool,
) -> Result<(), AppCommandError> {
    let mut bytes = serde_json::to_vec(record)
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?;
    bytes.push(b'\n');
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(create)
        .append(true)
        .open(path)
        .await
        .map_err(AppCommandError::io)?;
    file.write_all(&bytes).await.map_err(AppCommandError::io)?;
    file.sync_all().await.map_err(AppCommandError::io)
}

async fn read_turns(
    db: &AppDatabase,
    agent: crate::models::AgentType,
    session_id: String,
) -> Result<Vec<MessageTurn>, AppCommandError> {
    let env = agent_setting_service::load_agent_env(&db.conn, agent).await;
    tokio::task::spawn_blocking(move || {
        let detail = crate::parsers::build_agent_parser(agent, &env)
            .get_conversation(&session_id)
            .map_err(|error| {
                AppCommandError::task_execution_failed("Could not read research session history")
                    .with_detail(error.to_string())
            })?;
        // 读取普通 detail 会顺带改写 external_id；研究路径必须拒绝别名漂移而不改主行。
        if detail.summary.id != session_id {
            return Err(AppCommandError::invalid_input(
                "Transcript session identity changed; reconnect before creating research",
            ));
        }
        Ok(detail.turns)
    })
    .await
    .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?
}

pub async fn create(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    emitter: &EventEmitter,
    request: CreateRequest,
) -> Result<ResearchBranchInfo, AppCommandError> {
    validate_request_id(&request.request_id)?;
    let db = AppDatabase {
        conn: db.conn.clone(),
    };
    let manager = manager.clone_ref();
    let data_dir = data_dir.to_path_buf();
    let emitter = emitter.clone();
    // 一旦进入工作任务，HTTP/Tauri 调用方取消只丢弃响应，不中断原生 fork → 持久化 → 清理。
    tokio::spawn(async move {
        let lock = request_lock(format!("{}:{}", data_dir.display(), request.request_id));
        let _request_guard = lock.lock_owned().await;
        if let Some(existing) = service::by_request(
            &db.conn,
            &request.request_id,
            request.source_conversation_id,
        )
        .await
        .map_err(db_error)?
        {
            return Ok(existing);
        }
        let path = recovery_path(&data_dir, &request.request_id);
        let result = if let Some(record) = read_recovery(&path).await? {
            if record.source_conversation_id != request.source_conversation_id
                || record.request_id != request.request_id
            {
                return Err(AppCommandError::invalid_input(
                    "Research recovery belongs to another source",
                ));
            }
            persist(&db, &record).await?
        } else {
            create_inner(&db, &manager, &data_dir, &path, request).await?
        };
        // 已有关系是最终幂等凭据；日志清理失败不把成功操作伪装为失败。
        if let Err(error) = tokio::fs::remove_file(&path).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, "Research recovery cleanup failed");
            }
        }
        if let Ok(summary) =
            conversation_service::get_by_id(&db.conn, result.branch_conversation_id).await
        {
            emit_event(
                &emitter,
                CONVERSATION_CHANGED_EVENT,
                &ConversationChange::Upsert {
                    summary: Box::new(summary),
                },
            );
        }
        Ok(result)
    })
    .await
    .map_err(|error| {
        AppCommandError::task_execution_failed("Research branch task failed")
            .with_detail(error.to_string())
    })?
}

async fn create_inner(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    recovery_file: &Path,
    request: CreateRequest,
) -> Result<ResearchBranchInfo, AppCommandError> {
    let (state, prompt_lock) = {
        let connections = manager.connections.lock().await;
        let source = connections.get(&request.connection_id).ok_or_else(|| {
            acp_error(AcpError::ConnectionNotFound(request.connection_id.clone()))
        })?;
        (source.state.clone(), source.prompt_lock.clone())
    };
    // 忙时立即拒绝；不能把排队到下一轮结束冒充用户点击时的尾部。
    let _source_guard = prompt_lock
        .try_lock_owned()
        .map_err(|_| acp_error(AcpError::TurnInProgress))?;
    let source_row = service::live_conversation(&db.conn, request.source_conversation_id)
        .await
        .map_err(db_error)?;
    let (agent, cwd, session_id, mode, config) = {
        let source = state.read().await;
        idle_gate(&source).map_err(acp_error)?;
        let session_id = source
            .external_id
            .clone()
            .ok_or_else(|| AppCommandError::invalid_input("Source has no session"))?;
        let agent_name = serde_json::to_value(source.agent_type)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned));
        if source.conversation_id.is_some_and(|id| id != source_row.id)
            || source_row.external_id.as_deref() != Some(session_id.as_str())
            || agent_name.as_deref() != Some(source_row.agent_type.as_str())
        {
            return Err(AppCommandError::invalid_input(
                "Source conversation does not match the connection",
            ));
        }
        if !matches!(
            source_row.kind,
            crate::db::entities::conversation::ConversationKind::Regular
                | crate::db::entities::conversation::ConversationKind::Chat
        ) {
            return Err(AppCommandError::invalid_input(
                "Research source must be regular or chat",
            ));
        }
        let cwd = source
            .working_dir
            .as_ref()
            .ok_or_else(|| AppCommandError::invalid_input("Source has no working directory"))?
            .to_string_lossy()
            .into_owned();
        let config = source
            .config_options
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|option| match &option.kind {
                SessionConfigKindInfo::Select(select) => {
                    (option.id.clone(), select.current_value.clone())
                }
                SessionConfigKindInfo::Boolean(toggle) => {
                    (option.id.clone(), toggle.current_value.to_string())
                }
            })
            .collect();
        (
            source.agent_type,
            cwd,
            session_id,
            source.current_mode.clone(),
            config,
        )
    };
    let folder = folder_service::get_folder_by_id(&db.conn, source_row.folder_id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| AppCommandError::not_found("Source folder not found"))?;
    let expected_cwd = source_row.origin_cwd.as_deref().unwrap_or(&folder.path);
    if !crate::parsers::path_eq_for_matching(&cwd, expected_cwd) {
        return Err(AppCommandError::invalid_input(
            "Source working directory does not match the conversation",
        ));
    }
    let turns = read_turns(db, agent, session_id.clone()).await?;
    let source_turn_id = turns
        .iter()
        .rev()
        .find(|turn| matches!(turn.role, TurnRole::Assistant))
        .map(|turn| turn.id.clone());
    let runtime_env =
        crate::commands::acp::build_session_runtime_env(db, agent, Some(&session_id), data_dir)
            .await
            .map_err(acp_error)?;
    tokio::fs::create_dir_all(recovery_file.parent().expect("recovery directory"))
        .await
        .map_err(AppCommandError::io)?;
    let mut temporary = TemporaryConnection {
        manager: manager.clone_ref(),
        id: uuid::Uuid::new_v4().to_string(),
        child_pid: None,
    };
    temporary.child_pid = Some(
        manager
            .spawn_research_connection(
                temporary.id.clone(),
                agent,
                cwd,
                session_id.clone(),
                runtime_env,
                mode,
                config,
            )
            .await
            .map_err(acp_error)?,
    );
    wait_ready(manager, &temporary.id, &session_id).await?;
    {
        let connections = manager.connections.lock().await;
        let source = connections.get(&request.connection_id).ok_or_else(|| {
            acp_error(AcpError::ConnectionNotFound(request.connection_id.clone()))
        })?;
        if source.handshake.is_cancelled() || !Arc::ptr_eq(&source.state, &state) {
            return Err(acp_error(AcpError::ProcessExited));
        }
    }
    {
        let source = state.read().await;
        idle_gate(&source).map_err(acp_error)?;
        if source.external_id.as_deref() != Some(session_id.as_str()) {
            return Err(AppCommandError::invalid_input(
                "Source session changed while opening research connection",
            ));
        }
    }
    let cmd_tx = manager
        .connections
        .lock()
        .await
        .get(&temporary.id)
        .map(|connection| connection.cmd_tx.clone())
        .ok_or_else(|| acp_error(AcpError::ProcessExited))?;
    let (reply, receiver) = tokio::sync::oneshot::channel();
    let mut record = Recovery {
        request_id: request.request_id,
        source_conversation_id: source_row.id,
        source_session_id: session_id.clone(),
        branch_session_id: String::new(),
        source_turn_id,
    };
    // 先落 pending：崩溃在协议响应和本地记录之间时，宁可明确未知，也不能重试制造第二个 S2。
    append_recovery(recovery_file, &record, true).await?;
    if cmd_tx
        .send(ConnectionCommand::Fork {
            fork_point: None,
            reply,
        })
        .await
        .is_err()
    {
        let _ = tokio::fs::remove_file(recovery_file).await;
        return Err(acp_error(AcpError::ProcessExited));
    }
    let forked = match tokio::time::timeout(Duration::from_secs(120), receiver).await
        .map_err(|_| AppCommandError::task_execution_failed("Research fork timed out; outcome unknown, retry this requestId to inspect recovery"))?
        .map_err(|_| acp_error(AcpError::ProcessExited))? {
        Ok(forked) => forked,
        Err(error) => {
            // 只有忙门控能证明 RPC 未发出；传输错误也可能发生在远端已创建 S2 之后。
            if matches!(error, AcpError::TurnInProgress) {
                let _ = tokio::fs::remove_file(recovery_file).await;
            }
            return Err(acp_error(error));
        }
    };
    if forked.original_session_id != session_id
        || forked.forked_session_id.is_empty()
        || forked.forked_session_id == session_id
    {
        return Err(AppCommandError::task_execution_failed(
            "Agent returned an invalid research fork identity",
        ));
    }
    record.branch_session_id = forked.forked_session_id;
    append_recovery(recovery_file, &record, false).await.map_err(|error| {
        tracing::error!(source_session = %record.source_session_id, branch_session = %record.branch_session_id, %error, "Research fork recovery could not be written");
        error.with_detail(format!("Fork created session {}; recovery persistence failed", record.branch_session_id))
    })?;
    let result = persist(db, &record).await;
    manager.disconnect_research_connection(&temporary.id).await;
    if let Some(pid) = temporary.child_pid.clone() {
        manager.reap_research_process(pid).await;
    }
    result
}

async fn wait_ready(
    manager: &ConnectionManager,
    id: &str,
    source_session_id: &str,
) -> Result<(), AppCommandError> {
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let state = manager
                .get_state(id)
                .await
                .ok_or_else(|| acp_error(AcpError::ProcessExited))?;
            let state = state.read().await;
            if matches!(
                state.status,
                ConnectionStatus::Error | ConnectionStatus::Disconnected
            ) {
                return Err(acp_error(AcpError::protocol(
                    state
                        .last_error
                        .as_ref()
                        .map(|error| error.message.as_str())
                        .unwrap_or("Research connection failed"),
                )));
            }
            if state.selectors_ready && state.status == ConnectionStatus::Connected {
                idle_gate(&state).map_err(acp_error)?;
                if state.external_id.as_deref() != Some(source_session_id) {
                    return Err(AppCommandError::task_execution_failed(
                        "Agent did not resume the source session; refusing a fresh-session fork",
                    ));
                }
                return Ok(());
            }
            drop(state);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| {
        AppCommandError::task_execution_failed("Research connection readiness timed out")
    })?
}

fn snapshot(turns: &[MessageTurn]) -> Vec<ContextEntry> {
    let mut remaining = 12_000;
    let mut entries = Vec::new();
    let Some(completed_tail) = turns
        .iter()
        .rposition(|turn| matches!(turn.role, TurnRole::Assistant) && turn.completed_at.is_some())
    else {
        return entries;
    };
    let turns = &turns[..=completed_tail];
    for turn in turns.iter().rev() {
        if entries.len() == 12 || remaining == 0 {
            break;
        }
        let role = match turn.role {
            TurnRole::User => ContextRole::User,
            TurnRole::Assistant if turn.completed_at.is_some() => ContextRole::Assistant,
            _ => continue,
        };
        let text: String = turn
            .blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let text: String = text
            .chars()
            .rev()
            .take(remaining)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if text.trim().is_empty() {
            continue;
        }
        remaining -= text.chars().count();
        entries.push(ContextEntry { role, text });
    }
    entries.reverse();
    entries
}

pub async fn generate_summary(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    branch_id: i32,
    request_id: String,
) -> Result<SummaryAnswer, AppCommandError> {
    let branch = service::by_branch(&db.conn, branch_id)
        .await
        .map_err(db_error)?;
    let states = {
        let connections = manager.connections.lock().await;
        let mut connections = connections
            .values()
            .map(|connection| {
                (
                    connection.id.clone(),
                    connection.state.clone(),
                    connection.prompt_lock.clone(),
                )
            })
            .collect::<Vec<_>>();
        connections.sort_by(|left, right| left.0.cmp(&right.0));
        connections
    };
    let mut guards = Vec::new();
    for (_, state, prompt_lock) in &states {
        let state = state.read().await;
        if state.conversation_id == Some(branch_id)
            || state.external_id.as_deref() == Some(branch.branch_session_id.as_str())
        {
            drop(state);
            guards.push(
                prompt_lock
                    .clone()
                    .try_lock_owned()
                    .map_err(|_| acp_error(AcpError::TurnInProgress))?,
            );
        }
    }
    for (_, state, _) in &states {
        let state = state.read().await;
        if (state.conversation_id == Some(branch_id)
            || state.external_id.as_deref() == Some(branch.branch_session_id.as_str()))
            && (state.turn_in_flight
                || state.live_message.is_some()
                || state.agent_initiated_turn
                || state.status == ConnectionStatus::Prompting
                || state.background_outstanding > 0
                || !state.active_delegations.is_empty()
                || state
                    .async_tasks
                    .values()
                    .any(|task| !crate::acp::types::async_task_state_is_terminal(&task.state)))
        {
            return Err(acp_error(AcpError::TurnInProgress));
        }
    }
    let row = service::live_conversation(&db.conn, branch_id)
        .await
        .map_err(db_error)?;
    if row.status == crate::db::entities::conversation::ConversationStatus::InProgress {
        return Err(acp_error(AcpError::TurnInProgress));
    }
    if row.external_id.as_deref() != Some(branch.branch_session_id.as_str()) {
        return Err(AppCommandError::invalid_input(
            "Research branch session changed; refusing to summarize a different history",
        ));
    }
    let agent =
        serde_json::from_value(serde_json::Value::String(row.agent_type)).map_err(|error| {
            AppCommandError::invalid_input(format!("Invalid branch agent: {error}"))
        })?;
    let turns = read_turns(db, agent, branch.branch_session_id).await?;
    let context = snapshot(&turns);
    drop(guards);
    if context.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Research branch has no completed body text",
        ));
    }
    let answer = crate::side_question::ask(db, manager, data_dir, AskRequest {
        request_id, question: "仅根据提供的已完成研究旁支正文，整理可供主会话参考的摘要草稿，包括结论、证据、未决问题和建议。不要执行任何操作，不要声称已更改主会话。保持原对话语言，最多 12000 个 Unicode 字符。".into(),
        selection: None, context, mode_id: None, config_values: BTreeMap::new(),
    }).await?;
    service::by_branch(&db.conn, branch_id)
        .await
        .map_err(db_error)?;
    Ok(SummaryAnswer {
        summary: answer
            .answer
            .chars()
            .take(service::MAX_SUMMARY_CHARS)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AgentType;

    fn ready() -> SessionState {
        let mut state = SessionState::new(
            "main".into(),
            AgentType::ClaudeCode,
            Some(PathBuf::from("/repo")),
            "main".into(),
            None,
        );
        state.status = ConnectionStatus::Connected;
        state.selectors_ready = true;
        state.fork_supported = true;
        state
    }

    #[test]
    fn research_branch_idle_gate_rejects_busy_and_unready_sources() {
        let mut state = ready();
        assert!(idle_gate(&state).is_ok());
        state.turn_in_flight = true;
        assert!(matches!(idle_gate(&state), Err(AcpError::TurnInProgress)));
        state.turn_in_flight = false;
        state.status = ConnectionStatus::Prompting;
        assert!(matches!(idle_gate(&state), Err(AcpError::TurnInProgress)));
        state.status = ConnectionStatus::Connected;
        state.background_outstanding = 1;
        assert!(matches!(idle_gate(&state), Err(AcpError::TurnInProgress)));
        state.background_outstanding = 0;
        state.selectors_ready = false;
        assert!(idle_gate(&state).is_err());
        state.selectors_ready = true;
        state.fork_supported = false;
        assert!(idle_gate(&state).is_err());
    }

    #[test]
    fn research_branch_wire_errors_and_request_ids_are_explicit() {
        let error = acp_error(AcpError::TurnInProgress);
        assert!(matches!(error.code, AppErrorCode::TurnInProgress));
        assert!(error.detail.unwrap().contains("turn_in_progress"));
        assert!(matches!(
            db_error(DbError::NotFound("gone".into())).code,
            AppErrorCode::NotFound
        ));
        for id in ["", "../other", "x/y", "中文", "x.y"] {
            assert!(validate_request_id(id).is_err());
        }
        assert!(validate_request_id("request-123_ok").is_ok());
        assert_ne!(
            recovery_path(Path::new("/data"), "ABC"),
            recovery_path(Path::new("/data"), "abc")
        );
        assert!(is_temporary_owner(TEMPORARY_OWNER));
        assert!(!is_temporary_owner("main"));
        assert!(temporary_cleanup_allowed("temp", "temp", TEMPORARY_OWNER));
        assert!(!temporary_cleanup_allowed("temp", "main", TEMPORARY_OWNER));
        assert!(!temporary_cleanup_allowed("main", "main", "main"));
        assert!(!crate::acp::session_state::owner_composes_prompts(
            TEMPORARY_OWNER
        ));
    }

    fn turn(role: TurnRole, text: String) -> MessageTurn {
        MessageTurn {
            id: "turn".into(),
            role,
            blocks: vec![ContentBlock::Text { text }],
            timestamp: chrono::Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: Some(chrono::Utc::now()),
            agent_message_id: None,
        }
    }

    #[test]
    fn research_branch_summary_snapshot_is_bounded_unicode_body_only() {
        let turns = vec![
            turn(TurnRole::System, "private system text".into()),
            turn(TurnRole::User, "question".into()),
            turn(TurnRole::Assistant, "研究😀".repeat(5_000)),
        ];
        let context = snapshot(&turns);
        assert_eq!(context.len(), 1);
        assert_eq!(context[0].role, ContextRole::Assistant);
        assert_eq!(context[0].text.chars().count(), 12_000);
        let turns = (0..20)
            .map(|index| turn(TurnRole::Assistant, index.to_string()))
            .collect::<Vec<_>>();
        let context = snapshot(&turns);
        assert_eq!(context.len(), 12);
        assert_eq!(context.first().unwrap().text, "8");
        assert_eq!(context.last().unwrap().text, "19");
        let mut unfinished = turn(TurnRole::Assistant, "incomplete".into());
        unfinished.completed_at = None;
        let context = snapshot(&[
            turn(TurnRole::Assistant, "completed".into()),
            turn(TurnRole::User, "dangling prompt".into()),
            unfinished.clone(),
        ]);
        assert_eq!(context.len(), 1);
        assert_eq!(context[0].text, "completed");
        assert!(snapshot(&[unfinished]).is_empty());
    }

    #[tokio::test]
    async fn research_branch_request_lock_serializes_only_matching_requests() {
        let first = request_lock("test-duplicate".into());
        let second = request_lock("test-duplicate".into());
        let other = request_lock("test-other".into());
        assert!(Arc::ptr_eq(&first, &second));
        let guard = first.lock().await;
        assert!(second.try_lock().is_err());
        assert!(other.try_lock().is_ok());
        drop(guard);
        assert!(second.try_lock().is_ok());
    }

    #[tokio::test]
    async fn research_branch_recovery_reuses_fork_and_rejects_unknown_outcome() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recovery.jsonl");
        let mut record = Recovery {
            request_id: "recover".into(),
            source_conversation_id: 1,
            source_session_id: "S1".into(),
            branch_session_id: String::new(),
            source_turn_id: Some("turn-2".into()),
        };
        assert!(read_recovery(&path).await.unwrap().is_none());
        append_recovery(&path, &record, true).await.unwrap();
        assert!(read_recovery(&path).await.is_err());
        record.branch_session_id = "S2".into();
        append_recovery(&path, &record, false).await.unwrap();
        assert_eq!(
            read_recovery(&path)
                .await
                .unwrap()
                .unwrap()
                .branch_session_id,
            "S2"
        );
        assert!(append_recovery(&path, &record, true).await.is_err());
    }

    #[tokio::test]
    async fn research_branch_missing_connection_never_creates_a_row() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let directory = tempfile::tempdir().unwrap();
        let result = create(
            &db,
            &ConnectionManager::new(),
            directory.path(),
            &EventEmitter::Noop,
            CreateRequest {
                connection_id: "gone".into(),
                source_conversation_id: 1,
                request_id: "missing-source".into(),
            },
        )
        .await;
        assert!(result.is_err());
        use sea_orm::{EntityTrait, PaginatorTrait};
        assert_eq!(
            crate::db::entities::conversation::Entity::find()
                .count(&db.conn)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn research_branch_ready_gate_checks_runtime_session_identity() {
        use crate::acp::connection::AgentConnection;
        use std::sync::atomic::AtomicU32;
        use tokio::sync::RwLock;
        let manager = ConnectionManager::new();
        let (sender, _receiver) = tokio::sync::mpsc::channel(1);
        let mut state = ready();
        state.external_id = Some("S1".into());
        let state = Arc::new(RwLock::new(state));
        manager.connections.lock().await.insert(
            "temp".into(),
            AgentConnection {
                id: "temp".into(),
                agent_type: AgentType::ClaudeCode,
                status: ConnectionStatus::Connected,
                owner_window_label: TEMPORARY_OWNER.into(),
                cmd_tx: sender,
                handshake: tokio_util::sync::CancellationToken::new(),
                state: state.clone(),
                emitter: EventEmitter::Noop,
                prompt_lock: Arc::new(AsyncMutex::new(())),
                config_fingerprint: String::new(),
                last_observed_fingerprint: String::new(),
                child_pid: Arc::new(AtomicU32::new(0)),
            },
        );
        assert!(wait_ready(&manager, "temp", "S1").await.is_ok());
        assert!(manager
            .find_connection_for_reuse(
                AgentType::ClaudeCode,
                Some(&PathBuf::from("/repo")),
                Some("S1")
            )
            .await
            .is_none());
        assert!(manager
            .find_connection_by_external_id("S1", AgentType::ClaudeCode)
            .await
            .is_none());
        state.write().await.fork_supported = false;
        assert!(wait_ready(&manager, "temp", "S1").await.is_err());
        state.write().await.fork_supported = true;
        state.write().await.external_id = Some("fresh-fallback".into());
        assert!(wait_ready(&manager, "temp", "S1").await.is_err());
        state.write().await.external_id = Some("S1".into());
        manager
            .connections
            .lock()
            .await
            .get_mut("temp")
            .unwrap()
            .owner_window_label = "main".into();
        manager.disconnect_research_connection("temp").await;
        assert_eq!(manager.connections.lock().await.len(), 1);
        manager
            .connections
            .lock()
            .await
            .get_mut("temp")
            .unwrap()
            .owner_window_label = TEMPORARY_OWNER.into();
        manager.disconnect_research_connection("temp").await;
        assert!(manager.connections.lock().await.is_empty());
    }

    #[tokio::test]
    async fn research_branch_recovery_commits_existing_s2_without_a_connection() {
        use crate::db::entities::conversation;
        use sea_orm::{ActiveModelTrait, EntityTrait, PaginatorTrait, Set};
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let folder_id = crate::db::test_helpers::seed_folder(&db, "/research-recovery").await;
        let source_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        let mut source: conversation::ActiveModel = service::live_conversation(&db.conn, source_id)
            .await
            .unwrap()
            .into();
        source.external_id = Set(Some("S1".into()));
        source.update(&db.conn).await.unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = recovery_path(directory.path(), "replay-existing");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        let record = Recovery {
            request_id: "replay-existing".into(),
            source_conversation_id: source_id,
            source_session_id: "S1".into(),
            branch_session_id: "already-forked-S2".into(),
            source_turn_id: Some("turn-4".into()),
        };
        append_recovery(&path, &record, true).await.unwrap();
        let manager = ConnectionManager::new();
        let request = CreateRequest {
            connection_id: "old-connection-gone".into(),
            source_conversation_id: source_id,
            request_id: record.request_id,
        };
        let result = create(
            &db,
            &manager,
            directory.path(),
            &EventEmitter::Noop,
            request.clone(),
        )
        .await
        .unwrap();
        assert_eq!(result.branch_session_id, "already-forked-S2");
        assert!(!path.exists());
        let duplicate = create(
            &db,
            &manager,
            directory.path(),
            &EventEmitter::Noop,
            request,
        )
        .await
        .unwrap();
        assert_eq!(duplicate.id, result.id);
        assert_eq!(
            conversation::Entity::find().count(&db.conn).await.unwrap(),
            2
        );
        assert!(manager.connections.lock().await.is_empty());
    }
}
