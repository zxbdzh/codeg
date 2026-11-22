//! 原生终端会话的 Tauri/Web 共用核心。
//!
//! 分层职责：
//! * 这里负责来源身份校验、旁问历史读写、终端所有权与错误码映射；
//! * 主线 PTY 的"ACP ↔ 原生终端"安全切换交给 `native_session_main`；
//! * 旁问的 fork/落库交给 `native_side_session`，PTY 启动交给
//!   `native_side_terminal`。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::ConnectionStatus;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::entities::side_question_session;
use crate::db::service::{conversation_service, side_question_service};
use crate::db::AppDatabase;
use crate::models::AgentType;
use crate::native_session_main::{self, NativeSessionError, NativeTerminalHandle as MainTerminalHandle};
use crate::native_side_session::{self, CreateNativeSideQuestion};
use crate::native_side_terminal;
use crate::terminal::manager::TerminalManager;
use crate::web::event_bridge::EventEmitter;

/// 前端旁问列表项。`isOpen` 只表示手动关闭状态，已关闭的历史仍会返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSideQuestion {
    pub id: String,
    pub source_session_id: String,
    pub branch_session_id: String,
    pub agent_type: AgentType,
    pub cwd: String,
    pub title: String,
    pub is_open: bool,
}

/// 创建旁问的返回值。terminalId 必须对应一个已经启动的 PTY，否则不能返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCreatedSideQuestion {
    pub side_question: NativeSideQuestion,
    pub terminal_id: String,
}

/// open 系列命令的返回值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTerminalHandle {
    pub terminal_id: String,
}

/// close main 的返回值：终端已退出，ACP 已用原 session id 恢复。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRestoredAcp {
    pub connection_id: String,
}

/// 两种运行时都能提供的依赖。Tauri 从窗口 label 取所有权，Web 固定用
/// `"web"`（与 `acp_connect` 创建连接时一致）。
pub struct NativeSessionContext<'a> {
    pub db: &'a AppDatabase,
    pub manager: &'a ConnectionManager,
    pub terminals: &'a TerminalManager,
    pub emitter: EventEmitter,
    pub data_dir: &'a Path,
    pub owner_window_label: &'a str,
}

/// 已通过校验的来源会话事实。terminalId 与会话身份都从这里派生，避免信任
/// 前端重复传入的 session id。
struct Source {
    agent: AgentType,
    session_id: String,
}

/// 与前端 `NATIVE_TERMINAL_AGENTS` 保持一致；其余 agent fail closed。
fn supports_native_terminal(agent: AgentType) -> bool {
    matches!(
        agent,
        AgentType::Codex | AgentType::ClaudeCode | AgentType::Pi | AgentType::DeepSeek
    )
}

/// 同一 requestId 的重试必须命中同一个旁问 UUID；不同 request 必须互不
/// 覆盖。因此 UUID 只由来源身份 + requestId 派生，不含会在重连后变化的
/// connectionId。
struct SideIdentity {
    id: Uuid,
}

fn side_identity(
    agent: AgentType,
    source_session_id: &str,
    conversation_id: i32,
    request_id: &str,
) -> SideIdentity {
    let mut hasher = Sha256::new();
    hasher.update(agent.as_wire().as_bytes());
    hasher.update([0]);
    hasher.update(source_session_id.as_bytes());
    hasher.update([0]);
    hasher.update(conversation_id.to_string().as_bytes());
    hasher.update([0]);
    hasher.update(request_id.as_bytes());
    let digest = hasher.finalize();

    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    SideIdentity {
        id: Uuid::from_bytes(bytes),
    }
}

/// 记录"这条连接当前的主线终端句柄"。
///
/// 关闭终端后必须用原 session id 恢复 ACP，而恢复需要 open 时解析出的
/// 工作目录、mode/config 和 owner；只靠 connectionId + terminalId 重建不出来。
/// 进程退出时 PTY 也随之消失，因此这张表不必持久化。
fn main_terminals() -> &'static Mutex<HashMap<String, MainTerminalHandle>> {
    static MAIN_TERMINALS: OnceLock<Mutex<HashMap<String, MainTerminalHandle>>> = OnceLock::new();
    MAIN_TERMINALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_main_terminals() -> std::sync::MutexGuard<'static, HashMap<String, MainTerminalHandle>> {
    main_terminals()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 主线切换是"释放 ACP → 起 PTY → 登记句柄"三步，必须整体串行。
/// 否则两个并发 open 会各自释放一次 ACP；close 与 open 交错时，close 可能
/// 在 open 登记前就检查登记表，从而把正在打开的终端判成别人的。
static MAIN_TRANSITION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 旁问的 open/close/create 共用一把锁：终端是否存活、行是否 is_open 都要
/// 先读后写，串行化才能保证 PTY 与行的状态不会互相踩踏。fork 本身不持锁。
static SIDE_TRANSITION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn resolve_source(
    manager: &ConnectionManager,
    source_connection_id: &str,
    source_conversation_id: Option<i32>,
    requested_agent: AgentType,
) -> Result<Source, AppCommandError> {
    if source_connection_id.trim().is_empty() {
        return Err(AppCommandError::invalid_input(
            "sourceConnectionId is required",
        ));
    }
    let state = manager
        .get_state(source_connection_id)
        .await
        .ok_or_else(|| {
            AppCommandError::not_found(format!(
                "Connection {source_connection_id} is not available"
            ))
        })?;
    let snapshot = state.read().await;

    if !supports_native_terminal(snapshot.agent_type) {
        return Err(AppCommandError::invalid_input(
            "This agent has no native terminal session",
        ));
    }
    if snapshot.agent_type != requested_agent {
        return Err(AppCommandError::invalid_input(
            "sourceAgentType does not match the connection",
        ));
    }
    if !matches!(
        snapshot.status,
        ConnectionStatus::Connected | ConnectionStatus::Prompting
    ) {
        return Err(AppCommandError::invalid_input(
            "The source connection is not ready for a native terminal",
        ));
    }
    // ACP 连接若已绑定 conversation，前端不能拿另一个 conversation id 来
    // 借同一条连接；None 只表示"调用方不关心"，不是绕过身份校验。
    if snapshot
        .conversation_id
        .is_some_and(|id| Some(id) != source_conversation_id)
    {
        return Err(AppCommandError::invalid_input(
            "Source conversation does not match the connection",
        ));
    }
    let session_id = snapshot
        .external_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            AppCommandError::invalid_input("The source connection has no native session")
        })?;
    // 只校验不保存：真正的工作目录由 `native_session_main` 从 ACP/DB 重新
    // 解析，避免这里成为第二个真相来源。
    if snapshot
        .working_dir
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.trim().is_empty())
        .is_none()
    {
        return Err(AppCommandError::invalid_input(
            "The source connection has no working directory",
        ));
    }

    Ok(Source {
        agent: snapshot.agent_type,
        session_id,
    })
}

/// create 前额外核对数据库行，避免连接状态与 conversation 记录各说各话。
async fn ensure_conversation_matches(
    db: &AppDatabase,
    conversation_id: i32,
    source: &Source,
) -> Result<(), AppCommandError> {
    let row = conversation_service::get_by_id(&db.conn, conversation_id)
        .await
        .map_err(|error| AppCommandError::not_found(error.to_string()))?;
    if row.external_id.as_deref() != Some(source.session_id.as_str()) || row.agent_type != source.agent
    {
        return Err(AppCommandError::invalid_input(
            "Source conversation does not match the connection",
        ));
    }
    Ok(())
}

fn parse_side_question_id(value: &str) -> Result<Uuid, AppCommandError> {
    Uuid::parse_str(value.trim())
        .map_err(|_| AppCommandError::invalid_input("sideQuestionId must be a UUID"))
}

fn kill_if_alive(terminals: &TerminalManager, terminal_id: &str) -> Result<(), AppCommandError> {
    // snapshot.alive 对"未知 id"和"已结束"都返回 false，因此关闭天然幂等。
    if !terminals.snapshot(terminal_id).alive {
        return Ok(());
    }
    terminals.kill(terminal_id).map_err(|error| {
        use crate::terminal::error::TerminalError;
        match error {
            TerminalError::NotFound(_) => AppCommandError::not_found(error.to_string()),
            _ => AppCommandError::task_execution_failed(error.to_string()),
        }
    })
}

/// 数据库行到前端契约的唯一转换点；list/create 必须返回同一形状。
fn side_view(row: side_question_session::Model, fallback_agent: AgentType) -> NativeSideQuestion {
    NativeSideQuestion {
        id: row.id,
        source_session_id: row.source_session_id,
        branch_session_id: row.native_session_id,
        // 历史行按自己的 agent 回显；解析失败时退回调用方已校验的来源。
        agent_type: AgentType::from_wire(&row.source_agent_type).unwrap_or(fallback_agent),
        cwd: row.cwd,
        title: row.title,
        is_open: row.is_open,
    }
}

fn map_native_error(error: NativeSessionError) -> AppCommandError {
    use NativeSessionError::*;
    match error {
        ConnectionNotFound(message) => AppCommandError::not_found(message),
        IdentityMismatch(message) => AppCommandError::invalid_input(message),
        UnsupportedAgent(agent) => AppCommandError::invalid_input(format!(
            "Agent {} has no native terminal resume path",
            agent.as_wire()
        )),
        NoWorkingDir => AppCommandError::invalid_input(
            "The source session has no working directory to resume in",
        ),
        WorkingDirMissing(path) => AppCommandError::invalid_input(format!(
            "The source working directory no longer exists: {path}"
        )),
        // 忙碌是用户可等待的状态，HTTP 层映射为 409，不能伪装成服务器故障。
        Busy => AppCommandError::new(
            AppErrorCode::TurnInProgress,
            "The session is busy; wait for the running turn to finish",
        ),
        TerminalOwnerMismatch { .. } => AppCommandError::permission_denied(error.to_string()),
        AcpRelease(message) | Acp(message) | Terminal(message) | TerminalStillRunning(message) => {
            AppCommandError::task_execution_failed(message)
        }
        Db(message) => AppCommandError::database_error(message),
    }
}

pub async fn native_session_list_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    source_connection_id: &str,
    source_conversation_id: Option<i32>,
    source_agent_type: AgentType,
) -> Result<Vec<NativeSideQuestion>, AppCommandError> {
    let source = if !source_connection_id.trim().is_empty()
        && manager.get_state(source_connection_id).await.is_some()
    {
        resolve_source(
            manager,
            source_connection_id,
            source_conversation_id,
            source_agent_type,
        )
        .await?
    } else if let Some(conversation_id) = source_conversation_id {
        let row = conversation_service::get_by_id(&db.conn, conversation_id)
            .await
            .map_err(AppCommandError::db)?;
        if row.agent_type != source_agent_type || !supports_native_terminal(row.agent_type) {
            return Err(AppCommandError::invalid_input(
                "Source conversation does not match the requested agent",
            ));
        }
        let session_id = row
            .external_id
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| {
                AppCommandError::invalid_input("The source conversation has no native session")
            })?;
        Source {
            agent: row.agent_type,
            session_id,
        }
    } else {
        return Err(AppCommandError::not_found(format!(
            "Connection {source_connection_id} is not available"
        )));
    };
    let rows = side_question_service::list_by_source(&db.conn, source.agent, &source.session_id)
        .await
        .map_err(AppCommandError::db)?;
    Ok(rows
        .into_iter()
        .map(|row| side_view(row, source.agent))
        .collect())
}

pub async fn native_session_create_side_core(
    context: &NativeSessionContext<'_>,
    source_connection_id: &str,
    source_conversation_id: Option<i32>,
    source_agent_type: AgentType,
    request_id: &str,
    title: &str,
) -> Result<NativeCreatedSideQuestion, AppCommandError> {
    let source = resolve_source(
        context.manager,
        source_connection_id,
        source_conversation_id,
        source_agent_type,
    )
    .await?;
    // 旁问必须绑定一条真实 conversation：fork 的锚点与历史都从它读，
    // 允许 None 会让调用方在错误的会话上悄悄造出旁问。
    let conversation_id = source_conversation_id
        .ok_or_else(|| AppCommandError::invalid_input("sourceConversationId is required"))?;
    ensure_conversation_matches(context.db, conversation_id, &source).await?;

    // 幂等键先校验：格式错误的请求在任何 fork 之前失败，不占用 requestId。
    let request_id = request_id.trim();
    crate::research_branch::validate_request_id(request_id)?;
    let title = title.trim();
    if title.is_empty() {
        return Err(AppCommandError::invalid_input(
            "A side-question title is required",
        ));
    }

    // 同一 requestId 必须命中同一个旁问 UUID；identity 只由来源身份派生，
    // 这样重试、重连或换窗口都不会造出第二条旁问。
    let identity = side_identity(source.agent, &source.session_id, conversation_id, request_id);
    let request = CreateNativeSideQuestion {
        request_id: request_id.to_string(),
        side_question_id: identity.id,
        connection_id: source_connection_id.to_string(),
        source_conversation_id: conversation_id,
        title: title.to_string(),
        completed_turn_id: None,
    };
    native_side_session::create(context.db, context.manager, context.data_dir, request).await?;

    // fork 已完成，进入本地状态转换区；锁只覆盖 PTY 启动和 is_open 翻转。
    let _transition = SIDE_TRANSITION.lock().await;
    // fork 期间同一行可能已被另一请求关闭，必须重读而不是使用 fork 返回的
    // 陈旧快照，否则会把已关闭记录误判为打开或反之。
    let mut record = side_question_service::get(&context.db.conn, identity.id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Side question {} was not found", identity.id))
        })?;

    // fork 已经落库后才起 PTY。启动失败必须保留这条记录并明确告知 id，
    // 前端可以稍后 open 重试；绝不能返回一个并不存在的 terminalId。
    let terminal_id = native_side_terminal::open(
        context.db,
        context.terminals,
        context.emitter.clone(),
        context.data_dir,
        context.owner_window_label,
        &record,
    )
    .await
    .map_err(|error| {
        let detail = match error.detail.as_deref() {
            Some(existing) => format!(
                "sideQuestionId={} was created but its terminal did not start: {existing}",
                record.id
            ),
            None => format!(
                "sideQuestionId={} was created but its terminal did not start",
                record.id
            ),
        };
        error.with_detail(detail)
    })?;

    // 幂等重试可能命中一条手动关闭过的记录；既然 PTY 已经起来，状态必须回到
    // 打开，否则列表和实际终端会互相矛盾。
    if !record.is_open {
        record = side_question_service::reopen(&context.db.conn, identity.id)
            .await
            .map_err(AppCommandError::db)?
            .ok_or_else(|| {
                AppCommandError::not_found(format!("Side question {} was not found", identity.id))
            })?;
    }

    Ok(NativeCreatedSideQuestion {
        side_question: side_view(record, source.agent),
        terminal_id,
    })
}

pub async fn native_session_open_side_core(
    context: &NativeSessionContext<'_>,
    side_question_id: &str,
) -> Result<NativeTerminalHandle, AppCommandError> {
    let _transition = SIDE_TRANSITION.lock().await;
    let id = parse_side_question_id(side_question_id)?;
    let row = side_question_service::get(&context.db.conn, id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| AppCommandError::not_found(format!("Side question {id} was not found")))?;
    // 只读参数与 CLI 入口全部由 `native_side_terminal` 校验；它也会拒绝
    // 指向主线的行和不支持只读终端的 agent。
    let terminal_id = native_side_terminal::open(
        context.db,
        context.terminals,
        context.emitter.clone(),
        context.data_dir,
        context.owner_window_label,
        &row,
    )
    .await?;

    // 已关闭的旁问仍可重新打开（历史保留），终端真的起来后再翻转状态。
    if !row.is_open {
        side_question_service::reopen(&context.db.conn, id)
            .await
            .map_err(AppCommandError::db)?;
    }

    Ok(NativeTerminalHandle { terminal_id })
}

pub async fn native_session_close_side_core(
    context: &NativeSessionContext<'_>,
    side_question_id: &str,
) -> Result<(), AppCommandError> {
    let _transition = SIDE_TRANSITION.lock().await;
    let id = parse_side_question_id(side_question_id)?;
    // 先确认行存在，避免"未知 id"被当成成功；随后按派生 id 结束 PTY。
    side_question_service::get(&context.db.conn, id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| AppCommandError::not_found(format!("Side question {id} was not found")))?;
    // 终端 id 固定由旁问 UUID 派生，任何窗口都不能用别的 id 关到它。
    let terminal_id = native_side_terminal::side_terminal_id(&id.to_string())?;
    if let Some(owner) = context.terminals.owner_window_label_of(&terminal_id) {
        if owner != context.owner_window_label {
            return Err(AppCommandError::permission_denied(format!(
                "Terminal {terminal_id} belongs to window {owner}, not {}",
                context.owner_window_label
            )));
        }
    }
    kill_if_alive(context.terminals, &terminal_id)?;
    side_question_service::close(&context.db.conn, id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| AppCommandError::not_found(format!("Side question {id} was not found")))?;
    Ok(())
}

pub async fn native_session_open_main_core(
    context: &NativeSessionContext<'_>,
    source_connection_id: &str,
    source_conversation_id: Option<i32>,
    source_agent_type: AgentType,
) -> Result<NativeTerminalHandle, AppCommandError> {
    let _transition = MAIN_TRANSITION.lock().await;

    // 防重入：同一连接已经切到原生终端时不能再释放一次 ACP（那时连接已不存在）。
    // 同 owner 且进程仍存活就复用同一 terminalId。
    let registered = lock_main_terminals().get(source_connection_id).cloned();
    if let Some(existing) = registered {
        if existing.identity.owner_window_label != context.owner_window_label {
            return Err(AppCommandError::permission_denied(format!(
                "Terminal {} belongs to window {}, not {}",
                existing.terminal_id,
                existing.identity.owner_window_label,
                context.owner_window_label
            )));
        }
        if existing.identity.agent_type != source_agent_type
            || existing
                .identity
                .conversation_id
                .is_some_and(|id| Some(id) != source_conversation_id)
        {
            return Err(AppCommandError::invalid_input(
                "Source conversation or agent does not match the terminal",
            ));
        }
        if context.terminals.snapshot(&existing.terminal_id).alive {
            return Ok(NativeTerminalHandle {
                terminal_id: existing.terminal_id,
            });
        }
        if context.manager.get_state(source_connection_id).await.is_none() {
            // 终端退出后仍需保留句柄，才能使用原会话身份恢复 ACP。
            return Err(AppCommandError::invalid_input(
                "The native terminal has exited; restore the ACP session first",
            ));
        }
        lock_main_terminals().remove(source_connection_id);
    }

    let source = resolve_source(
        context.manager,
        source_connection_id,
        source_conversation_id,
        source_agent_type,
    )
    .await?;

    // 真正的"先释放 ACP、再起 PTY"由 native_session_main 完成；这里只提供
    // 已经校验过的来源身份和调用方窗口，避免接线层重复实现切换顺序。
    let handle = native_session_main::switch_acp_to_native(
        context.db,
        context.manager,
        context.terminals,
        context.emitter.clone(),
        context.data_dir,
        context.owner_window_label,
        source_connection_id,
        &source.session_id,
    )
    .await
    .map_err(map_native_error)?;

    // 保存完整句柄：关闭终端后恢复 ACP 需要 cwd、mode/config 和 owner。
    lock_main_terminals().insert(source_connection_id.to_string(), handle.clone());
    Ok(NativeTerminalHandle {
        terminal_id: handle.terminal_id,
    })
}

pub async fn native_session_close_main_core(
    context: &NativeSessionContext<'_>,
    source_connection_id: &str,
    terminal_id: &str,
) -> Result<NativeRestoredAcp, AppCommandError> {
    let _transition = MAIN_TRANSITION.lock().await;
    if source_connection_id.trim().is_empty() {
        return Err(AppCommandError::invalid_input(
            "sourceConnectionId is required",
        ));
    }
    if terminal_id.trim().is_empty() {
        return Err(AppCommandError::invalid_input("terminalId is required"));
    }

    let handle = lock_main_terminals()
        .get(source_connection_id)
        .cloned()
        // 登记表只由 open_main 写入；没有登记就说明这个 terminalId 不是本连接
        // 切出来的，不能凭前端口述的 id 去结束任意终端。
        .ok_or_else(|| {
            AppCommandError::permission_denied(
                "This terminal does not belong to the source connection",
            )
        })?;
    if handle.terminal_id != terminal_id {
        return Err(AppCommandError::permission_denied(
            "This terminal does not belong to the source connection",
        ));
    }
    if handle.identity.owner_window_label != context.owner_window_label {
        return Err(AppCommandError::permission_denied(format!(
            "Terminal {terminal_id} belongs to window {}, not {}",
            handle.identity.owner_window_label, context.owner_window_label
        )));
    }

    // 先摘除登记再恢复：并发关闭/重复点击只能有一个真正执行切换；失败时
    // 放回句柄，让用户仍能重试。
    lock_main_terminals().remove(source_connection_id);
    let restored = native_session_main::switch_native_to_acp(
        context.db,
        context.manager,
        context.terminals,
        context.emitter.clone(),
        context.data_dir,
        handle.clone(),
    )
    .await;
    match restored {
        Ok(restored) => Ok(NativeRestoredAcp {
            connection_id: restored.connection_id,
        }),
        Err(error) => {
            lock_main_terminals().insert(source_connection_id.to_string(), handle);
            Err(map_native_error(error))
        }
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn native_session_list(
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    source_connection_id: String,
    source_conversation_id: Option<i32>,
    source_agent_type: AgentType,
) -> Result<Vec<NativeSideQuestion>, AppCommandError> {
    native_session_list_core(
        &db,
        &manager,
        &source_connection_id,
        source_conversation_id,
        source_agent_type,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
// 参数数量由前端命令契约固定，拆成嵌套对象会改变 invoke 的入参形状。
#[allow(clippy::too_many_arguments)]
pub async fn native_session_create_side(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    terminals: tauri::State<'_, TerminalManager>,
    source_connection_id: String,
    source_conversation_id: Option<i32>,
    source_agent_type: AgentType,
    request_id: String,
    title: String,
) -> Result<NativeCreatedSideQuestion, AppCommandError> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?;
    let data_dir = crate::paths::resolve_effective_data_dir(&directory);
    native_session_create_side_core(
        &NativeSessionContext {
            db: &db,
            manager: &manager,
            terminals: &terminals,
            emitter: EventEmitter::from_app(&app),
            data_dir: &data_dir,
            owner_window_label: window.label(),
        },
        &source_connection_id,
        source_conversation_id,
        source_agent_type,
        &request_id,
        &title,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn native_session_open_side(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    terminals: tauri::State<'_, TerminalManager>,
    side_question_id: String,
) -> Result<NativeTerminalHandle, AppCommandError> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?;
    let data_dir = crate::paths::resolve_effective_data_dir(&directory);
    native_session_open_side_core(
        &NativeSessionContext {
            db: &db,
            manager: &manager,
            terminals: &terminals,
            emitter: EventEmitter::from_app(&app),
            data_dir: &data_dir,
            owner_window_label: window.label(),
        },
        &side_question_id,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn native_session_close_side(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    terminals: tauri::State<'_, TerminalManager>,
    side_question_id: String,
) -> Result<(), AppCommandError> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?;
    let data_dir = crate::paths::resolve_effective_data_dir(&directory);
    native_session_close_side_core(
        &NativeSessionContext {
            db: &db,
            manager: &manager,
            terminals: &terminals,
            emitter: EventEmitter::from_app(&app),
            data_dir: &data_dir,
            owner_window_label: window.label(),
        },
        &side_question_id,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
// 同上：前端按扁平字段传入来源身份，这里不能私自改契约。
#[allow(clippy::too_many_arguments)]
pub async fn native_session_open_main(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    terminals: tauri::State<'_, TerminalManager>,
    source_connection_id: String,
    source_conversation_id: Option<i32>,
    source_agent_type: AgentType,
) -> Result<NativeTerminalHandle, AppCommandError> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?;
    let data_dir = crate::paths::resolve_effective_data_dir(&directory);
    native_session_open_main_core(
        &NativeSessionContext {
            db: &db,
            manager: &manager,
            terminals: &terminals,
            emitter: EventEmitter::from_app(&app),
            data_dir: &data_dir,
            owner_window_label: window.label(),
        },
        &source_connection_id,
        source_conversation_id,
        source_agent_type,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn native_session_close_main(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    terminals: tauri::State<'_, TerminalManager>,
    source_connection_id: String,
    terminal_id: String,
) -> Result<NativeRestoredAcp, AppCommandError> {
    use tauri::Manager;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?;
    let data_dir = crate::paths::resolve_effective_data_dir(&directory);
    native_session_close_main_core(
        &NativeSessionContext {
            db: &db,
            manager: &manager,
            terminals: &terminals,
            emitter: EventEmitter::from_app(&app),
            data_dir: &data_dir,
            owner_window_label: window.label(),
        },
        &source_connection_id,
        &terminal_id,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;
    use crate::db::service::side_question_service::NewSideQuestion;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};

    const CONNECTION: &str = "conn-native-1";
    const SESSION: &str = "native-session-1";

    struct Fixture {
        db: AppDatabase,
        manager: ConnectionManager,
        terminals: TerminalManager,
        conversation_id: i32,
        cwd: String,
        data_dir: std::path::PathBuf,
    }

    async fn fixture(agent: AgentType) -> Fixture {
        let db = fresh_in_memory_db().await;
        let cwd = std::env::temp_dir().join("native-session-fixture");
        let cwd = cwd.to_string_lossy().into_owned();
        let folder_id = seed_folder(&db, &cwd).await;
        let conversation_id = seed_conversation(&db, folder_id, agent).await;
        conversation_service::bind_external_id(&db.conn, conversation_id, SESSION, &[])
            .await
            .expect("bind native session");

        let manager = ConnectionManager::new();
        manager
            .insert_test_connection(
                CONNECTION,
                agent,
                Some(std::path::PathBuf::from(&cwd)),
                EventEmitter::Noop,
            )
            .await;
        {
            let state = manager.get_state(CONNECTION).await.expect("connection");
            let mut snapshot = state.write().await;
            snapshot.conversation_id = Some(conversation_id);
            snapshot.external_id = Some(SESSION.to_string());
        }

        Fixture {
            db,
            manager,
            terminals: TerminalManager::new(),
            conversation_id,
            cwd,
            data_dir: std::env::temp_dir(),
        }
    }

    impl Fixture {
        fn context(&self) -> NativeSessionContext<'_> {
            NativeSessionContext {
                db: &self.db,
                manager: &self.manager,
                terminals: &self.terminals,
                emitter: EventEmitter::Noop,
                data_dir: &self.data_dir,
                owner_window_label: "test-window",
            }
        }
    }

    async fn seed_side(fixture: &Fixture, id: u128, title: &str) -> Uuid {
        let id = Uuid::from_u128(id);
        seed_side_with(
            fixture,
            id.as_u128(),
            title,
            AgentType::Codex,
            &format!("child-{id}"),
        )
        .await
    }

    async fn seed_side_with(
        fixture: &Fixture,
        id: u128,
        title: &str,
        agent: AgentType,
        native_session_id: &str,
    ) -> Uuid {
        let id = Uuid::from_u128(id);
        side_question_service::create(
            &fixture.db.conn,
            NewSideQuestion {
                id,
                source_agent: agent,
                source_session_id: SESSION.into(),
                native_session_id: native_session_id.into(),
                cwd: fixture.cwd.clone(),
                pi_session_file: None,
                title: title.into(),
            },
        )
        .await
        .expect("seed side question");
        id
    }

    fn code(error: &AppCommandError) -> AppErrorCode {
        error.code
    }

    #[test]
    fn side_identity_is_stable_across_retries() {
        let first = side_identity(AgentType::Codex, SESSION, 7, "request-1");
        let second = side_identity(AgentType::Codex, SESSION, 7, "request-1");
        assert_eq!(first.id, second.id);

        let other = side_identity(AgentType::Codex, SESSION, 7, "request-2");
        assert_ne!(first.id, other.id);
    }

    #[test]
    fn only_the_frontend_agents_are_supported() {
        for agent in [
            AgentType::Codex,
            AgentType::ClaudeCode,
            AgentType::Pi,
            AgentType::DeepSeek,
        ] {
            assert!(supports_native_terminal(agent));
        }
        assert!(!supports_native_terminal(AgentType::Gemini));
        assert!(!supports_native_terminal(AgentType::OpenCode));
    }

    #[tokio::test]
    async fn list_returns_closed_history_with_camel_case_identity() {
        let fixture = fixture(AgentType::Codex).await;
        let open_id = seed_side(&fixture, 1, "仍然打开").await;
        let closed_id = seed_side(&fixture, 2, "已经关闭").await;
        side_question_service::close(&fixture.db.conn, closed_id)
            .await
            .expect("close")
            .expect("row exists");

        let rows = native_session_list_core(
            &fixture.db,
            &fixture.manager,
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::Codex,
        )
        .await
        .expect("list side questions");

        assert_eq!(rows.len(), 2);
        let open = rows.iter().find(|row| row.id == open_id.to_string()).unwrap();
        let closed = rows
            .iter()
            .find(|row| row.id == closed_id.to_string())
            .unwrap();
        assert!(open.is_open);
        assert!(!closed.is_open, "closed history must stay listed");
        assert_eq!(open.source_session_id, SESSION);
        assert_eq!(open.branch_session_id, format!("child-{open_id}"));
        assert_eq!(open.agent_type, AgentType::Codex);

        let json = serde_json::to_value(open).expect("serialize");
        assert_eq!(json["sourceSessionId"], SESSION);
        assert_eq!(json["branchSessionId"], format!("child-{open_id}"));
        assert_eq!(json["isOpen"], true);
        assert_eq!(json["agentType"], "codex");
    }

    #[tokio::test]
    async fn list_rejects_an_agent_that_differs_from_the_connection() {
        let fixture = fixture(AgentType::Codex).await;
        let error = native_session_list_core(
            &fixture.db,
            &fixture.manager,
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::ClaudeCode,
        )
        .await
        .expect_err("mismatched agent must be refused");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn list_rejects_an_unsupported_agent() {
        let fixture = fixture(AgentType::Gemini).await;
        let error = native_session_list_core(
            &fixture.db,
            &fixture.manager,
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::Gemini,
        )
        .await
        .expect_err("unsupported agent must be refused");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn list_rejects_a_connection_without_a_native_session() {
        let fixture = fixture(AgentType::Codex).await;
        let state = fixture.manager.get_state(CONNECTION).await.unwrap();
        state.write().await.external_id = None;

        let error = native_session_list_core(
            &fixture.db,
            &fixture.manager,
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::Codex,
        )
        .await
        .expect_err("missing native session must be refused");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn list_rejects_a_connection_without_a_working_directory() {
        let fixture = fixture(AgentType::Codex).await;
        let state = fixture.manager.get_state(CONNECTION).await.unwrap();
        state.write().await.working_dir = None;

        let error = native_session_list_core(
            &fixture.db,
            &fixture.manager,
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::Codex,
        )
        .await
        .expect_err("missing cwd must be refused");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn list_rejects_a_conversation_from_another_connection() {
        let fixture = fixture(AgentType::Codex).await;
        let error = native_session_list_core(
            &fixture.db,
            &fixture.manager,
            CONNECTION,
            Some(fixture.conversation_id + 1),
            AgentType::Codex,
        )
        .await
        .expect_err("mismatched conversation must be refused");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn list_reports_an_unknown_connection() {
        let fixture = fixture(AgentType::Codex).await;
        let error = native_session_list_core(
            &fixture.db,
            &fixture.manager,
            "missing-connection",
            None,
            AgentType::Codex,
        )
        .await
        .expect_err("unknown connection must be reported");
        assert!(matches!(code(&error), AppErrorCode::NotFound));
    }

    #[tokio::test]
    async fn list_preserves_side_history_after_the_source_connection_is_gone() {
        let fixture = fixture(AgentType::Codex).await;
        let id = seed_side(&fixture, 3, "重启后继续查看").await;
        fixture.manager.connections.lock().await.remove(CONNECTION);

        let rows = native_session_list_core(
            &fixture.db,
            &fixture.manager,
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::Codex,
        )
        .await
        .expect("persisted side questions remain accessible without a live ACP connection");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id.to_string());
        assert!(rows[0].is_open);
    }

    #[tokio::test]
    async fn close_side_flips_the_row_even_after_the_connection_is_gone() {
        let fixture = fixture(AgentType::Codex).await;
        let id = seed_side(&fixture, 10, "待关闭").await;

        native_session_close_side_core(&fixture.context(), &id.to_string())
            .await
            .expect("close side question");

        let row = side_question_service::get(&fixture.db.conn, id)
            .await
            .expect("get")
            .expect("row exists");
        assert!(!row.is_open);
    }

    #[tokio::test]
    async fn close_side_is_idempotent() {
        let fixture = fixture(AgentType::Codex).await;
        let id = seed_side(&fixture, 11, "重复关闭").await;

        // 重复点击或网络重试不应因为"已经关闭"而报错。
        for _ in 0..2 {
            native_session_close_side_core(&fixture.context(), &id.to_string())
                .await
                .expect("repeat close must succeed");
        }

        let row = side_question_service::get(&fixture.db.conn, id)
            .await
            .expect("get")
            .expect("row exists");
        assert!(!row.is_open);
    }

    #[tokio::test]
    async fn close_side_reports_unknown_and_malformed_ids() {
        let fixture = fixture(AgentType::Codex).await;
        let error = native_session_close_side_core(
            &fixture.context(),
            &Uuid::from_u128(99).to_string(),
        )
        .await
        .expect_err("unknown id must be reported");
        assert!(matches!(code(&error), AppErrorCode::NotFound));

        let error = native_session_close_side_core(&fixture.context(), "not-a-uuid")
            .await
            .expect_err("malformed id must be refused");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn close_main_rejects_a_terminal_it_does_not_own() {
        let fixture = fixture(AgentType::Codex).await;
        let error = native_session_close_main_core(
            &fixture.context(),
            CONNECTION,
            "native-main-someone-else",
        )
        .await
        .expect_err("an unregistered terminal must be refused");
        assert!(matches!(code(&error), AppErrorCode::PermissionDenied));
    }

    #[tokio::test]
    async fn close_main_rejects_a_terminal_from_another_window() {
        let fixture = fixture(AgentType::Codex).await;
        let terminal_id = "native-main-window-check".to_string();
        // 只有 open_main 能造出完整句柄；这里直接登记一个，验证 close 不会
        // 因为 terminalId 相同就跳过窗口所有权检查。
        lock_main_terminals().insert(
            CONNECTION.to_string(),
            native_session_main::NativeTerminalHandle {
                terminal_id: terminal_id.clone(),
                identity: native_session_main::SessionIdentity {
                    agent_type: AgentType::Codex,
                    session_id: SESSION.into(),
                    working_dir: std::path::PathBuf::from(&fixture.cwd),
                    conversation_id: Some(fixture.conversation_id),
                    folder_id: None,
                    owner_window_label: "another-window".into(),
                },
                runtime_env: Default::default(),
                mode: None,
                config_values: Default::default(),
            },
        );

        let error = native_session_close_main_core(&fixture.context(), CONNECTION, &terminal_id)
            .await
            .expect_err("another window's terminal must be refused");
        assert!(matches!(code(&error), AppErrorCode::PermissionDenied));
        lock_main_terminals().remove(CONNECTION);
    }

    #[tokio::test]
    async fn close_main_rejects_a_terminal_id_that_differs_from_the_registered_handle() {
        let fixture = fixture(AgentType::Codex).await;
        lock_main_terminals().insert(
            CONNECTION.to_string(),
            native_session_main::NativeTerminalHandle {
                terminal_id: "native-main-registered".into(),
                identity: native_session_main::SessionIdentity {
                    agent_type: AgentType::Codex,
                    session_id: SESSION.into(),
                    working_dir: std::path::PathBuf::from(&fixture.cwd),
                    conversation_id: Some(fixture.conversation_id),
                    folder_id: None,
                    owner_window_label: "test-window".into(),
                },
                runtime_env: Default::default(),
                mode: None,
                config_values: Default::default(),
            },
        );

        // 同一连接下换一个 terminalId 也必须被拒绝，不能仅凭连接已登记
        // 就去结束任意终端。
        let error = native_session_close_main_core(
            &fixture.context(),
            CONNECTION,
            "native-main-different",
        )
        .await
        .expect_err("a mismatched terminal id must be refused");
        assert!(matches!(code(&error), AppErrorCode::PermissionDenied));
        assert!(
            lock_main_terminals().contains_key(CONNECTION),
            "a refused close must keep the registered handle"
        );
        lock_main_terminals().remove(CONNECTION);
    }

    #[tokio::test]
    async fn open_main_reports_an_unknown_connection() {
        let fixture = fixture(AgentType::Codex).await;
        let error = native_session_open_main_core(
            &fixture.context(),
            "missing-connection",
            None,
            AgentType::Codex,
        )
        .await
        .expect_err("unknown connection must be reported");
        assert!(matches!(code(&error), AppErrorCode::NotFound));
    }

    #[tokio::test]
    async fn open_main_reuses_its_terminal_after_the_acp_connection_is_released() {
        use crate::terminal::manager::ArgvSpawnOptions;

        let fixture = fixture(AgentType::Codex).await;
        let directory = tempfile::tempdir().expect("working directory");
        let terminal_id = Uuid::new_v4().to_string();
        let (program, args) = if cfg!(windows) {
            ("cmd.exe", vec!["/d", "/k"])
        } else {
            ("sleep", vec!["30"])
        };
        fixture
            .terminals
            .spawn_argv_with_id(
                ArgvSpawnOptions {
                    terminal_id: terminal_id.clone(),
                    program: program.to_string(),
                    args: args.into_iter().map(str::to_string).collect(),
                    working_dir: directory.path().to_string_lossy().into_owned(),
                    owner_window_label: "test-window".into(),
                    extra_env: None,
                    temp_files: vec![],
                },
                EventEmitter::Noop,
            )
            .expect("start test terminal");
        fixture.manager.connections.lock().await.remove(CONNECTION);
        lock_main_terminals().insert(
            CONNECTION.to_string(),
            native_session_main::NativeTerminalHandle {
                terminal_id: terminal_id.clone(),
                identity: native_session_main::SessionIdentity {
                    agent_type: AgentType::Codex,
                    session_id: SESSION.into(),
                    working_dir: directory.path().to_path_buf(),
                    conversation_id: Some(fixture.conversation_id),
                    folder_id: None,
                    owner_window_label: "test-window".into(),
                },
                runtime_env: Default::default(),
                mode: None,
                config_values: Default::default(),
            },
        );

        let reused = native_session_open_main_core(
            &fixture.context(),
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::Codex,
        )
        .await;
        let mismatched = native_session_open_main_core(
            &fixture.context(),
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::ClaudeCode,
        )
        .await;
        lock_main_terminals().remove(CONNECTION);
        let _ = fixture.terminals.kill(&terminal_id);

        assert_eq!(reused.expect("reuse existing terminal").terminal_id, terminal_id);
        assert!(matches!(
            code(&mismatched.expect_err("reject a different agent")),
            AppErrorCode::InvalidInput
        ));
    }

    #[tokio::test]
    async fn open_main_rejects_a_mismatched_agent_before_touching_the_session() {
        let fixture = fixture(AgentType::Codex).await;
        let error = native_session_open_main_core(
            &fixture.context(),
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::ClaudeCode,
        )
        .await
        .expect_err("mismatched agent must be refused");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn open_side_refuses_a_row_that_points_at_the_source_session() {
        let fixture = fixture(AgentType::Codex).await;
        // native_session_id == source_session_id 说明这一行指向主线；打开它
        // 等于绕过旁问的独立生命周期，必须在起 PTY 之前拒绝。
        let id = seed_side_with(&fixture, 20, "指向主线", AgentType::Codex, SESSION).await;
        let error = native_session_open_side_core(&fixture.context(), &id.to_string())
            .await
            .expect_err("a side question must not reopen the source session");

        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn open_side_refuses_an_agent_without_a_read_only_terminal() {
        let fixture = fixture(AgentType::Codex).await;
        let id =
            seed_side_with(&fixture, 21, "不支持的 agent", AgentType::Gemini, "child-gemini").await;
        let error = native_session_open_side_core(&fixture.context(), &id.to_string())
            .await
            .expect_err("Gemini has no read-only side terminal");

        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn open_side_reports_unknown_ids() {
        let fixture = fixture(AgentType::Codex).await;
        let error =
            native_session_open_side_core(&fixture.context(), &Uuid::from_u128(404).to_string())
                .await
                .expect_err("unknown side question must be reported");
        assert!(matches!(code(&error), AppErrorCode::NotFound));
    }

    #[tokio::test]
    async fn create_side_requires_a_request_id_and_a_title() {
        let fixture = fixture(AgentType::Codex).await;
        let error = native_session_create_side_core(
            &fixture.context(),
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::Codex,
            "",
            "为什么？",
        )
        .await
        .expect_err("an empty request id must be refused before any fork");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));

        let error = native_session_create_side_core(
            &fixture.context(),
            CONNECTION,
            Some(fixture.conversation_id),
            AgentType::Codex,
            "request-1",
            "   ",
        )
        .await
        .expect_err("an empty title must be refused before any fork");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));

        assert!(
            side_question_service::list_by_source(&fixture.db.conn, AgentType::Codex, SESSION)
                .await
                .expect("list")
                .is_empty(),
            "a failed create must not leave a side question behind"
        );
    }

    #[tokio::test]
    async fn create_side_requires_a_source_conversation() {
        let fixture = fixture(AgentType::Codex).await;
        let error = native_session_create_side_core(
            &fixture.context(),
            CONNECTION,
            None,
            AgentType::Codex,
            "request-1",
            "为什么？",
        )
        .await
        .expect_err("a source conversation is required");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }

    #[tokio::test]
    async fn create_side_rejects_a_conversation_that_is_not_bound_to_the_session() {
        let fixture = fixture(AgentType::Codex).await;
        let folder_id = seed_folder(&fixture.db, &fixture.cwd).await;
        let unbound = seed_conversation(&fixture.db, folder_id, AgentType::Codex).await;

        let error = native_session_create_side_core(
            &fixture.context(),
            CONNECTION,
            Some(unbound),
            AgentType::Codex,
            "request-1",
            "为什么？",
        )
        .await
        .expect_err("an unbound conversation must be refused");
        assert!(matches!(code(&error), AppErrorCode::InvalidInput));
    }
}
