//! 历史会话分叉：复制对话上下文，保持源会话与工作区文件不变。

use std::collections::HashMap;
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
    pub source_turn_id: Option<String>,
    pub source_prompt: Option<PromptSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptSnapshot {
    pub text: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub agent_message_id: Option<String>,
}

impl PromptSnapshot {
    fn from_turn(turn: &MessageTurn) -> Result<Self, AppCommandError> {
        if !matches!(turn.role, TurnRole::User)
            || turn.blocks.is_empty()
            || turn
                .blocks
                .iter()
                .any(|block| !matches!(block, ContentBlock::Text { .. }))
        {
            return Err(AppCommandError::invalid_input(
                "Choose a saved text-only message of your own to fork",
            ));
        }
        let text = turn
            .blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        if text.trim().is_empty() {
            return Err(AppCommandError::invalid_input(
                "The selected prompt is empty",
            ));
        }
        Ok(Self {
            text,
            timestamp: turn.timestamp,
            agent_message_id: turn.agent_message_id.clone(),
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct HistoryBoundary {
    prompt: PromptSnapshot,
    fingerprints: Vec<String>,
}

fn history_fingerprints(turns: &[MessageTurn]) -> Result<Vec<String>, AppCommandError> {
    turns
        .iter()
        .map(|turn| {
            // fork 会重写位置 ID、耗时与用量；边界以角色和全部内容块为准，不能只比最后一句。
            let content = serde_json::to_vec(&(&turn.role, &turn.blocks))
                .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?;
            Ok(format!("{:x}", Sha256::digest(content)))
        })
        .collect()
}

fn validate_history(expected: &[String], actual: &[MessageTurn]) -> Result<(), AppCommandError> {
    if expected != history_fingerprints(actual)? {
        return Err(AppCommandError::task_execution_failed(
            "The forked history does not match the selected boundary; the source conversation is unchanged",
        ).with_detail(serde_json::json!({
            "reason": "history_boundary_mismatch",
            "expectedTurns": expected.len(),
            "actualTurns": actual.len(),
        }).to_string()));
    }
    Ok(())
}

fn select_prompt_boundary(
    turns: &[MessageTurn],
    turn_id: &str,
    prompt: Option<&PromptSnapshot>,
    agent: crate::models::AgentType,
) -> Result<(crate::acp::fork::ForkPoint, HistoryBoundary), AppCommandError> {
    let index = turns
        .iter()
        .position(|turn| turn.id == turn_id)
        .ok_or_else(|| AppCommandError::invalid_input("The selected prompt no longer exists"))?;
    let current = PromptSnapshot::from_turn(&turns[index])?;
    // turn-N 是位置索引；压缩或重解析后同一个 ID 可能已指向另一条消息。
    if prompt != Some(&current) {
        return Err(AppCommandError::invalid_input(
            "The selected message changed; reopen the fork picker and select it again",
        ));
    }
    let point = crate::acp::fork::resolve_fork_point(turns, turn_id, agent).ok_or_else(|| {
        AppCommandError::invalid_input(
            "This prompt has no supported earlier reply; choose another message",
        )
    })?;
    Ok((
        point,
        HistoryBoundary {
            prompt: current,
            fingerprints: history_fingerprints(&turns[..index])?,
        },
    ))
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
    #[serde(default)]
    before_prompt: bool,
    #[serde(default)]
    history: Option<HistoryBoundary>,
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
    if record.before_prompt {
        let boundary = record.history.as_ref().ok_or_else(|| {
            AppCommandError::task_execution_failed(
                "This interrupted historical fork has no boundary proof and cannot be recovered safely",
            )
        })?;
        let source = service::live_conversation(&db.conn, record.source_conversation_id)
            .await
            .map_err(db_error)?;
        let agent = crate::models::AgentType::from_wire(&source.agent_type)
            .ok_or_else(|| AppCommandError::invalid_input("Unknown source agent"))?;
        // ACP 成功响应不保证锚点被执行；落库和恢复重试都必须核对 S2 的完整历史。
        // 部分适配器响应早于日志落盘，短暂等待允许正常的文件写入完成。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let result = match read_turns(db, agent, record.branch_session_id.clone()).await {
                Ok(turns) => validate_history(&boundary.fingerprints, &turns),
                Err(error) => Err(error),
            };
            match result {
                Ok(()) => break,
                Err(error) if tokio::time::Instant::now() >= deadline => return Err(error),
                Err(_) => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        }
    }
    service::create_with_boundary(
        &db.conn,
        &record.request_id,
        record.source_conversation_id,
        &record.source_session_id,
        &record.branch_session_id,
        record.source_turn_id.clone(),
        if record.before_prompt {
            "before_prompt"
        } else {
            "session_tail"
        },
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
            if (existing.boundary == "before_prompt") != request.source_turn_id.is_some()
                || (request.source_turn_id.is_some()
                    && existing.source_turn_id != request.source_turn_id)
            {
                return Err(AppCommandError::invalid_input(
                    "Research request id belongs to another fork point",
                ));
            }
            return Ok(existing);
        }
        let path = recovery_path(&data_dir, &request.request_id);
        let result = if let Some(record) = read_recovery(&path).await? {
            if record.source_conversation_id != request.source_conversation_id
                || record.request_id != request.request_id
                || record.before_prompt != request.source_turn_id.is_some()
                || (record.before_prompt && record.source_turn_id != request.source_turn_id)
                || (record.before_prompt
                    && record.history.as_ref().map(|history| &history.prompt)
                        != request.source_prompt.as_ref())
            {
                return Err(AppCommandError::invalid_input(
                    "Research recovery belongs to another source",
                ));
            }
            persist(&db, &record).await?
        } else {
            if request.source_turn_id.is_none() || request.source_prompt.is_none() {
                return Err(AppCommandError::invalid_input(
                    "Choose one of your saved messages to fork the conversation",
                ));
            }
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
    let (source_turn_id, fork_point, history) = if let Some(turn_id) = &request.source_turn_id {
        let (point, history) =
            select_prompt_boundary(&turns, turn_id, request.source_prompt.as_ref(), agent)?;
        (Some(turn_id.clone()), Some(point), Some(history))
    } else {
        (
            turns
                .iter()
                .rev()
                .find(|turn| matches!(turn.role, TurnRole::Assistant))
                .map(|turn| turn.id.clone()),
            None,
            None,
        )
    };
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
        before_prompt: request.source_turn_id.is_some(),
        history,
    };
    // 先落 pending：崩溃在协议响应和本地记录之间时，宁可明确未知，也不能重试制造第二个 S2。
    append_recovery(recovery_file, &record, true).await?;
    if cmd_tx
        .send(ConnectionCommand::Fork {
            fork_point,
            source_session_id: (agent == crate::models::AgentType::Codex)
                .then(|| session_id.clone()),
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
                let correct_session = if state.agent_type == crate::models::AgentType::Codex {
                    state
                        .external_id
                        .as_deref()
                        .is_some_and(|id| !id.is_empty() && id != source_session_id)
                } else {
                    state.external_id.as_deref() == Some(source_session_id)
                };
                if !correct_session {
                    return Err(AppCommandError::task_execution_failed(
                        "The temporary fork connection has an unexpected session identity",
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

    fn history_turns(messages: &[(TurnRole, &str)]) -> Vec<MessageTurn> {
        messages
            .iter()
            .enumerate()
            .map(|(index, (role, text))| {
                let mut message = turn(role.clone(), (*text).into());
                message.id = format!("turn-{index}");
                message
            })
            .collect()
    }

    #[test]
    fn historical_fork_distinguishes_repeated_replies_and_rejects_tail_or_other_branch() {
        let turns = history_turns(&[
            (TurnRole::User, "first"),
            (TurnRole::Assistant, "same answer"),
            (TurnRole::User, "second"),
            (TurnRole::Assistant, "same answer"),
            (TurnRole::User, "continue differently"),
            (TurnRole::Assistant, "later answer"),
        ]);
        let prompt = PromptSnapshot::from_turn(&turns[4]).unwrap();
        let (point, boundary) =
            select_prompt_boundary(&turns, "turn-4", Some(&prompt), AgentType::Codex).unwrap();
        assert_eq!(point.message_occurrence, Some(2));
        assert!(validate_history(&boundary.fingerprints, &turns[..4]).is_ok());
        assert!(validate_history(&boundary.fingerprints, &turns[..2]).is_err());
        assert!(validate_history(&boundary.fingerprints, &turns).is_err());
        let mut abandoned_branch = turns[..4].to_vec();
        abandoned_branch[0].blocks = vec![ContentBlock::Text {
            text: "other branch".into(),
        }];
        assert!(validate_history(&boundary.fingerprints, &abandoned_branch).is_err());
    }

    #[test]
    fn historical_fork_rejects_missing_or_drifted_user_selection() {
        let turns = history_turns(&[
            (TurnRole::User, "first"),
            (TurnRole::Assistant, "reply"),
            (TurnRole::User, "second"),
        ]);
        let original = PromptSnapshot::from_turn(&turns[2]).unwrap();
        for (id, selection) in [
            ("gone", Some(&original)),
            ("turn-1", Some(&original)),
            ("turn-2", None),
        ] {
            assert!(select_prompt_boundary(&turns, id, selection, AgentType::ClaudeCode).is_err());
        }
        let mut changed = turns.clone();
        changed[2].blocks = vec![ContentBlock::Text {
            text: "different message".into(),
        }];
        assert!(
            select_prompt_boundary(&changed, "turn-2", Some(&original), AgentType::ClaudeCode,)
                .is_err()
        );
        changed[2] = turns[2].clone();
        changed[2].timestamp += chrono::Duration::seconds(1);
        assert!(
            select_prompt_boundary(&changed, "turn-2", Some(&original), AgentType::ClaudeCode,)
                .is_err()
        );
        assert!(select_prompt_boundary(&turns, "turn-2", Some(&original), AgentType::Pi,).is_err());
    }

    #[test]
    fn historical_fork_preserves_all_steps_and_rejects_compressed_or_incomplete_history() {
        let mut turns = history_turns(&[
            (TurnRole::User, "inspect"),
            (TurnRole::Assistant, "checking"),
            (TurnRole::Assistant, "finished"),
            (TurnRole::User, "continue"),
        ]);
        turns[1].blocks.push(ContentBlock::Thinking {
            text: "reasoning".into(),
        });
        let prompt = PromptSnapshot::from_turn(&turns[3]).unwrap();
        let (_, boundary) =
            select_prompt_boundary(&turns, "turn-3", Some(&prompt), AgentType::DeepSeek).unwrap();
        let mut forked = turns[..3].to_vec();
        for message in &mut forked {
            message.id = format!("new-{}", message.id);
            message.timestamp += chrono::Duration::hours(1);
            message.completed_at = None;
            message.agent_message_id = Some("rewritten".into());
        }
        assert!(validate_history(&boundary.fingerprints, &forked).is_ok());
        forked.remove(1);
        assert!(validate_history(&boundary.fingerprints, &forked).is_err());
        let compressed = history_turns(&[(TurnRole::System, "summary of earlier history")]);
        assert!(validate_history(&boundary.fingerprints, &compressed).is_err());
    }

    #[test]
    fn historical_fork_handles_empty_replies_only_when_the_agent_can_name_them() {
        let mut turns = history_turns(&[
            (TurnRole::User, "first"),
            (TurnRole::Assistant, ""),
            (TurnRole::User, "second"),
        ]);
        let prompt = PromptSnapshot::from_turn(&turns[2]).unwrap();
        assert!(
            select_prompt_boundary(&turns, "turn-2", Some(&prompt), AgentType::ClaudeCode,)
                .is_err()
        );
        turns[1].agent_message_id = Some("assistant-with-tools".into());
        let (_, boundary) =
            select_prompt_boundary(&turns, "turn-2", Some(&prompt), AgentType::ClaudeCode).unwrap();
        assert!(validate_history(&boundary.fingerprints, &turns[..2]).is_ok());
        assert!(
            select_prompt_boundary(&turns, "turn-2", Some(&prompt), AgentType::Codex,).is_err()
        );
    }

    #[tokio::test]
    async fn historical_fork_recovery_without_boundary_proof_never_creates_a_row() {
        use sea_orm::{EntityTrait, PaginatorTrait};
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let record = Recovery {
            request_id: "legacy-history".into(),
            source_conversation_id: 1,
            source_session_id: "S1".into(),
            branch_session_id: "S2".into(),
            source_turn_id: Some("turn-2".into()),
            before_prompt: true,
            history: None,
        };
        assert!(persist(&db, &record).await.is_err());
        assert_eq!(
            crate::db::entities::conversation::Entity::find()
                .count(&db.conn)
                .await
                .unwrap(),
            0
        );
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
            before_prompt: false,
            history: None,
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
                source_turn_id: None,
                source_prompt: None,
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
        state.write().await.agent_type = AgentType::Codex;
        assert!(wait_ready(&manager, "temp", "S1").await.is_ok());
        state.write().await.external_id = Some("S1".into());
        assert!(wait_ready(&manager, "temp", "S1").await.is_err());
        state.write().await.external_id = None;
        assert!(wait_ready(&manager, "temp", "S1").await.is_err());
        state.write().await.agent_type = AgentType::ClaudeCode;
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
            before_prompt: false,
            history: None,
        };
        append_recovery(&path, &record, true).await.unwrap();
        let manager = ConnectionManager::new();
        let request = CreateRequest {
            connection_id: "old-connection-gone".into(),
            source_conversation_id: source_id,
            request_id: record.request_id,
            source_turn_id: None,
            source_prompt: None,
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
