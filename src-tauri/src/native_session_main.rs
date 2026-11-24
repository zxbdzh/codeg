//! 主会话在 ACP 适配器与原生终端之间切换的后端核心。
//!
//! 同一个 agent 会话在同一时刻只能有一个进程持有：ACP 适配器，或原生 CLI。
//! 所以切换永远是"先证明旧进程已退出并释放写入权，再让新进程接管"：
//!
//! * ACP → 原生：先核对连接、会话 id、窗口、agent 与工作目录，再在
//!   `disconnect_and_wait` 里拒绝忙碌会话并等待子进程被真正回收；释放失败
//!   直接返回，绝不再起一个终端。
//! * 原生 → ACP：先让终端进程退出并确认写入权已释放，再用**原 session id**
//!   恢复 ACP；任何一步失败都报错，不会静默新建会话。
//!
//! 本文件只提供核心编排，不接 Tauri 命令、路由或 UI。需要的错误码映射和事件
//! 由接线层完成。

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::ConnectionStatus;
use crate::db::service::{conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::models::AgentType;
use crate::terminal::error::TerminalError;
use crate::terminal::manager::{resolve_argv, ArgvSpawnOptions, TerminalManager};
use crate::web::event_bridge::EventEmitter;

/// ACP 子进程释放的等待上限。超时视为"仍被占用"，不允许继续开终端。
pub const ACP_RELEASE_TIMEOUT: Duration = Duration::from_secs(30);

/// 被验证过的源会话身份。工作目录取自 ACP 实际使用的目录（必要时回退到
/// conversation 的 origin cwd 或 folder 路径），不是调用方另传的猜测值。
#[derive(Debug, Clone)]
pub struct SessionIdentity {
    pub agent_type: AgentType,
    pub session_id: String,
    pub working_dir: PathBuf,
    pub conversation_id: Option<i32>,
    pub folder_id: Option<i32>,
    pub owner_window_label: String,
}

/// 已交给原生终端的会话。`runtime_env` 含 provider/凭据等敏感值，故意不实现
/// `Serialize`，避免接线层把它直接下发到前端。
#[derive(Debug, Clone)]
pub struct NativeTerminalHandle {
    pub terminal_id: String,
    pub identity: SessionIdentity,
    pub runtime_env: BTreeMap<String, String>,
    pub mode: Option<String>,
    pub config_values: BTreeMap<String, String>,
}

/// 终端退出后恢复出来的 ACP 连接。
#[derive(Debug, Clone)]
pub struct RestoredAcp {
    pub connection_id: String,
    pub agent_type: AgentType,
    pub session_id: String,
    pub working_dir: PathBuf,
    pub mode: Option<String>,
    pub config_values: BTreeMap<String, String>,
    /// 恢复时命中了同会话的既有连接（另一个客户端先接管了）。仍是同一个
    /// 会话，调用方据此决定是复用视图还是提示冲突，不得当成新会话。
    pub reused: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum NativeSessionError {
    #[error("ACP connection not found: {0}")]
    ConnectionNotFound(String),
    #[error("native session identity mismatch: {0}")]
    IdentityMismatch(String),
    #[error("agent {0} has no native terminal resume path")]
    UnsupportedAgent(AgentType),
    #[error("the source session has no working directory to resume in")]
    NoWorkingDir,
    #[error("the source working directory no longer exists: {0}")]
    WorkingDirMissing(String),
    /// 会话还有回合/目标/待确认交互在跑。切换只能等它结束，不能中断。
    #[error("ACP session is busy; wait for the running turn to finish")]
    Busy,
    #[error("ACP session release failed; no terminal was started: {0}")]
    AcpRelease(String),
    #[error("ACP error: {0}")]
    Acp(String),
    #[error("terminal error: {0}")]
    Terminal(String),
    #[error("terminal {0} is still alive; its write lock was not released")]
    TerminalStillRunning(String),
    #[error("terminal {terminal_id} belongs to window {owner}, not {expected}")]
    TerminalOwnerMismatch {
        terminal_id: String,
        owner: String,
        expected: String,
    },
    #[error("database error: {0}")]
    Db(String),
}

/// 把一个 ACP 主会话切到它的原生 CLI。
///
/// `connection_id` 和 `session_id` 是源身份：连接必须真实存在、绑定的
/// external id 必须等于 `session_id`、窗口和 agent 必须匹配，工作目录也必须
/// 仍存在。任何一项不符都在动连接之前失败。
///
/// 前置校验通过后才 `disconnect_and_wait`。该调用在 `prompt_lock` 下检查忙碌
/// 状态，并等 ACP 子进程被回收；失败时本函数直接返回，不会留下终端进程。
#[allow(clippy::too_many_arguments)]
pub async fn switch_acp_to_native(
    db: &AppDatabase,
    acp: &ConnectionManager,
    terminal: &TerminalManager,
    emitter: EventEmitter,
    data_dir: &Path,
    owner_window_label: &str,
    connection_id: &str,
    session_id: &str,
) -> Result<NativeTerminalHandle, NativeSessionError> {
    if connection_id.trim().is_empty() {
        return Err(NativeSessionError::IdentityMismatch(
            "connection id is required".into(),
        ));
    }
    if session_id.trim().is_empty() {
        return Err(NativeSessionError::IdentityMismatch(
            "session id is required".into(),
        ));
    }
    if owner_window_label.trim().is_empty() {
        return Err(NativeSessionError::IdentityMismatch(
            "owner window label is required".into(),
        ));
    }

    // 同一会话的切换串行化：并发点击或两个窗口同时切换时，只有一个能通过
    // 身份与释放检查，另一个会看到连接已消失而明确失败。
    let _switch = session_switch_lock(session_id).lock_owned().await;

    let state = acp
        .get_state(connection_id)
        .await
        .ok_or_else(|| NativeSessionError::ConnectionNotFound(connection_id.to_string()))?;
    let snapshot = {
        let s = state.read().await;
        SourceSnapshot {
            agent_type: s.agent_type,
            external_id: s.external_id.clone(),
            owner_window_label: s.owner_window_label.clone(),
            working_dir: s.working_dir.clone(),
            conversation_id: s.conversation_id,
            folder_id: s.folder_id,
            mode: s.current_mode.clone(),
            config_values: s.asserted_config_values.clone(),
            status: s.status.clone(),
            turn_in_flight: s.turn_in_flight,
            goal_active: s.goal_active,
            pending_permission: s.pending_permission.is_some(),
            pending_question: s.pending_question.is_some(),
        }
    };

    // 身份、窗口、agent 三者都来自 ACP 自己的状态，而不是调用方口述。
    match snapshot.external_id.as_deref() {
        Some(bound) if bound == session_id => {}
        Some(bound) => {
            return Err(NativeSessionError::IdentityMismatch(format!(
                "connection {connection_id} is bound to session {bound}, not {session_id}"
            )))
        }
        None => {
            return Err(NativeSessionError::IdentityMismatch(format!(
                "connection {connection_id} has no established session id"
            )))
        }
    }
    if snapshot.owner_window_label != owner_window_label {
        return Err(NativeSessionError::IdentityMismatch(format!(
            "connection {connection_id} belongs to window {}, not {owner_window_label}",
            snapshot.owner_window_label
        )));
    }
    if !supports_native_resume(snapshot.agent_type) {
        return Err(NativeSessionError::UnsupportedAgent(snapshot.agent_type));
    }
    // 先便宜地拒绝忙碌会话：释放前还要做目录/env 校验，但那些都不该在一个
    // 正在跑的回合上执行。`disconnect_and_wait` 会持锁再查一次，这里不是
    // 唯一的忙碌防线。
    if snapshot.busy() {
        return Err(NativeSessionError::Busy);
    }

    let working_dir = resolve_working_dir(
        db,
        snapshot.agent_type,
        session_id,
        snapshot.conversation_id,
        snapshot.folder_id,
        snapshot.working_dir.clone(),
    )
    .await?;

    // provider/env/权限取当前设置，和 ACP 启动时用的是同一套来源。
    let mut runtime_env = crate::commands::acp::build_session_runtime_env(
        db,
        snapshot.agent_type,
        Some(session_id),
        data_dir,
    )
    .await
    .map_err(|e| NativeSessionError::Acp(e.to_string()))?;
    configure_dsh_tui_resume(snapshot.agent_type, session_id, &mut runtime_env);

    let (program, args) = resume_argv(snapshot.agent_type, session_id)?;
    let (program, args) =
        resolve_resume_command(snapshot.agent_type, program, args).await?;
    // 依赖缺失或 argv 不安全时要在释放 ACP 之前失败，否则用户会既没有终端也
    // 没有会话。真正 spawn 时会再解析一次，这次只是前置探测。
    resolve_argv(&program, &args).map_err(|e| NativeSessionError::Terminal(e.to_string()))?;

    // 只有到这里才动会话。TurnInProgress 映射成 Busy，其它错误保留原始原因。
    acp.disconnect_and_wait(connection_id, ACP_RELEASE_TIMEOUT)
        .await
        .map_err(|e| match e {
            AcpError::TurnInProgress => NativeSessionError::Busy,
            other => NativeSessionError::AcpRelease(other.to_string()),
        })?;

    let terminal_id = uuid::Uuid::new_v4().to_string();
    let extra_env: HashMap<String, String> = runtime_env
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let spawn = terminal.spawn_argv_with_id(
        ArgvSpawnOptions {
            terminal_id: terminal_id.clone(),
            program,
            args,
            working_dir: working_dir.to_string_lossy().into_owned(),
            owner_window_label: owner_window_label.to_string(),
            extra_env: Some(extra_env),
            temp_files: vec![],
        },
        emitter.clone(),
    );

    let terminal_id = match spawn {
        Ok(id) => id,
        Err(error) => {
            // ACP 已经释放，终端却没起来。把同一会话恢复回 ACP（不是新会话），
            // 并把回滚结果写进错误，避免调用方以为会话凭空消失。
            let rollback = acp
                .spawn_agent_with_outcome(
                    snapshot.agent_type,
                    Some(working_dir.to_string_lossy().into_owned()),
                    Some(session_id.to_string()),
                    runtime_env.clone(),
                    owner_window_label.to_string(),
                    emitter,
                    snapshot.mode.clone(),
                    snapshot.config_values.clone(),
                )
                .await;
            return Err(match rollback {
                Ok(_) => {
                    NativeSessionError::Terminal(format!("{error}; the ACP session was restored"))
                }
                Err(restore) => NativeSessionError::Terminal(format!(
                    "{error}; restoring the ACP session also failed: {restore}"
                )),
            });
        }
    };

    Ok(NativeTerminalHandle {
        terminal_id,
        identity: SessionIdentity {
            agent_type: snapshot.agent_type,
            session_id: session_id.to_string(),
            working_dir,
            conversation_id: snapshot.conversation_id,
            folder_id: snapshot.folder_id,
            owner_window_label: owner_window_label.to_string(),
        },
        runtime_env,
        mode: snapshot.mode,
        config_values: snapshot.config_values,
    })
}

/// 原生终端退出后，用原 session id 恢复 ACP。
///
/// 顺序是刻意的：先校验 agent 与当前 env，再结束终端，最后才 spawn ACP。
/// 设置或 DB 出错时终端还在，用户至少能继续在终端里工作。
#[allow(clippy::too_many_arguments)]
pub async fn switch_native_to_acp(
    db: &AppDatabase,
    acp: &ConnectionManager,
    terminal: &TerminalManager,
    emitter: EventEmitter,
    data_dir: &Path,
    handle: NativeTerminalHandle,
) -> Result<RestoredAcp, NativeSessionError> {
    let identity = &handle.identity;
    if !supports_native_resume(identity.agent_type) {
        return Err(NativeSessionError::UnsupportedAgent(identity.agent_type));
    }

    let _switch = session_switch_lock(&identity.session_id).lock_owned().await;

    // 目录在终端期间可能被删掉。先拒绝，终端仍然可用；等 ACP 起来再发现
    // 目录不存在就只剩一个坏连接。
    if !identity.working_dir.is_dir() {
        return Err(NativeSessionError::WorkingDirMissing(
            identity.working_dir.display().to_string(),
        ));
    }

    // 用当前设置重建 env；切到终端期间 provider/权限可能已经改过。
    let mut runtime_env = crate::commands::acp::build_session_runtime_env(
        db,
        identity.agent_type,
        Some(&identity.session_id),
        data_dir,
    )
    .await
    .map_err(|e| NativeSessionError::Acp(e.to_string()))?;
    configure_dsh_tui_resume(identity.agent_type, &identity.session_id, &mut runtime_env);

    ensure_terminal_released(terminal, &handle.terminal_id, &identity.owner_window_label)?;

    let outcome = acp
        .spawn_agent_with_outcome(
            identity.agent_type,
            Some(identity.working_dir.to_string_lossy().into_owned()),
            // 必须是原 session id。这里永远不传 None：传 None 才会让 agent
            // 新建会话，那是用户明确禁止的静默兜底。
            Some(identity.session_id.clone()),
            runtime_env,
            identity.owner_window_label.clone(),
            emitter,
            handle.mode.clone(),
            handle.config_values.clone(),
        )
        .await
        .map_err(|e| {
            NativeSessionError::Acp(format!(
                "terminal {} has exited, but restoring the ACP session failed: {e}",
                handle.terminal_id
            ))
        })?;

    // 恢复出来的连接只携带 session_id；补回原 conversation_id / folder_id，
    // 确保发下一条消息前按会话 id 的发现与跨端附着已经能定位到它。
    acp.bind_conversation_if_unset(
        &outcome.connection_id,
        identity.conversation_id,
        identity.folder_id,
    )
    .await;

    Ok(RestoredAcp {
        connection_id: outcome.connection_id,
        agent_type: identity.agent_type,
        session_id: identity.session_id.clone(),
        working_dir: identity.working_dir.clone(),
        mode: handle.mode,
        config_values: handle.config_values,
        reused: outcome.reused,
    })
}

/// 结束终端进程并证明写入权已释放。
///
/// `stop` 会移除活动表、杀掉子进程并 `wait`；返回后快照必须不再是 alive。
/// 未知 id 视为已经退出（用户可能手动关掉了终端标签），但存在且属于别的
/// 窗口时拒绝，避免误杀。
pub fn ensure_terminal_released(
    terminal: &TerminalManager,
    terminal_id: &str,
    owner_window_label: &str,
) -> Result<(), NativeSessionError> {
    if terminal_id.trim().is_empty() {
        return Err(NativeSessionError::IdentityMismatch(
            "terminal id is required".into(),
        ));
    }
    if owner_window_label.trim().is_empty() {
        return Err(NativeSessionError::IdentityMismatch(
            "owner window label is required".into(),
        ));
    }
    if let Some(owner) = terminal.owner_window_label_of(terminal_id) {
        if owner != owner_window_label {
            return Err(NativeSessionError::TerminalOwnerMismatch {
                terminal_id: terminal_id.to_string(),
                owner,
                expected: owner_window_label.to_string(),
            });
        }
    }

    let before = terminal.snapshot(terminal_id);
    if !before.exists {
        return Ok(());
    }
    if before.alive {
        match terminal.stop(terminal_id) {
            Ok(()) => {}
            // 和进程退出竞态时 stop 可能已经找不到它，这等价于已释放。
            Err(TerminalError::NotFound(_)) => {}
            Err(e) => return Err(NativeSessionError::Terminal(e.to_string())),
        }
    }

    let after = terminal.snapshot(terminal_id);
    if after.alive {
        return Err(NativeSessionError::TerminalStillRunning(
            terminal_id.to_string(),
        ));
    }
    Ok(())
}

struct SourceSnapshot {
    agent_type: AgentType,
    external_id: Option<String>,
    owner_window_label: String,
    working_dir: Option<PathBuf>,
    conversation_id: Option<i32>,
    folder_id: Option<i32>,
    mode: Option<String>,
    config_values: BTreeMap<String, String>,
    status: ConnectionStatus,
    turn_in_flight: bool,
    goal_active: bool,
    pending_permission: bool,
    pending_question: bool,
}

impl SourceSnapshot {
    /// 与 [`ConnectionManager::disconnect_and_wait`] 相同的忙碌判定。
    fn busy(&self) -> bool {
        self.turn_in_flight
            || self.status == ConnectionStatus::Prompting
            || self.goal_active
            || self.pending_permission
            || self.pending_question
    }
}

fn supports_native_resume(agent_type: AgentType) -> bool {
    matches!(
        agent_type,
        AgentType::Codex | AgentType::ClaudeCode | AgentType::Pi | AgentType::DeepSeek
    )
}

pub(crate) fn configure_dsh_tui_resume(
    agent_type: AgentType,
    session_id: &str,
    env: &mut BTreeMap<String, String>,
) {
    if agent_type == AgentType::DeepSeek {
        // 直接启动 profile 时 argv 不一定经过 TUI 启动器；环境契约保证恢复指定会话。
        env.insert("DSH_TUI_RESUME_SESSION".into(), session_id.into());
        env.insert("DSH_TUI_BACKEND".into(), "dsh".into());
        env.insert("DSH_TUI_BACKEND_HANDOFF".into(), "dsh".into());
        env.insert("DSH_TUI_RESUME_BACKEND".into(), "dsh".into());
    }
}

/// 各原生 CLI 的 resume 入口。参数逐个作为 argv 传递，绝不拼成 shell 行。
fn resume_argv(
    agent_type: AgentType,
    session_id: &str,
) -> Result<(String, Vec<String>), NativeSessionError> {
    let (program, args): (&str, Vec<&str>) = match agent_type {
        AgentType::Codex => ("codex", vec!["--no-daemon", "resume", session_id]),
        AgentType::ClaudeCode => ("claude", vec!["--resume", session_id]),
        AgentType::Pi => ("pi", vec!["--session", session_id]),
        // 社区 TUI 是 DSH profile，由 dsh 启动并接收 resume 参数。
        AgentType::DeepSeek => ("dsh", vec!["--profile", "dsh-tui", "--", "--resume", session_id]),
        other => return Err(NativeSessionError::UnsupportedAgent(other)),
    };
    Ok((
        program.to_string(),
        args.into_iter().map(str::to_string).collect(),
    ))
}

async fn resolve_resume_command(
    agent_type: AgentType,
    program: String,
    args: Vec<String>,
) -> Result<(String, Vec<String>), NativeSessionError> {
    if agent_type != AgentType::DeepSeek {
        return Ok((program, args));
    }

    let Some(entry) =
        crate::commands::acp::resolve_npx_command_for(AgentType::DeepSeek, "dsh").await
    else {
        return Ok((program, args));
    };
    let is_javascript = entry
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("js")
                || extension.eq_ignore_ascii_case("mjs")
                || extension.eq_ignore_ascii_case("cjs")
        });
    if !is_javascript {
        return Ok((entry.to_string_lossy().into_owned(), args));
    }

    // profile 里的 DSH 入口是 JS 文件，显式交给 Node 执行，避免依赖
    // Windows 上不存在的 PATH shim 或 shell 解析。
    let node = which::which("node").map_err(|error| {
        NativeSessionError::Terminal(format!(
            "Node.js is required to start the DSH launcher: {error}"
        ))
    })?;
    let mut resolved_args = Vec::with_capacity(args.len() + 1);
    resolved_args.push(entry.to_string_lossy().into_owned());
    resolved_args.extend(args);
    Ok((node.to_string_lossy().into_owned(), resolved_args))
}

/// 验证会话身份，并解析出 resume 必须使用的工作目录。
///
/// 优先级：ACP 实际工作目录 → conversation.origin_cwd → folder.path。后者
/// 只在会话迁移或被重新挂到别的项目时才需要。
async fn resolve_working_dir(
    db: &AppDatabase,
    agent_type: AgentType,
    session_id: &str,
    conversation_id: Option<i32>,
    folder_id: Option<i32>,
    acp_working_dir: Option<PathBuf>,
) -> Result<PathBuf, NativeSessionError> {
    let conversation = match conversation_id {
        Some(id) => {
            let summary = conversation_service::get_by_id(&db.conn, id)
                .await
                .map_err(|e| NativeSessionError::Db(e.to_string()))?;
            if summary.agent_type != agent_type {
                return Err(NativeSessionError::IdentityMismatch(format!(
                    "conversation {id} belongs to agent {}, not {agent_type}",
                    summary.agent_type
                )));
            }
            // 行上已有 external id 时必须一致；None 表示该行尚未写入会话 id，
            // 不构成冲突。
            if let Some(bound) = summary.external_id.as_deref() {
                if bound != session_id {
                    return Err(NativeSessionError::IdentityMismatch(format!(
                        "conversation {id} is bound to session {bound}, not {session_id}"
                    )));
                }
            }
            Some(summary)
        }
        None => None,
    };

    let folder_path = match folder_id {
        Some(id) => folder_service::get_folder_by_id(&db.conn, id)
            .await
            .map_err(|e| NativeSessionError::Db(e.to_string()))?
            .map(|folder| PathBuf::from(folder.path)),
        None => None,
    };
    let origin_cwd = conversation
        .as_ref()
        .and_then(|summary| summary.origin_cwd.clone())
        .map(PathBuf::from);

    let candidate = acp_working_dir.or(origin_cwd).or(folder_path);
    match candidate {
        Some(path) if path.is_dir() => Ok(path),
        Some(path) => Err(NativeSessionError::WorkingDirMissing(
            path.display().to_string(),
        )),
        None => Err(NativeSessionError::NoWorkingDir),
    }
}

/// 同一 session 的切换锁。用 Weak 保存，会话结束后自动从表中消失。
fn session_switch_lock(session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, weak| weak.strong_count() > 0);
    if let Some(existing) = locks.get(session_id).and_then(Weak::upgrade) {
        return existing;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(session_id.to_string(), Arc::downgrade(&lock));
    lock
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::connection::ConnectionCommand;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::web::event_bridge::WebEventBroadcaster;

    /// 每个测试独立的 data/working dir，Drop 时清理。
    struct TestSpace {
        dir: PathBuf,
    }

    impl TestSpace {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("codeg-native-session-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create test dir");
            Self { dir }
        }
    }

    impl Drop for TestSpace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn test_emitter() -> EventEmitter {
        EventEmitter::test_web_only(Arc::new(WebEventBroadcaster::new()))
    }

    #[test]
    fn dsh_resumes_through_the_tui_profile() {
        let (program, args) =
            resume_argv(AgentType::DeepSeek, "session-123").expect("DSH resume arguments");
        assert_eq!(program, "dsh");
        assert_eq!(
            args,
            ["--profile", "dsh-tui", "--", "--resume", "session-123"]
        );
        let mut env = BTreeMap::from([
            ("DSH_TUI_RESUME_SESSION".into(), "old-session".into()),
            ("DSH_TUI_BACKEND_HANDOFF".into(), "codex".into()),
            ("DEEPSEEK_BASE_URL".into(), "http://localhost:1234".into()),
        ]);
        configure_dsh_tui_resume(AgentType::DeepSeek, "session-123", &mut env);
        assert_eq!(env["DSH_TUI_RESUME_SESSION"], "session-123");
        assert_eq!(env["DSH_TUI_BACKEND_HANDOFF"], "dsh");
        assert_eq!(env["DSH_TUI_RESUME_BACKEND"], "dsh");
        assert_eq!(env["DEEPSEEK_BASE_URL"], "http://localhost:1234");
        let unchanged = env.clone();
        configure_dsh_tui_resume(AgentType::Codex, "other-session", &mut env);
        assert_eq!(env, unchanged);
    }

    async fn acp_with_session(
        agent_type: AgentType,
        session_id: &str,
        working_dir: Option<PathBuf>,
    ) -> (
        ConnectionManager,
        tokio::sync::mpsc::Receiver<ConnectionCommand>,
    ) {
        let acp = ConnectionManager::new();
        // 保留 receiver：连接活着，`disconnect` 才能走完整路径。
        let rx = acp
            .insert_test_connection_live("conn-1", agent_type, working_dir, EventEmitter::Noop)
            .await;
        let state = acp
            .get_state("conn-1")
            .await
            .expect("test connection state");
        {
            let mut s = state.write().await;
            s.external_id = Some(session_id.to_string());
            s.owner_window_label = "main".to_string();
        }
        (acp, rx)
    }

    #[tokio::test]
    async fn busy_session_is_refused_before_any_terminal_starts() {
        let db = fresh_in_memory_db().await;
        let space = TestSpace::new();
        let (acp, _rx) =
            acp_with_session(AgentType::Codex, "sess-1", Some(space.dir.clone())).await;
        {
            let state = acp.get_state("conn-1").await.expect("state");
            state.write().await.turn_in_flight = true;
        }

        let terminal = TerminalManager::new();
        let error = switch_acp_to_native(
            &db,
            &acp,
            &terminal,
            test_emitter(),
            &space.dir,
            "main",
            "conn-1",
            "sess-1",
        )
        .await
        .expect_err("a running turn must refuse the switch");

        assert!(matches!(error, NativeSessionError::Busy), "{error:?}");
        assert!(
            acp.get_state("conn-1").await.is_some(),
            "a busy connection must stay attached"
        );
        assert!(
            terminal.list_with_exit_check(None).is_empty(),
            "no terminal may be spawned when the turn is still running"
        );
    }

    #[tokio::test]
    async fn wrong_session_id_is_refused_without_touching_the_connection() {
        let db = fresh_in_memory_db().await;
        let space = TestSpace::new();
        let (acp, _rx) =
            acp_with_session(AgentType::Codex, "sess-1", Some(space.dir.clone())).await;
        let terminal = TerminalManager::new();

        let error = switch_acp_to_native(
            &db,
            &acp,
            &terminal,
            test_emitter(),
            &space.dir,
            "main",
            "conn-1",
            "sess-other",
        )
        .await
        .expect_err("a mismatched session id must be refused");

        assert!(
            matches!(error, NativeSessionError::IdentityMismatch(_)),
            "{error:?}"
        );
        assert!(acp.get_state("conn-1").await.is_some());
        assert!(terminal.list_with_exit_check(None).is_empty());
    }

    #[tokio::test]
    async fn conversation_agent_mismatch_is_refused() {
        let db = fresh_in_memory_db().await;
        let space = TestSpace::new();
        let folder_id = seed_folder(&db, &space.dir.to_string_lossy()).await;
        // 会话行属于 Claude，但连接声称是 Codex：这是身份冲突，不是可恢复状态。
        let conversation_id = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        let (acp, _rx) =
            acp_with_session(AgentType::Codex, "sess-1", Some(space.dir.clone())).await;
        {
            let state = acp.get_state("conn-1").await.expect("state");
            let mut s = state.write().await;
            s.conversation_id = Some(conversation_id);
            s.folder_id = Some(folder_id);
        }

        let terminal = TerminalManager::new();
        let error = switch_acp_to_native(
            &db,
            &acp,
            &terminal,
            test_emitter(),
            &space.dir,
            "main",
            "conn-1",
            "sess-1",
        )
        .await
        .expect_err("a conversation owned by another agent must be refused");

        assert!(
            matches!(error, NativeSessionError::IdentityMismatch(_)),
            "{error:?}"
        );
        assert!(acp.get_state("conn-1").await.is_some());
        assert!(terminal.list_with_exit_check(None).is_empty());
    }

    #[tokio::test]
    async fn unsupported_agent_is_refused_before_release() {
        let db = fresh_in_memory_db().await;
        let space = TestSpace::new();
        let (acp, _rx) =
            acp_with_session(AgentType::OpenCode, "sess-1", Some(space.dir.clone())).await;
        let terminal = TerminalManager::new();

        let error = switch_acp_to_native(
            &db,
            &acp,
            &terminal,
            test_emitter(),
            &space.dir,
            "main",
            "conn-1",
            "sess-1",
        )
        .await
        .expect_err("OpenCode has no native resume path");

        assert!(
            matches!(
                error,
                NativeSessionError::UnsupportedAgent(AgentType::OpenCode)
            ),
            "{error:?}"
        );
        assert!(
            acp.get_state("conn-1").await.is_some(),
            "the connection must survive a rejected switch"
        );
        assert!(terminal.list_with_exit_check(None).is_empty());
    }

    #[tokio::test]
    async fn missing_working_directory_is_refused_before_release() {
        let db = fresh_in_memory_db().await;
        let space = TestSpace::new();
        let missing = space.dir.join("gone");
        let (acp, _rx) = acp_with_session(AgentType::Codex, "sess-1", Some(missing)).await;
        let terminal = TerminalManager::new();

        let error = switch_acp_to_native(
            &db,
            &acp,
            &terminal,
            test_emitter(),
            &space.dir,
            "main",
            "conn-1",
            "sess-1",
        )
        .await
        .expect_err("a missing working directory must stop the switch");

        assert!(
            matches!(error, NativeSessionError::WorkingDirMissing(_)),
            "{error:?}"
        );
        assert!(acp.get_state("conn-1").await.is_some());
        assert!(terminal.list_with_exit_check(None).is_empty());
    }

    /// 释放路径必须是真子进程：起一个真实 PTY，等 `ensure_terminal_released`
    /// 杀掉并 wait 后，写入必须已被拒绝。
    #[tokio::test]
    async fn terminal_release_kills_the_child_and_drops_write_access() {
        let space = TestSpace::new();
        let terminal = TerminalManager::new();
        let terminal_id = uuid::Uuid::new_v4().to_string();
        let (program, args) = long_running_argv();
        terminal
            .spawn_argv_with_id(
                ArgvSpawnOptions {
                    terminal_id: terminal_id.clone(),
                    program,
                    args,
                    working_dir: space.dir.to_string_lossy().into_owned(),
                    owner_window_label: "main".to_string(),
                    extra_env: None,
                    temp_files: vec![],
                },
                EventEmitter::Noop,
            )
            .expect("spawn long-running child");

        let before = terminal.snapshot(&terminal_id);
        assert!(before.exists && before.alive, "child must be running");

        // 别的窗口不能结束它。
        let owner_error = ensure_terminal_released(&terminal, &terminal_id, "other-window")
            .expect_err("a terminal must not be ended by another window");
        assert!(
            matches!(
                owner_error,
                NativeSessionError::TerminalOwnerMismatch { .. }
            ),
            "{owner_error:?}"
        );
        assert!(terminal.snapshot(&terminal_id).alive);

        ensure_terminal_released(&terminal, &terminal_id, "main")
            .expect("terminal must be released");
        let after = terminal.snapshot(&terminal_id);
        assert!(after.exists && !after.alive, "child must have exited");
        assert!(
            terminal.write(&terminal_id, b"echo still-here\n").is_err(),
            "write access must be gone once the terminal is stopped"
        );

        let _ = terminal.kill(&terminal_id);
    }

    #[cfg(target_os = "windows")]
    fn long_running_argv() -> (String, Vec<String>) {
        (
            "ping".to_string(),
            vec!["-n".to_string(), "30".to_string(), "127.0.0.1".to_string()],
        )
    }

    #[cfg(not(target_os = "windows"))]
    fn long_running_argv() -> (String, Vec<String>) {
        ("/bin/sleep".to_string(), vec!["30".to_string()])
    }
}
