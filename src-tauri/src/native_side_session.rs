//! 持久化原生旁问的创建核心。
//!
//! 一个旁问等价于在"发起时最后一条已完成的 assistant 回合"处，对主原生
//! session 做一次 fork，再把子 session 的元数据落库。这里只负责造出并验证
//! 这个子 session，不启动 PTY，也不碰 UI/Tauri/Web 路由。
//!
//! 主会话可能仍在运行，用户也可能在 fork 完成前继续交谈。因此锚点必须在请求
//! 进入时固定，并且子会话的完整历史必须逐条等于"锚点及之前"的指纹：适配器
//! 返回成功不算证据，只有重新解析子会话文件才算。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::acp::fork::{fingerprint_agent_message, resolve_fork_point, ForkPoint};
use crate::acp::manager::ConnectionManager;
use crate::acp::session_state::LiveContentBlock;
use crate::acp::types::ConnectionStatus;
use crate::app_error::AppCommandError;
use crate::db::service::conversation_service;
use crate::db::service::side_question_service::{
    self, CreateOutcome, NewSideQuestion, SideQuestionError,
};
use crate::db::AppDatabase;
use crate::models::{AgentType, ContentBlock, MessageTurn, TurnRole};

const DRIVER: &str = include_str!("side_question/native-session-fork.mjs");
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;
const MAX_STDERR_BYTES: u64 = 4096;
const FORK_TIMEOUT: Duration = Duration::from_secs(120);
const BOUNDARY_TIMEOUT: Duration = Duration::from_secs(10);
const BOUNDARY_POLL: Duration = Duration::from_millis(250);
/// 同一 requestId 的另一个进程正在 fork 时，等它写完结果的上限。
/// 必须覆盖它自己的 FORK_TIMEOUT + BOUNDARY_TIMEOUT，否则会误报结果未知。
const CONCURRENT_WAIT: Duration = Duration::from_secs(150);

/// 旁问创建请求。
///
/// `request_id` 是跨重试、跨重启稳定的幂等键；`side_question_id` 由调用方
/// 生成并复用，数据库只存元数据。`completed_turn_id` 为空时取最后一条已完成
/// 的 assistant 回合。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateNativeSideQuestion {
    pub request_id: String,
    pub side_question_id: Uuid,
    pub connection_id: String,
    pub source_conversation_id: i32,
    pub title: String,
    #[serde(default)]
    pub completed_turn_id: Option<String>,
}

/// 崩溃/取消后的恢复记录。
///
/// 先写 `native_session_id == None` 的 pending 行，fork 成功后再追加完整行。
/// 读到 pending 只能说明"结果未知"，绝不能重试 fork——否则会造出第二个子
/// session，而旧的没有任何引用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recovery {
    request_id: String,
    side_question_id: Uuid,
    connection_id: String,
    source_conversation_id: i32,
    source_session_id: String,
    agent: String,
    cwd: String,
    title: String,
    /// 调用方显式选中的回合；重试时必须一致，避免同一 requestId 换了锚点。
    #[serde(default)]
    requested_turn_id: Option<String>,
    anchor_turn_id: String,
    anchor_message_id: String,
    history: Vec<String>,
    #[serde(default)]
    native_session_id: Option<String>,
    #[serde(default)]
    pi_session_file: Option<String>,
}

/// 从主会话状态里取出的、创建旁问需要的事实。
struct Source {
    agent: AgentType,
    session_id: String,
    cwd: String,
    /// 进入创建流程时立刻读到的父历史；后续解析运行时环境可能很慢，
    /// 不能等那之后再读，否则主任务新完成的回合会被误当成锚点。
    turns: Vec<MessageTurn>,
    /// 正在进行中的 assistant 文本。用来拒绝把半条消息当成已完成回合。
    live_text: Option<String>,
}

/// fork 出来的子会话身份。
struct Forked {
    session_id: String,
    session_file: Option<String>,
}

/// Pi 的锚点：driver 需要 Pi 自己的 entry id，而 parser 不提供它。
struct PiAnchor {
    entry_id: String,
    fingerprint: String,
    text: String,
}

/// 创建一条原生旁问。
///
/// 同一个 `request_id` 在并发、重试或进程重启后只会产生一个子 session：
/// 进程内按 `(data_dir, request_id)` 串行，跨进程靠 recovery 文件的
/// `create_new` 抢占，数据库唯一键是最后一道兜底。
pub async fn create(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: CreateNativeSideQuestion,
) -> Result<CreateOutcome, AppCommandError> {
    crate::research_branch::validate_request_id(&request.request_id)?;
    if request.connection_id.trim().is_empty() {
        return Err(AppCommandError::invalid_input("connectionId is required"));
    }
    let title = request.title.trim();
    if title.is_empty() {
        return Err(AppCommandError::invalid_input(
            "A side-question title is required",
        ));
    }
    // 先按落库规则校验，避免 fork 成功后才在 service 层因标题被拒，
    // 留下无法引用的子 session。
    if title.chars().count() > side_question_service::MAX_TITLE_CHARS {
        return Err(AppCommandError::invalid_input(
            "The side-question title is too long",
        ));
    }
    if title.contains('\0') {
        return Err(AppCommandError::invalid_input(
            "The side-question title contains a NUL character",
        ));
    }

    let db = AppDatabase {
        conn: db.conn.clone(),
    };
    let manager = manager.clone_ref();
    let data_dir = data_dir.to_path_buf();
    // 与 research fork 一致：调用方取消只丢弃响应，不中断"fork → 校验 → 落库"。
    tokio::spawn(async move {
        let lock = crate::research_branch::request_lock(format!(
            "{}:{}",
            data_dir.display(),
            request.request_id
        ));
        let _guard = lock.lock_owned().await;
        create_guarded(&db, &manager, &data_dir, request).await
    })
    .await
    .map_err(|error| {
        AppCommandError::task_execution_failed("Native side-question task failed")
            .with_detail(error.to_string())
    })?
}

async fn create_guarded(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: CreateNativeSideQuestion,
) -> Result<CreateOutcome, AppCommandError> {
    // 已落库就是最终答案：重试连主连接都不需要，也就不该再 fork。
    if let Some(existing) = side_question_service::get(&db.conn, request.side_question_id)
        .await
        .map_err(AppCommandError::db)?
    {
        if existing.title != request.title.trim() {
            return Err(AppCommandError::invalid_input(
                "This side-question id already names a different request",
            ));
        }
        return Ok(CreateOutcome {
            record: existing,
            created: false,
        });
    }

    let path = recovery_path(data_dir, &request.request_id);
    match load_recovery(&path).await? {
        RecoveryState::Complete(record) => {
            verify_recovery_matches(&record, &request)?;
            let outcome = persist_recovered(db, &record).await?;
            remove_recovery(&path).await;
            return Ok(outcome);
        }
        // 另一个进程正在为同一个 requestId 跑 fork：等它写出结果，绝不重复 fork。
        RecoveryState::Pending => return await_pending(db, &path, &request).await,
        RecoveryState::Missing => {}
    }

    let source = read_source(db, manager, &request).await?;
    let runtime_env = crate::commands::acp::build_session_runtime_env(
        db,
        source.agent,
        Some(&source.session_id),
        data_dir,
    )
    .await
    .map_err(|error| {
        AppCommandError::task_execution_failed("Could not resolve the agent runtime settings")
            .with_detail(error.to_string())
    })?;

    // Pi 的 entry id 只存在于它自己的会话文件里，必须自己读；
    // 其余 agent 由 fork.rs 统一解析锚点。
    let pi_anchor = if source.agent == AgentType::Pi {
        let env = crate::parsers::AgentEnv::from_overrides(runtime_env.clone());
        let session_id = source.session_id.clone();
        Some(
            tokio::task::spawn_blocking(move || read_pi_anchor(&env, &session_id))
                .await
                .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))??,
        )
    } else {
        None
    };
    let turns = &source.turns;
    let index = select_completed_anchor(
        turns,
        request.completed_turn_id.as_deref(),
        source.live_text.as_deref(),
        source.agent,
        pi_anchor.as_ref(),
    )?;
    let anchor = build_anchor(turns, index, source.agent, pi_anchor.as_ref())?;
    let history = crate::research_branch::history_fingerprints(&turns[..=index])?;

    let mut record = Recovery {
        request_id: request.request_id.clone(),
        side_question_id: request.side_question_id,
        connection_id: request.connection_id.clone(),
        source_conversation_id: request.source_conversation_id,
        source_session_id: source.session_id.clone(),
        agent: source.agent.as_wire().into_owned(),
        cwd: source.cwd.clone(),
        title: request.title.trim().to_string(),
        requested_turn_id: request.completed_turn_id.clone(),
        anchor_turn_id: turns[index].id.clone(),
        anchor_message_id: anchor.message_id.clone(),
        history,
        native_session_id: None,
        pi_session_file: None,
    };

    // 程序、node 和请求体都能在写 pending 之前确定：这些步骤失败时还没有任何
    // 子会话，不能把 requestId 提前锁死成"结果未知"。
    let plan = plan_driver(
        source.agent,
        &source.cwd,
        &source.session_id,
        &anchor,
        &runtime_env,
    )
    .await?;

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(AppCommandError::io)?;
    }
    match append_recovery(&path, &record, true).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            // 另一个进程已经抢到同一个 requestId，或上次崩溃留下记录。
            return await_pending(db, &path, &request).await;
        }
        Err(error) => return Err(AppCommandError::io(error)),
    }

    let forked = match run_fork(&source.cwd, plan, &runtime_env).await {
        Ok(forked) => forked,
        Err(ForkFailure::BeforeRequest(error)) => {
            // 请求还没写给 driver，不可能产生子会话；撤掉标记让同一 requestId 可重试。
            remove_recovery(&path).await;
            return Err(error);
        }
        Err(ForkFailure::Unknown(error)) => {
            // 驱动可能已经建好子会话后才失败；没有确凿证据就不能删 pending。
            return Err(error.with_detail(format!(
                "Outcome unknown; retry with a new requestId. Recovery: {}",
                path.display()
            )));
        }
    };
    if forked.session_id == source.session_id {
        return Err(AppCommandError::task_execution_failed(
            "The agent returned the parent session instead of an independent fork",
        ));
    }
    record.native_session_id = Some(forked.session_id.clone());
    record.pi_session_file = forked.session_file;
    if let Err(error) = append_recovery(&path, &record, false).await {
        // 子会话已经存在，必须把身份告诉调用方，不能伪装成"没创建"。
        return Err(AppCommandError::task_execution_failed(
            "The fork was created but its recovery record could not be persisted",
        )
        .with_detail(format!(
            "session {}; recovery {}; {}",
            forked.session_id,
            path.display(),
            error
        )));
    }

    let outcome = persist_recovered(db, &record).await;
    if outcome.is_ok() {
        remove_recovery(&path).await;
    }
    outcome
}

fn service_error(error: SideQuestionError) -> AppCommandError {
    match error {
        SideQuestionError::Validation(message) => AppCommandError::invalid_input(message),
        SideQuestionError::Conflict(message) => AppCommandError::already_exists(message),
        SideQuestionError::Db(error) => AppCommandError::db(error),
    }
}

fn unknown_outcome() -> AppCommandError {
    AppCommandError::task_execution_failed(
        "A native side question may already exist for this request; refusing to fork again",
    )
    .with_detail("reason=unknown_fork_outcome")
}

/// 只允许能真正分叉的 agent；其余保持 fail closed，而不是退化成尾部复制。
fn supports_native_fork(agent: AgentType) -> bool {
    matches!(
        agent,
        AgentType::Codex | AgentType::ClaudeCode | AgentType::Pi | AgentType::DeepSeek
    )
}

async fn read_source(
    db: &AppDatabase,
    manager: &ConnectionManager,
    request: &CreateNativeSideQuestion,
) -> Result<Source, AppCommandError> {
    let state = {
        let connections = manager.connections.lock().await;
        connections
            .get(&request.connection_id)
            .map(|connection| connection.state.clone())
            .ok_or_else(|| {
                AppCommandError::not_found(format!(
                    "Connection {} is not available",
                    request.connection_id
                ))
            })?
    };
    let snapshot = state.read().await;

    let agent = snapshot.agent_type;
    if !supports_native_fork(agent) {
        return Err(AppCommandError::invalid_input(
            "This agent has no native side-question bridge",
        ));
    }
    // 主任务运行中允许创建旁问；只要求连接本身仍然可用，vice versa 不引入 busy 门控。
    if !matches!(
        snapshot.status,
        ConnectionStatus::Connected | ConnectionStatus::Prompting
    ) {
        return Err(AppCommandError::invalid_input(
            "The source connection is not ready for a native fork",
        ));
    }
    if snapshot
        .conversation_id
        .is_some_and(|id| id != request.source_conversation_id)
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
    let cwd = snapshot
        .working_dir
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| {
            AppCommandError::invalid_input("The source connection has no working directory")
        })?;
    // 这两个值会原样落库；在 fork 前拒绝超长/NUL，避免造出子 session 后
    // 才在 service 层失败。
    if session_id.chars().count() > side_question_service::MAX_SESSION_ID_CHARS
        || session_id.contains('\0')
    {
        return Err(AppCommandError::invalid_input(
            "The source native session id is invalid",
        ));
    }
    if cwd.chars().count() > side_question_service::MAX_PATH_CHARS || cwd.contains('\0') {
        return Err(AppCommandError::invalid_input(
            "The source working directory is invalid",
        ));
    }
    let live_text = live_assistant_text(snapshot.live_message.as_ref());
    drop(snapshot);

    // 先固定父历史，再解析运行时环境。锚点必须反映"请求进入时"的状态，
    // 而不是几秒后可能又多出一轮的父文件。
    let turns = crate::research_branch::read_turns(db, agent, session_id.clone()).await?;

    let row = conversation_service::get_by_id(&db.conn, request.source_conversation_id)
        .await
        .map_err(|error| AppCommandError::not_found(error.to_string()))?;
    if row.external_id.as_deref() != Some(session_id.as_str()) || row.agent_type != agent {
        return Err(AppCommandError::invalid_input(
            "Source conversation does not match the connection",
        ));
    }

    Ok(Source {
        agent,
        session_id,
        cwd,
        turns,
        live_text,
    })
}

/// 把进行中 assistant 的可见文本拼起来；只在有文本时返回。
fn live_assistant_text(message: Option<&crate::acp::session_state::LiveMessage>) -> Option<String> {
    let message = message?;
    let text = message
        .content
        .iter()
        .filter_map(|block| match block {
            LiveContentBlock::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    (!text.is_empty()).then_some(text)
}

fn turn_text(turn: &MessageTurn) -> String {
    turn.blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// 选出"请求进入时最后一条已完成 assistant"。
///
/// 主任务运行中允许创建旁问，所以不能因为尾部有未完成回合就整体拒绝：
/// 未完成的尾部要跳过，退回到它之前真正收尾的回合。显式选中未完成回合时
/// 则必须拒绝，不能悄悄换成别的回合。
fn select_completed_anchor(
    turns: &[MessageTurn],
    requested_turn_id: Option<&str>,
    live_text: Option<&str>,
    agent: AgentType,
    pi: Option<&PiAnchor>,
) -> Result<usize, AppCommandError> {
    let requested = match requested_turn_id {
        Some(id) => {
            let index = turns.iter().position(|turn| turn.id == id).ok_or_else(|| {
                AppCommandError::invalid_input("The selected side-question turn no longer exists")
            })?;
            Some(match turns[index].role {
                TurnRole::Assistant => index,
                _ => turns[..index]
                    .iter()
                    .rposition(|turn| matches!(turn.role, TurnRole::Assistant))
                    .ok_or_else(|| {
                        AppCommandError::invalid_input(
                            "The selected message has no earlier completed assistant reply",
                        )
                    })?,
            })
        }
        None => None,
    };

    if agent == AgentType::Pi {
        let pi = pi.ok_or_else(|| {
            AppCommandError::task_execution_failed("The Pi fork point could not be resolved")
        })?;
        // Pi parser 对每条 assistant 都写 completed_at（tool_use 中途也是），
        // 只有文件里 stopReason == "stop" 的 entry 才算真正收尾。
        return match requested {
            Some(index) if turn_text(&turns[index]) == pi.text => Ok(index),
            Some(_) => Err(AppCommandError::invalid_input(
                "The selected reply is not a completed Pi turn; choose another reply",
            )),
            None => turns
                .iter()
                .rposition(|turn| {
                    matches!(turn.role, TurnRole::Assistant) && turn_text(turn) == pi.text
                })
                .ok_or_else(|| {
                    AppCommandError::invalid_input(
                        "The Pi transcript changed while the side question was being created",
                    )
                }),
        };
    }

    if let Some(index) = requested {
        if !turn_settled(turns, index, live_text) {
            return Err(AppCommandError::invalid_input(
                "The selected turn is still in progress; wait for it to finish",
            ));
        }
        return Ok(index);
    }

    (0..turns.len())
        .rev()
        .find(|&index| {
            matches!(turns[index].role, TurnRole::Assistant)
                && turn_settled(turns, index, live_text)
        })
        .ok_or_else(|| {
            AppCommandError::invalid_input("This conversation has no completed assistant turn")
        })
}

/// 这条 assistant 回合是否已经在请求进入时收尾。
fn turn_settled(turns: &[MessageTurn], index: usize, live_text: Option<&str>) -> bool {
    let turn = &turns[index];
    if turn.completed_at.is_none() {
        return false;
    }
    // 后面已经出现用户消息：这一轮必然早于用户的新提问，不可能是当前流式回合。
    if turns[index + 1..]
        .iter()
        .any(|later| matches!(later.role, TurnRole::User))
    {
        return true;
    }
    // 位于尾部且与正在流式输出的 assistant 文本重合：parser 可能已经写到了
    // 本回合的一半（个别适配器甚至会填 completed_at），必须当作进行中。
    match live_text.filter(|text| !text.is_empty()) {
        Some(live) => {
            let text = turn_text(turn);
            !(text == live || (!text.is_empty() && live.starts_with(&text)))
        }
        None => true,
    }
}

fn build_anchor(
    turns: &[MessageTurn],
    index: usize,
    agent: AgentType,
    pi: Option<&PiAnchor>,
) -> Result<ForkPoint, AppCommandError> {
    if agent == AgentType::Pi {
        let pi = pi.ok_or_else(|| {
            AppCommandError::task_execution_failed("The Pi fork point could not be resolved")
        })?;
        // parser 的 completed_at 对 Pi 只代表"这条记录写完了"，不代表回合收尾；
        // tool_use 中途同样是 Some。必须与文件里最后一个 stop 对齐。
        if turn_text(&turns[index]) != pi.text {
            return Err(AppCommandError::invalid_input(
                "The Pi transcript changed while the side question was being created",
            ));
        }
        return Ok(ForkPoint {
            message_id: pi.entry_id.clone(),
            message_fingerprint: Some(pi.fingerprint.clone()),
            message_occurrence: None,
        });
    }

    let point = resolve_fork_point(turns, &turns[index].id, agent).ok_or_else(|| {
        AppCommandError::invalid_input(
            "This turn cannot be named as a native fork point; choose another reply",
        )
    })?;
    if point.message_fingerprint.is_none() {
        return Err(AppCommandError::invalid_input(
            "This turn has no verifiable fingerprint; choose another reply",
        ));
    }
    Ok(point)
}

/// 启动 driver 前就能确定的全部东西。放在写 pending 之前解析，避免"程序
/// 缺失"这类必然失败也把 requestId 变成结果未知。
struct DriverPlan {
    node: PathBuf,
    request: Value,
}

async fn plan_driver(
    agent: AgentType,
    cwd: &str,
    session_id: &str,
    anchor: &ForkPoint,
    runtime_env: &BTreeMap<String, String>,
) -> Result<DriverPlan, AppCommandError> {
    let node = which::which("node").map_err(|_| {
        AppCommandError::dependency_missing("Node.js is required for native side questions")
    })?;
    let program = resolve_program(agent, runtime_env).await.ok_or_else(|| {
        AppCommandError::dependency_missing(
            "The native agent runtime is unavailable for a side question",
        )
    })?;
    // driver 只接受绝对路径；这里提前拒绝，避免"注定失败"的请求先写 pending。
    if !Path::new(cwd).is_absolute() {
        return Err(AppCommandError::invalid_input(
            "The source connection working directory is not an absolute path",
        ));
    }
    if !program.is_absolute() {
        return Err(AppCommandError::dependency_missing(
            "The native agent runtime path must be absolute",
        ));
    }
    let fingerprint = anchor.message_fingerprint.clone().ok_or_else(|| {
        AppCommandError::invalid_input("The selected turn has no verifiable fingerprint")
    })?;
    let mut request = json!({
        "agent": agent.as_wire(),
        "cwd": cwd,
        "sessionId": session_id,
        "completedMessageId": anchor.message_id,
        "completedFingerprint": fingerprint,
    });
    if let Some(occurrence) = anchor.message_occurrence {
        request["completedOccurrence"] = json!(occurrence);
    }
    if agent == AgentType::Pi {
        request["piProgram"] = json!(program);
    } else {
        request["adapterProgram"] = json!(program);
    }
    Ok(DriverPlan { node, request })
}

/// 与 `side_question::native` 保持同一套解析规则：旁问必须跑在主会话所用
/// 的运行时上，不能借用另一个全局安装。
async fn resolve_program(
    agent: AgentType,
    runtime_env: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    match agent {
        AgentType::Codex => {
            let configured = runtime_env
                .get("CODEX_PATH")
                .cloned()
                .or_else(|| std::env::var("CODEX_PATH").ok())
                .filter(|path| !path.trim().is_empty())
                .map(PathBuf::from);
            match configured {
                Some(path) => Some(path),
                None => {
                    let runtime = crate::acp::codex_runtime::current().await;
                    runtime.confirmed.then_some(runtime.codex_js).flatten()
                }
            }
        }
        AgentType::ClaudeCode => {
            crate::commands::acp::resolve_npx_command_for(agent, "claude-agent-acp").await
        }
        AgentType::Pi => {
            let configured = runtime_env
                .get("PI_ACP_PI_COMMAND")
                .cloned()
                .or_else(|| std::env::var("PI_ACP_PI_COMMAND").ok())
                .filter(|value| !value.trim().is_empty());
            match configured {
                Some(program) => which::which(program).ok(),
                None => which::which("pi").ok(),
            }
        }
        AgentType::DeepSeek => {
            crate::commands::acp::resolve_npx_command_for(agent, "deepseek-acp").await
        }
        _ => None,
    }
}

/// fork 失败分两类：请求尚未发出时子会话一定不存在；请求写出后只能当作结果
/// 未知，宁可让调用方换 requestId，也不能重复 fork。
enum ForkFailure {
    BeforeRequest(AppCommandError),
    Unknown(AppCommandError),
}

async fn run_fork(
    cwd: &str,
    plan: DriverPlan,
    runtime_env: &BTreeMap<String, String>,
) -> Result<Forked, ForkFailure> {
    let entry = format!(
        "import {{ createInterface }} from 'node:readline'\n{DRIVER}\n\
         const readline = createInterface({{ input: process.stdin }}); \
         for await (const line of readline) {{ \
         try {{ process.stdout.write(JSON.stringify(await forkNativeSession(JSON.parse(line))) + '\\n'); }} \
         catch (error) {{ process.stdout.write(JSON.stringify({{ error: String(error?.message ?? error) }}) + '\\n'); }} \
         readline.close(); break; }}"
    );
    let mut command = crate::process::tokio_command(plan.node);
    command
        .args(["--input-type=module", "-e", &entry])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in runtime_env {
        if value.is_empty() {
            command.env_remove(key);
        } else {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().map_err(|error| {
        ForkFailure::BeforeRequest(
            AppCommandError::task_execution_failed("Could not start the native fork bridge")
                .with_detail(error.to_string()),
        )
    })?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        ForkFailure::BeforeRequest(AppCommandError::task_execution_failed(
            "Native fork stdin is unavailable",
        ))
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        ForkFailure::BeforeRequest(AppCommandError::task_execution_failed(
            "Native fork stdout is unavailable",
        ))
    })?;
    let mut stderr = child.stderr.take();
    let mut process = KillOnDrop(child);

    let mut line = serde_json::to_vec(&plan.request).map_err(|error| {
        ForkFailure::BeforeRequest(AppCommandError::task_execution_failed(error.to_string()))
    })?;
    line.push(b'\n');
    let operation = async {
        stdin.write_all(&line).await.map_err(|_| {
            // 可能已经写出一部分，是否被 driver 当成完整请求无法证明。
            ForkFailure::Unknown(AppCommandError::task_execution_failed(
                "Native fork input disconnected",
            ))
        })?;
        stdin.shutdown().await.map_err(|_| {
            ForkFailure::Unknown(AppCommandError::task_execution_failed(
                "Native fork input disconnected",
            ))
        })?;
        // 两个管道必须并发读，否则一端填满会把子进程卡死。
        let read_out = async {
            let mut bytes = Vec::new();
            stdout
                .take(MAX_OUTPUT_BYTES + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| {
                    ForkFailure::Unknown(AppCommandError::task_execution_failed(
                        "Native fork output disconnected",
                    ))
                })?;
            Ok::<Vec<u8>, ForkFailure>(bytes)
        };
        let read_err = async {
            let mut bytes = Vec::new();
            if let Some(stderr) = stderr.as_mut() {
                stderr
                    .take(MAX_STDERR_BYTES)
                    .read_to_end(&mut bytes)
                    .await
                    .ok();
            }
            String::from_utf8_lossy(&bytes).trim().to_string()
        };
        let (output, detail) = tokio::join!(read_out, read_err);
        let output = output?;
        let status = process.0.wait().await.map_err(|error| {
            ForkFailure::Unknown(
                AppCommandError::task_execution_failed("Native fork process could not be reaped")
                    .with_detail(error.to_string()),
            )
        })?;
        if output.len() as u64 > MAX_OUTPUT_BYTES {
            return Err(ForkFailure::Unknown(
                AppCommandError::task_execution_failed("The native fork response is too large"),
            ));
        }
        let text = String::from_utf8_lossy(&output);
        let last = text.lines().rev().find(|line| !line.trim().is_empty());
        let value: Value = match last {
            Some(line) => serde_json::from_str(line).map_err(|error| {
                ForkFailure::Unknown(
                    AppCommandError::task_execution_failed(
                        "The native fork bridge returned an invalid response",
                    )
                    .with_detail(format!("{error}; status={status}; stderr={detail}")),
                )
            })?,
            None => {
                return Err(ForkFailure::Unknown(
                    AppCommandError::task_execution_failed(
                        "The native fork bridge returned no response",
                    )
                    .with_detail(format!("status={status}; stderr={detail}")),
                ))
            }
        };
        if let Some(error) = value.get("error").and_then(Value::as_str) {
            return Err(ForkFailure::Unknown(
                AppCommandError::task_execution_failed("The native fork request failed")
                    .with_detail(error.to_string()),
            ));
        }
        let session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                ForkFailure::Unknown(AppCommandError::task_execution_failed(
                    "The native fork bridge did not return a session id",
                ))
            })?
            .to_string();
        let session_file = value
            .get("sessionFile")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string);
        Ok::<Forked, ForkFailure>(Forked {
            session_id,
            session_file,
        })
    };
    match tokio::time::timeout(FORK_TIMEOUT, operation).await {
        Ok(result) => result,
        Err(_) => Err(ForkFailure::Unknown(
            AppCommandError::task_execution_failed(
                "The native fork timed out; its outcome is unknown",
            ),
        )),
    }
}

struct KillOnDrop(tokio::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(Some(_))) {
            return;
        }
        if let Some(pid) = self.0.id() {
            let _ = kill_tree::blocking::kill_tree(pid);
        }
    }
}

/// 重新读取子会话，要求它的完整历史与锚点前缀逐条相等。
///
/// 适配器的成功响应只证明协议返回了一个 id；真正决定旁问是否"继承到最后
/// 一条已完成回合"的是它落盘的历史。多一条、少一条、内容变化都拒绝。
async fn persist_recovered(
    db: &AppDatabase,
    record: &Recovery,
) -> Result<CreateOutcome, AppCommandError> {
    let native_session_id = record
        .native_session_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(unknown_outcome)?;
    let agent = AgentType::from_wire(&record.agent).ok_or_else(|| {
        AppCommandError::invalid_input(format!("Unknown side-question agent: {}", record.agent))
    })?;

    let deadline = tokio::time::Instant::now() + BOUNDARY_TIMEOUT;
    loop {
        let result =
            match crate::research_branch::read_turns(db, agent, native_session_id.clone()).await {
                Ok(turns) => crate::research_branch::validate_history(&record.history, &turns),
                Err(error) => Err(error),
            };
        match result {
            Ok(()) => break,
            Err(error) if tokio::time::Instant::now() >= deadline => {
                return Err(error.with_detail(format!(
                    "forkedSessionId={native_session_id}; reason=history_boundary_unverified"
                )))
            }
            Err(_) => tokio::time::sleep(BOUNDARY_POLL).await,
        }
    }

    let new = NewSideQuestion {
        id: record.side_question_id,
        source_agent: agent,
        source_session_id: record.source_session_id.clone(),
        native_session_id,
        cwd: record.cwd.clone(),
        pi_session_file: record.pi_session_file.clone(),
        title: record.title.clone(),
    };
    side_question_service::create(&db.conn, new)
        .await
        .map_err(service_error)
}

fn recovery_path(data_dir: &Path, request_id: &str) -> PathBuf {
    // 哈希掉调用方可控内容：既避开 Windows 保留名，也不让路径注入。
    data_dir
        .join("native-side-question-recovery")
        .join(format!("{:x}.jsonl", Sha256::digest(request_id.as_bytes())))
}

enum RecoveryState {
    Missing,
    /// 行已写入但还没有子会话 id：可能是另一个进程正在 fork，也可能是崩溃。
    /// 两种情况都不能再 fork，只能等或报结果未知。
    Pending,
    Complete(Recovery),
}

async fn load_recovery(path: &Path) -> Result<RecoveryState, AppCommandError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let record = bytes
                .split(|byte| *byte == b'\n')
                .rev()
                .find_map(|line| serde_json::from_slice::<Recovery>(line).ok());
            Ok(match record {
                // 文件刚 create_new 出来、行还没落盘，或写到一半被杀：都算 pending。
                None => RecoveryState::Pending,
                Some(record) if record.native_session_id.is_none() => RecoveryState::Pending,
                Some(record) => RecoveryState::Complete(record),
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(RecoveryState::Missing),
        Err(error) => Err(AppCommandError::io(error)),
    }
}

/// 等同一个 requestId 的另一个进程把结果写完。
///
/// 并发调用方拿到的是同一条记录；如果等不到完整结果，宁可报"结果未知"，
/// 也不能在这里再 fork 一次。
async fn await_pending(
    db: &AppDatabase,
    path: &Path,
    request: &CreateNativeSideQuestion,
) -> Result<CreateOutcome, AppCommandError> {
    let deadline = tokio::time::Instant::now() + CONCURRENT_WAIT;
    loop {
        if let Some(existing) = side_question_service::get(&db.conn, request.side_question_id)
            .await
            .map_err(AppCommandError::db)?
        {
            if existing.title != request.title.trim() {
                return Err(AppCommandError::invalid_input(
                    "This side-question id already names a different request",
                ));
            }
            return Ok(CreateOutcome {
                record: existing,
                created: false,
            });
        }
        if let RecoveryState::Complete(record) = load_recovery(path).await? {
            verify_recovery_matches(&record, request)?;
            let outcome = persist_recovered(db, &record).await?;
            remove_recovery(path).await;
            return Ok(outcome);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(unknown_outcome());
        }
        tokio::time::sleep(BOUNDARY_POLL).await;
    }
}

async fn append_recovery(
    path: &Path,
    record: &Recovery,
    create: bool,
) -> Result<(), std::io::Error> {
    let mut bytes = serde_json::to_vec(record).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(create)
        .append(true)
        .open(path)
        .await?;
    file.write_all(&bytes).await?;
    file.sync_all().await
}

async fn remove_recovery(path: &Path) {
    if let Err(error) = tokio::fs::remove_file(path).await {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, "Native side-question recovery cleanup failed");
        }
    }
}

fn verify_recovery_matches(
    record: &Recovery,
    request: &CreateNativeSideQuestion,
) -> Result<(), AppCommandError> {
    // 刻意不比 connection_id：重启后连接 id 会变，而恢复路径正是要在没有
    // 原连接的情况下也能把已经 fork 好的结果落库。
    if record.request_id != request.request_id
        || record.side_question_id != request.side_question_id
        || record.source_conversation_id != request.source_conversation_id
        || record.title != request.title.trim()
        || record.requested_turn_id.as_deref() != request.completed_turn_id.as_deref()
    {
        return Err(AppCommandError::invalid_input(
            "This requestId already belongs to another side question",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Pi 锚点
// ---------------------------------------------------------------------------

/// 从父 Pi 会话文件里取最后一个 `stopReason: "stop"` 的 assistant entry。
///
/// `completedMessageId` 必须是 Pi 自己的 entry id；parser 把它丢掉了，所以
/// 这里按 Pi 的 active-branch 规则重读一遍文件。
fn read_pi_anchor(
    env: &crate::parsers::AgentEnv,
    session_id: &str,
) -> Result<PiAnchor, AppCommandError> {
    let base = crate::parsers::pi::resolve_pi_sessions_dir_for_env(env);
    let path = find_pi_session_file(&base, session_id).ok_or_else(|| {
        AppCommandError::not_found("The current native Pi session file is unavailable")
    })?;
    let content = std::fs::read_to_string(&path).map_err(AppCommandError::io)?;
    let mut header_id = None;
    let mut entries = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            if header_id.is_none() {
                header_id = value.get("id").and_then(Value::as_str).map(str::to_string);
            }
            continue;
        }
        entries.push(value);
    }
    if header_id.as_deref() != Some(session_id) && pi_file_id(&path) != Some(session_id.to_string())
    {
        return Err(AppCommandError::invalid_input(
            "Pi session identity does not match the connection",
        ));
    }

    let on_path = pi_active_indices(&entries);
    let mut indices: Vec<usize> = match on_path {
        Some(indices) => indices.into_iter().collect(),
        // v1 线性文件没有 id 链：按文件顺序即可，不存在被遗弃的分支。
        None => (0..entries.len()).collect(),
    };
    indices.sort_unstable();
    for index in indices.into_iter().rev() {
        let entry = &entries[index];
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message") else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant")
            || message.get("stopReason").and_then(Value::as_str) != Some("stop")
        {
            continue;
        }
        let Some(entry_id) = pi_entry_id(entry) else {
            continue;
        };
        let Some(text) = pi_assistant_text(message) else {
            continue;
        };
        return Ok(PiAnchor {
            entry_id: entry_id.to_string(),
            fingerprint: fingerprint_agent_message(&text),
            text,
        });
    }
    Err(AppCommandError::invalid_input(
        "This Pi conversation has no completed assistant turn to fork",
    ))
}

fn find_pi_session_file(base: &Path, session_id: &str) -> Option<PathBuf> {
    if !base.exists() {
        return None;
    }
    let mut by_filename = None;
    // Pi 的默认布局是 `--<dashed-cwd>--/` 一层桶；限制深度避免走进无关目录。
    for entry in WalkDir::new(base)
        .max_depth(6)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if pi_header_id(path).as_deref() == Some(session_id) {
            return Some(path.to_path_buf());
        }
        // header 可能被重写成另一个 id（pi 先写文件后补 header），文件名仍带
        // 启动时的 session id。
        if by_filename.is_none() && pi_file_id(path).as_deref() == Some(session_id) {
            by_filename = Some(path.to_path_buf());
        }
    }
    by_filename
}

fn pi_header_id(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    use std::io::{BufRead, BufReader};
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            return value
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
        }
    }
    None
}

fn pi_file_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let uuid = stem.split_once('_').map(|(_, id)| id).unwrap_or(stem);
    (!uuid.is_empty()).then(|| uuid.to_string())
}

fn pi_entry_id(value: &Value) -> Option<&str> {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

fn pi_parent_index(value: &Value, by_id: &HashMap<String, usize>) -> Option<usize> {
    match value.get("parentId")? {
        Value::String(parent) if !parent.is_empty() => by_id.get(parent).copied(),
        _ => None,
    }
}

/// Pi 的 active branch（`buildSessionPath`）。
///
/// 返回 `None` 表示无法可靠判定：v1 线性文件、叶子没有 id，或"路径没覆盖
/// 全部条目却又不构成分支"的坏链。后两种情况宁可在上层拒绝，也不猜一个可能
/// 落在被遗弃分支上的锚点。
fn pi_active_indices(entries: &[Value]) -> Option<HashSet<usize>> {
    let mut by_id = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if let Some(id) = pi_entry_id(entry) {
            by_id.insert(id.to_string(), index);
        }
    }
    if by_id.is_empty() {
        return None;
    }
    let leaf = entries.len().checked_sub(1)?;
    pi_entry_id(&entries[leaf])?;

    let mut on_path = HashSet::new();
    let mut current = Some(leaf);
    while let Some(index) = current {
        if !on_path.insert(index) {
            break;
        }
        current = pi_parent_index(&entries[index], &by_id).filter(|&parent| parent != index);
    }
    if on_path.len() == entries.len() {
        return Some(on_path);
    }
    pi_has_fork(entries, &by_id).then_some(on_path)
}

fn pi_has_fork(entries: &[Value], by_id: &HashMap<String, usize>) -> bool {
    #[derive(Clone, Copy, PartialEq, Eq, Hash)]
    enum Parent {
        Root,
        Entry(usize),
    }
    let mut seen = HashSet::new();
    entries
        .iter()
        .filter_map(|entry| match entry.get("parentId")? {
            Value::Null => Some(Parent::Root),
            Value::String(parent) if !parent.is_empty() => {
                by_id.get(parent).copied().map(Parent::Entry)
            }
            _ => None,
        })
        .any(|parent| !seen.insert(parent))
}

fn pi_assistant_text(message: &Value) -> Option<String> {
    // 必须与 `parsers::pi::assistant_content_blocks` 逐字一致：只认 content
    // 数组里的非空 text 块，无分隔符拼接。任何偏差都会让锚点文本比对失败。
    let mut text = String::new();
    for block in message.get("content")?.as_array()? {
        if block.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(part) = block.get("text").and_then(Value::as_str) {
                text.push_str(part);
            }
        }
    }
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::json;

    fn turn(index: usize, role: TurnRole, text: &str, completed: bool) -> MessageTurn {
        MessageTurn {
            id: format!("turn-{index}"),
            role,
            blocks: vec![ContentBlock::Text {
                text: text.to_string(),
            }],
            timestamp: Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: completed.then(Utc::now),
            agent_message_id: None,
        }
    }

    #[test]
    fn anchor_selection_skips_an_unfinished_tail() {
        let turns = vec![
            turn(0, TurnRole::User, "q", true),
            turn(1, TurnRole::Assistant, "done", true),
            turn(2, TurnRole::User, "next", true),
            turn(3, TurnRole::Assistant, "half", false),
        ];
        assert_eq!(
            select_completed_anchor(&turns, None, None, AgentType::Codex, None).unwrap(),
            1
        );
    }

    #[test]
    fn anchor_selection_rejects_turns_that_match_the_live_text() {
        let turns = vec![
            turn(0, TurnRole::Assistant, "old", true),
            turn(1, TurnRole::Assistant, "streaming", true),
        ];
        // 未指定的尾部正在进行中：跳过它，退回到更早的已完成回合。
        assert_eq!(
            select_completed_anchor(&turns, None, Some("streaming"), AgentType::Codex, None)
                .unwrap(),
            0
        );
        // 显式选中同一条也必须拒绝，而不是默默退到更早的回合。
        assert!(select_completed_anchor(
            &turns,
            Some("turn-1"),
            Some("streaming"),
            AgentType::Codex,
            None
        )
        .is_err());
    }

    #[test]
    fn anchor_selection_requires_a_completed_assistant() {
        let turns = vec![turn(0, TurnRole::User, "q", true)];
        assert!(select_completed_anchor(&turns, None, None, AgentType::Codex, None).is_err());
        assert!(
            select_completed_anchor(&turns, Some("turn-0"), None, AgentType::Codex, None).is_err()
        );
    }

    #[test]
    fn an_explicit_user_turn_resolves_to_the_previous_assistant() {
        let turns = vec![
            turn(0, TurnRole::Assistant, "a1", true),
            turn(1, TurnRole::User, "q2", true),
            turn(2, TurnRole::Assistant, "a2", true),
            turn(3, TurnRole::User, "q3", true),
        ];
        assert_eq!(
            select_completed_anchor(&turns, Some("turn-3"), None, AgentType::Codex, None).unwrap(),
            2
        );
    }

    #[test]
    fn pi_anchor_must_match_the_parser_turn_exactly() {
        let turns = vec![
            turn(0, TurnRole::Assistant, "a1", true),
            turn(1, TurnRole::Assistant, "a2", true),
        ];
        let pi = PiAnchor {
            entry_id: "entry-1".into(),
            fingerprint: fingerprint_agent_message("a2"),
            text: "a2".into(),
        };
        let point = build_anchor(&turns, 1, AgentType::Pi, Some(&pi)).unwrap();
        assert_eq!(point.message_id, "entry-1");

        let stale = PiAnchor {
            text: "different".into(),
            ..pi
        };
        assert!(build_anchor(&turns, 1, AgentType::Pi, Some(&stale)).is_err());
    }

    #[test]
    fn pi_branch_walk_drops_an_abandoned_tail() {
        // 末尾的 3 才是当前叶子：0 -> 1 -> 3 是 active branch；
        // 2 从 1 分叉后停在文件中间，属于被遗弃的分支。
        let entries = vec![
            json!({"id": "a", "parentId": null}),
            json!({"id": "b", "parentId": "a"}),
            json!({"id": "d", "parentId": "b"}),
            json!({"id": "c", "parentId": "b"}),
        ];
        let on_path = pi_active_indices(&entries).expect("walk");
        assert!(on_path.contains(&3));
        assert!(!on_path.contains(&2));
    }

    #[test]
    fn pi_linear_files_without_ids_keep_file_order() {
        let entries = vec![json!({"type": "message"}), json!({"type": "message"})];
        assert!(pi_active_indices(&entries).is_none());
    }

    #[test]
    fn a_broken_chain_without_a_real_fork_is_not_guessed() {
        // 3 的 parentId 悬空：这不是分支，是坏链，不能据此剪掉任何记录。
        let entries = vec![
            json!({"id": "a", "parentId": null}),
            json!({"id": "b", "parentId": "a"}),
            json!({"id": "c", "parentId": "missing"}),
        ];
        assert!(pi_active_indices(&entries).is_none());
    }

    #[test]
    fn recovery_paths_are_request_scoped_and_not_case_folded() {
        let dir = Path::new("/data");
        assert_ne!(
            recovery_path(dir, "request-A"),
            recovery_path(dir, "request-a")
        );
        assert_eq!(
            recovery_path(dir, "request-A"),
            recovery_path(dir, "request-A")
        );
    }

    #[test]
    fn recovery_must_belong_to_the_same_request() {
        let request = CreateNativeSideQuestion {
            request_id: "req-1".into(),
            side_question_id: Uuid::from_u128(1),
            connection_id: "conn".into(),
            source_conversation_id: 7,
            title: "旁问".into(),
            completed_turn_id: None,
        };
        let record = Recovery {
            request_id: "req-1".into(),
            side_question_id: Uuid::from_u128(1),
            connection_id: "conn".into(),
            source_conversation_id: 7,
            source_session_id: "session".into(),
            agent: "codex".into(),
            cwd: "/repo".into(),
            title: "旁问".into(),
            requested_turn_id: None,
            anchor_turn_id: "turn-1".into(),
            anchor_message_id: "msg".into(),
            history: vec![],
            native_session_id: Some("child".into()),
            pi_session_file: None,
        };
        assert!(verify_recovery_matches(&record, &request).is_ok());
        let mut other = request;
        other.side_question_id = Uuid::from_u128(2);
        assert!(verify_recovery_matches(&record, &other).is_err());
    }

    fn recovery_record() -> Recovery {
        Recovery {
            request_id: "req-recovery".into(),
            side_question_id: Uuid::from_u128(11),
            connection_id: "conn".into(),
            source_conversation_id: 7,
            source_session_id: "parent".into(),
            agent: "codex".into(),
            cwd: "/repo".into(),
            title: "旁问".into(),
            requested_turn_id: None,
            anchor_turn_id: "turn-1".into(),
            anchor_message_id: "msg".into(),
            history: vec!["fingerprint".into()],
            native_session_id: None,
            pi_session_file: None,
        }
    }

    #[tokio::test]
    async fn recovery_stays_pending_until_the_forked_session_id_is_durable() {
        let dir = tempfile::tempdir().unwrap();
        let path = recovery_path(dir.path(), "req-recovery");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();

        let mut record = recovery_record();
        append_recovery(&path, &record, true).await.unwrap();
        assert!(matches!(
            load_recovery(&path).await.unwrap(),
            RecoveryState::Pending
        ));
        // 第二个创建者抢不到同一个 requestId，只能等待第一个的结果。
        assert_eq!(
            append_recovery(&path, &record, true)
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );

        record.native_session_id = Some("child-session".into());
        append_recovery(&path, &record, false).await.unwrap();
        match load_recovery(&path).await.unwrap() {
            RecoveryState::Complete(record) => {
                assert_eq!(record.native_session_id.as_deref(), Some("child-session"))
            }
            _ => panic!("complete recovery was not loaded"),
        }
    }

    #[tokio::test]
    async fn a_torn_final_line_is_unknown_instead_of_a_fresh_fork() {
        let dir = tempfile::tempdir().unwrap();
        let path = recovery_path(dir.path(), "req-torn");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();

        let mut record = recovery_record();
        append_recovery(&path, &record, true).await.unwrap();
        record.native_session_id = Some("child-session".into());
        let complete = serde_json::to_string(&record).unwrap();
        let mut file = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await
            .unwrap();
        file.write_all(&complete.as_bytes()[..complete.len() / 2])
            .await
            .unwrap();

        // 最后一行是半条 JSON，只能回退到 pending；绝不能当成"没有记录"
        // 再 fork 一次。
        assert!(matches!(
            load_recovery(&path).await.unwrap(),
            RecoveryState::Pending
        ));
    }

    #[test]
    fn only_agents_with_a_native_bridge_are_accepted() {
        for agent in [
            AgentType::Codex,
            AgentType::ClaudeCode,
            AgentType::Pi,
            AgentType::DeepSeek,
        ] {
            assert!(supports_native_fork(agent));
        }
        assert!(!supports_native_fork(AgentType::Gemini));
        assert!(!supports_native_fork(AgentType::OpenCode));
    }
}
