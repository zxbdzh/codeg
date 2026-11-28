use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, Set,
    TransactionTrait,
};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::acp::agent_process::AcpAgent;
use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::npm_package;
use crate::acp::registry::CLAUDE_AGENT_ACP_PACKAGE;
use crate::acp::types::PromptInputBlock;
use crate::app_error::AppCommandError;
use crate::db::entities::conversation::{self, ConversationKind, ConversationStatus};
use crate::db::service::{agent_setting_service, conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::models::{AgentType, ConversationSelection};
use crate::parsers::claude;
use crate::web::event_bridge::EventEmitter;

const POLICY: &str = "claude-acp-readonly-v1";
pub(crate) const ADAPTER_VERSION: &str = "0.113.0";
const SDK: &str = "@anthropic-ai/claude-agent-sdk";
const SDK_VERSION: &str = "0.3.331";
const DRIVER: &str = include_str!("readonly_ask_fork.mjs");
const MAX_TRANSCRIPT_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Unavailable {
    UnsupportedAgent,
    NoCompletedHistory,
    PolicyUnavailable,
    SourceUnavailable,
}

impl Unavailable {
    fn error(self) -> AppCommandError {
        let message = match self {
            Self::UnsupportedAgent => "The agent does not support read-only side questions",
            Self::NoCompletedHistory => "The source conversation has no completed turn to inherit",
            Self::PolicyUnavailable => {
                "The verified read-only agent or its configuration is unavailable"
            }
            Self::SourceUnavailable => "The source conversation is unavailable",
        };
        AppCommandError::invalid_input(message)
    }
}

#[derive(Serialize)]
pub struct Capability {
    supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<Unavailable>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    conversation_id: i32,
    parent_conversation_id: i32,
    folder_id: i32,
    agent_type: AgentType,
}

fn created(row: conversation::Model, parent: i32) -> Result<Created, AppCommandError> {
    if row.parent_id != Some(parent)
        || row.readonly_ask_policy.as_deref() != Some(POLICY)
        || row.deleted_at.is_some()
    {
        return Err(AppCommandError::invalid_input(
            "The side question request belongs to another or deleted conversation",
        ));
    }
    Ok(Created {
        conversation_id: row.id,
        parent_conversation_id: parent,
        folder_id: row.folder_id,
        agent_type: AgentType::ClaudeCode,
    })
}

#[derive(Debug)]
pub(crate) struct Runtime {
    node: PathBuf,
    adapter: PathBuf,
    sdk: PathBuf,
}

async fn resolve_runtime() -> Option<Runtime> {
    let command =
        crate::commands::acp::resolve_npx_command_for(AgentType::ClaudeCode, "claude-agent-acp")
            .await?;
    let dir = npm_package::package_dir_for_command(&command, CLAUDE_AGENT_ACP_PACKAGE)?;
    let sdk_dir = npm_package::resolve_from(&dir, SDK)?;
    let adapter = dir.join("dist/index.js");
    let sdk = sdk_dir.join("sdk.mjs");
    // 工具白名单的语义随 adapter 和 SDK 版本变化，未验证的安装不能回退到普通连接。
    if npm_package::version(&dir, CLAUDE_AGENT_ACP_PACKAGE).as_deref() != Some(ADAPTER_VERSION)
        || npm_package::version(&sdk_dir, SDK).as_deref() != Some(SDK_VERSION)
        || !adapter.is_file()
        || !sdk.is_file()
    {
        return None;
    }
    Some(Runtime {
        node: which::which("node").ok()?,
        adapter,
        sdk,
    })
}

impl Runtime {
    pub(crate) fn agent(&self, env: &BTreeMap<String, String>) -> AcpAgent {
        use agent_client_protocol::schema::v1::{EnvVariable, McpServer, McpServerStdio};
        let vars = env
            .iter()
            .map(|(key, value)| EnvVariable::new(key.clone(), value.clone()))
            .collect();
        AcpAgent::new(McpServer::Stdio(
            McpServerStdio::new("readonly Claude ACP", self.node.clone())
                .args(vec![self.adapter.to_string_lossy().into_owned()])
                .env(vars),
        ))
        .with_isolated_env()
    }
}

/// 旁问正文（隔离 HOME 下的原生会话文件）所在目录；备份按这个入口登记，
/// 避免运行时与归档各自推导出不同路径。
pub(crate) fn root_dir() -> PathBuf {
    std::env::var_os("CODEG_DATA_DIR")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(crate::paths::codeg_home_dir)
        .join("readonly-asks")
}

pub(crate) fn history_home(request_id: &str) -> Option<PathBuf> {
    let id = Uuid::parse_str(request_id).ok()?;
    let root = root_dir();
    root.is_absolute()
        .then(|| root.join(id.simple().to_string()))
}

fn provider_env(env: &BTreeMap<String, String>, home: &Path) -> Option<BTreeMap<String, String>> {
    // 运行配置里的空值表示显式清除此变量，不得从宿主环境补回凭据。
    let get = |key: &str| {
        env.get(key)
            .cloned()
            .or_else(|| std::env::var(key).ok())
            .filter(|value| !value.trim().is_empty())
    };
    const PROVIDER: &[&str] = &[
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "CLAUDE_MODEL_CONFIG",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
    ];
    let mut result: BTreeMap<String, String> = PROVIDER
        .iter()
        .filter_map(|key| get(key).map(|v| (key.to_string(), v)))
        .collect();
    if !["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
        .into_iter()
        .any(|key| result.get(key).is_some_and(|v| !v.trim().is_empty()))
        || [
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ]
        .into_iter()
        .any(|key| get(key).is_some_and(|v| v != "0" && !v.is_empty()))
    {
        return None;
    }
    // 只传平台启动所需变量与当前 provider，避免继承宿主的 CLI 或 Node 执行配置。
    const PLATFORM: &[&str] = &[
        "PATH",
        "SystemRoot",
        "SystemDrive",
        "ComSpec",
        "PATHEXT",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    ];
    result.extend(
        PLATFORM
            .iter()
            .filter_map(|key| std::env::var(key).ok().map(|v| (key.to_string(), v))),
    );
    let home_string = home.to_str()?.to_string();
    result.extend(
        [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
        ]
        .into_iter()
        .map(|key| (key.to_string(), home_string.clone())),
    );
    result.extend([
        ("CLAUDE_CONFIG_DIR".into(), home.to_str()?.into()),
        (
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
            "1".into(),
        ),
        ("DISABLE_AUTOUPDATER".into(), "1".into()),
    ]);
    Some(result)
}

pub(crate) fn claude_options() -> Value {
    json!({
        "promptSuggestions": false,
        "settingSources": [],
        "strictMcpConfig": true,
        "tools": ["Read", "Glob", "Grep"],
        "allowDangerouslySkipPermissions": false,
        "settings": { "disableAllHooks": true },
        "extraArgs": { "disable-slash-commands": null },
    })
}

pub(crate) fn validate_prompt(blocks: &[PromptInputBlock]) -> Result<(), AcpError> {
    // 不把 Claude 本地斜杠命令交给模型工具白名单，命令有自己的一套执行路径。
    if blocks.iter().any(|block| matches!(block, PromptInputBlock::Text { text } if text.trim_start().starts_with('/'))) {
        return Err(AcpError::protocol("Local commands are disabled in read-only side questions"));
    }
    Ok(())
}

pub(crate) async fn row_by_native(
    db: &DatabaseConnection,
    id: &str,
) -> Result<Option<conversation::Model>, sea_orm::DbErr> {
    conversation::Entity::find()
        .filter(conversation::Column::ExternalId.eq(id))
        .filter(conversation::Column::ReadonlyAskPolicy.is_not_null())
        .one(db)
        .await
}

pub(crate) fn can_resume_row(row: &conversation::Model) -> bool {
    row.deleted_at.is_none()
        && row.kind == ConversationKind::Ask
        && row.readonly_ask_policy.as_deref() == Some(POLICY)
        && conversation_service::parse_agent_type(&row.agent_type) == AgentType::ClaudeCode
}

pub(crate) struct Resume {
    pub(crate) row_id: i32,
    pub(crate) cwd: String,
    pub(crate) session_id: String,
    pub(crate) config: BTreeMap<String, String>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) runtime: Runtime,
}

pub(crate) async fn prepare_resume(
    db: &DatabaseConnection,
    row_id: Option<i32>,
    native_id: Option<&str>,
    agent: AgentType,
    env: &BTreeMap<String, String>,
) -> Result<Option<Resume>, AcpError> {
    let db_error = |error: sea_orm::DbErr| AcpError::protocol(error.to_string());
    let by_row = match row_id {
        Some(id) => conversation::Entity::find_by_id(id)
            .one(db)
            .await
            .map_err(db_error)?
            .filter(|row| row.readonly_ask_policy.is_some()),
        None => None,
    };
    let row = match (by_row, native_id) {
        (Some(row), _) => Some(row),
        (None, Some(id)) => row_by_native(db, id).await.map_err(db_error)?,
        (None, None) => None,
    };
    let Some(row) = row else { return Ok(None) };
    let denied =
        || AcpError::protocol("Cannot open this conversation with the verified read-only policy");
    if row_id.is_some_and(|id| id != row.id)
        || agent != AgentType::ClaudeCode
        || !can_resume_row(&row)
    {
        return Err(denied());
    }
    let session_id = row
        .external_id
        .filter(|id| Uuid::parse_str(id).is_ok() && native_id.is_none_or(|actual| actual == id))
        .ok_or_else(denied)?;
    let home = row
        .readonly_ask_request_id
        .as_deref()
        .and_then(history_home)
        .ok_or_else(denied)?;
    let cwd = row
        .origin_cwd
        .filter(|cwd| Path::new(cwd).is_absolute() && Path::new(cwd).is_dir())
        .ok_or_else(denied)?;
    let env = provider_env(env, &home).ok_or_else(denied)?;
    let config = ConversationSelection::parse(row.selector_state.as_deref())
        .and_then(|sel| frozen_config(&sel.config_values))
        .ok_or_else(denied)?;
    if claude::find_session_file_in(&home.join("projects"), &session_id).is_none() {
        return Err(denied());
    }
    let runtime = resolve_runtime().await.ok_or_else(denied)?;
    Ok(Some(Resume {
        row_id: row.id,
        cwd,
        session_id,
        config,
        env,
        runtime,
    }))
}

fn frozen_config(values: &BTreeMap<String, String>) -> Option<BTreeMap<String, String>> {
    ["model", "effort"]
        .into_iter()
        .map(|key| {
            values
                .get(key)
                .filter(|value| !value.is_empty())
                .map(|value| (key.to_string(), value.clone()))
        })
        .collect()
}

struct Source {
    row: conversation::Model,
    transcript: PathBuf,
    cutoff: DateTime<Utc>,
    cwd: String,
    config: BTreeMap<String, String>,
}

async fn source_row(db: &DatabaseConnection, id: i32) -> Result<conversation::Model, Unavailable> {
    let mut id = id;
    for _ in 0..16 {
        let row = conversation::Entity::find_by_id(id)
            .filter(conversation::Column::DeletedAt.is_null())
            .one(db)
            .await
            .map_err(|_| Unavailable::SourceUnavailable)?
            .ok_or(Unavailable::SourceUnavailable)?;
        if row.kind != ConversationKind::Ask {
            return Ok(row);
        }
        id = row.parent_id.ok_or(Unavailable::SourceUnavailable)?;
    }
    Err(Unavailable::SourceUnavailable)
}

async fn source(
    db: &AppDatabase,
    manager: &ConnectionManager,
    row: conversation::Model,
    requested_at: DateTime<Utc>,
) -> Result<Source, Unavailable> {
    if conversation_service::parse_agent_type(&row.agent_type) != AgentType::ClaudeCode {
        return Err(Unavailable::UnsupportedAgent);
    }
    let native_id = row
        .external_id
        .as_deref()
        .ok_or(Unavailable::NoCompletedHistory)?;
    if Uuid::parse_str(native_id).is_err() {
        return Err(Unavailable::SourceUnavailable);
    }
    let folder = folder_service::get_folder_by_id(&db.conn, row.folder_id)
        .await
        .map_err(|_| Unavailable::SourceUnavailable)?
        .ok_or(Unavailable::SourceUnavailable)?;
    let cwd = row.origin_cwd.clone().unwrap_or(folder.path);
    if !Path::new(&cwd).is_absolute() || !Path::new(&cwd).is_dir() {
        return Err(Unavailable::SourceUnavailable);
    }
    let launch_env = agent_setting_service::load_agent_env(&db.conn, AgentType::ClaudeCode).await;
    let mut cutoff = requested_at;
    let mut config = ConversationSelection::parse(row.selector_state.as_deref())
        .and_then(|sel| frozen_config(&sel.config_values));
    if let Some(conn) = manager
        .find_connection_by_external_id_in(native_id, AgentType::ClaudeCode, None)
        .await
    {
        let state = manager
            .get_state(&conn)
            .await
            .ok_or(Unavailable::SourceUnavailable)?;
        let state = state.read().await;
        if state.external_id.as_deref() != Some(native_id) || state.readonly_ask_row.is_some() {
            return Err(Unavailable::SourceUnavailable);
        }
        if state.turn_in_flight || state.last_turn_ended_abnormally {
            // 在途回合可以先写最终文本，只有主连接已确认成功结束的回合可以进入快照。
            let before_active_turn = state
                .pending_user_message_started_at
                .map(|time| time - chrono::TimeDelta::milliseconds(1));
            let confirmed = state
                .last_successful_turn_at
                .or(before_active_turn)
                .ok_or(Unavailable::NoCompletedHistory)?;
            cutoff = cutoff.min(confirmed);
        }
        if state.selectors_settling {
            return Err(Unavailable::PolicyUnavailable);
        }
        if let Some(opts) = &state.config_options {
            config = frozen_config(&crate::acp::connection::current_config_option_values(opts));
        }
    }
    let base = claude::resolve_claude_projects_dir_for_env(&launch_env);
    let transcript =
        claude::find_session_file_in(&base, native_id).ok_or(Unavailable::NoCompletedHistory)?;
    Ok(Source {
        row,
        transcript,
        cutoff,
        cwd,
        config: config.ok_or(Unavailable::PolicyUnavailable)?,
    })
}

fn completed_anchor(bytes: &[u8], cutoff: DateTime<Utc>) -> Option<Uuid> {
    // Claude 的渲染时间戳也会出现在工具中间消息上，原生 end_turn 才是回合边界。
    bytes
        .split_inclusive(|byte| *byte == b'\n')
        .rev()
        .filter(|line| line.ends_with(b"\n"))
        .find_map(|line| {
            let entry: Value = serde_json::from_slice(line).ok()?;
            if entry["type"] != "assistant"
                || entry["message"]["stop_reason"] != "end_turn"
                || entry["isSidechain"] == true
                || !entry["parent_tool_use_id"].is_null()
                || !entry["parent_agent_id"].is_null()
            {
                return None;
            }
            let logged = entry["timestamp"].as_str()?.parse::<DateTime<Utc>>().ok()?;
            (logged <= cutoff)
                .then(|| Uuid::parse_str(entry["uuid"].as_str()?).ok())
                .flatten()
        })
}

async fn read_snapshot(path: &Path) -> Result<Vec<u8>, Unavailable> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| Unavailable::SourceUnavailable)?;
    if !file
        .metadata()
        .await
        .map_err(|_| Unavailable::SourceUnavailable)?
        .is_file()
    {
        return Err(Unavailable::SourceUnavailable);
    }
    let mut bytes = Vec::new();
    file.take(MAX_TRANSCRIPT_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Unavailable::SourceUnavailable)?;
    if bytes.len() as u64 > MAX_TRANSCRIPT_BYTES {
        return Err(Unavailable::SourceUnavailable);
    }
    // 只复制已完整写入的 JSONL 记录，尾部可能是主进程此刻正在写的记录。
    bytes.truncate(
        bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |last| last + 1),
    );
    Ok(bytes)
}

pub async fn capability(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    parent: i32,
) -> Capability {
    let requested_at = Utc::now();
    let result = async {
        let source = source(
            db,
            manager,
            source_row(&db.conn, parent).await?,
            requested_at,
        )
        .await?;
        let snapshot = read_snapshot(&source.transcript).await?;
        completed_anchor(&snapshot, source.cutoff).ok_or(Unavailable::NoCompletedHistory)?;
        let env = crate::commands::acp::build_session_runtime_env(
            db,
            AgentType::ClaudeCode,
            source.row.external_id.as_deref(),
            data_dir,
        )
        .await
        .map_err(|_| Unavailable::PolicyUnavailable)?;
        provider_env(&env, &root_dir()).ok_or(Unavailable::PolicyUnavailable)?;
        resolve_runtime()
            .await
            .ok_or(Unavailable::PolicyUnavailable)?;
        Ok::<_, Unavailable>(())
    }
    .await;
    Capability {
        supported: result.is_ok(),
        reason: result.err(),
    }
}

fn create_io_error(error: std::io::Error) -> AppCommandError {
    AppCommandError::task_execution_failed("Could not write the isolated side question history")
        .with_detail(error.to_string())
}

async fn fork(
    runtime: Runtime,
    env: BTreeMap<String, String>,
    home: &Path,
    source: &Source,
    bytes: Vec<u8>,
    anchor: Uuid,
) -> Result<String, AppCommandError> {
    let source_id = source
        .row
        .external_id
        .as_deref()
        .ok_or_else(|| Unavailable::NoCompletedHistory.error())?;
    let project = source
        .transcript
        .parent()
        .and_then(Path::file_name)
        .ok_or_else(|| Unavailable::SourceUnavailable.error())?;
    // 主线副本只用于 SDK 分支，落盘的旁问目录只接收验证后的子会话文件。
    let staging = tempfile::tempdir_in(
        home.parent()
            .ok_or_else(|| Unavailable::PolicyUnavailable.error())?,
    )
    .map_err(create_io_error)?;
    let relative_project = Path::new("projects").join(project);
    let staged_project = staging.path().join(&relative_project);
    tokio::fs::create_dir_all(&staged_project)
        .await
        .map_err(create_io_error)?;
    tokio::fs::write(staged_project.join(format!("{source_id}.jsonl")), bytes)
        .await
        .map_err(create_io_error)?;
    let request =
        json!({"sdkPath": runtime.sdk, "sourceId": source_id, "anchor": anchor}).to_string();
    let mut process = crate::process::tokio_command(runtime.node);
    process
        .current_dir(staging.path())
        .kill_on_drop(true)
        .args(["--input-type=module", "-e", DRIVER, &request]);
    process
        .env_clear()
        .envs(env)
        .env("CLAUDE_CONFIG_DIR", staging.path());
    let output = tokio::time::timeout(Duration::from_secs(25), process.output())
        .await
        .map_err(|_| AppCommandError::task_execution_failed("Native side question fork timed out"))?
        .map_err(create_io_error)?;
    let id = std::str::from_utf8(&output.stdout)
        .ok()
        .and_then(|id| Uuid::parse_str(id.trim()).ok());
    let Some(id) = id.filter(|id| output.status.success() && id.to_string() != source_id) else {
        return Err(AppCommandError::task_execution_failed(
            "Claude could not verify a native branch of the completed turn",
        ));
    };
    let name = format!("{id}.jsonl");
    let project = home.join(relative_project);
    tokio::fs::create_dir_all(&project)
        .await
        .map_err(create_io_error)?;
    let branch = claude::find_session_file_in(&staging.path().join("projects"), &id.to_string())
        .ok_or_else(|| Unavailable::SourceUnavailable.error())?;
    tokio::fs::rename(branch, project.join(name))
        .await
        .map_err(create_io_error)?;
    Ok(id.to_string())
}

pub async fn create(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    parent: i32,
    request_id: String,
    title: Option<String>,
) -> Result<Created, AppCommandError> {
    let requested_at = Utc::now();
    let request_id = Uuid::parse_str(&request_id)
        .map_err(|_| AppCommandError::invalid_input("Side question requestId must be a UUID"))?
        .to_string();
    let home = history_home(&request_id).ok_or_else(|| Unavailable::PolicyUnavailable.error())?;
    let parent = source_row(&db.conn, parent)
        .await
        .map_err(Unavailable::error)?;
    tokio::fs::create_dir_all(root_dir())
        .await
        .map_err(create_io_error)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .read(true)
        .open(root_dir().join(format!("{request_id}.lock")))
        .map_err(create_io_error)?;
    // 文件锁让共享同一数据库的桌面端和 Web 端也能按同一个 requestId 串行创建。
    lock.try_lock().map_err(|_| {
        AppCommandError::invalid_input(
            "The side question is already being created; retry with the same requestId",
        )
    })?;
    if let Some(row) = conversation::Entity::find()
        .filter(conversation::Column::ReadonlyAskRequestId.eq(&request_id))
        .one(&db.conn)
        .await
        .map_err(crate::db::error::DbError::from)?
    {
        return created(row, parent.id);
    }
    let source = source(db, manager, parent, requested_at)
        .await
        .map_err(Unavailable::error)?;
    let bytes = read_snapshot(&source.transcript)
        .await
        .map_err(Unavailable::error)?;
    let anchor = completed_anchor(&bytes, source.cutoff)
        .ok_or_else(|| Unavailable::NoCompletedHistory.error())?;
    let runtime = resolve_runtime()
        .await
        .ok_or_else(|| Unavailable::PolicyUnavailable.error())?;
    let env = crate::commands::acp::build_session_runtime_env(
        db,
        AgentType::ClaudeCode,
        source.row.external_id.as_deref(),
        data_dir,
    )
    .await
    .map_err(|_| Unavailable::PolicyUnavailable.error())?;
    let env = provider_env(&env, &home).ok_or_else(|| Unavailable::PolicyUnavailable.error())?;
    // 请求中断后仍然完成提交或清理，重试不会重复发送首问或创建第二条 Ask。
    let conn = db.conn.clone();
    let emitter = emitter.clone();
    tokio::spawn(async move {
        let _lock = lock;
        if home.exists() {
            tokio::fs::remove_dir_all(&home)
                .await
                .map_err(create_io_error)?;
        }
        let result = async {
            let native_id = fork(runtime, env, &home, &source, bytes, anchor).await?;
            let row = persist(&conn, source, request_id, title, native_id).await?;
            let parent = row
                .parent_id
                .ok_or_else(|| Unavailable::SourceUnavailable.error())?;
            crate::commands::conversations::emit_conversation_upsert(&emitter, &conn, row.id).await;
            crate::commands::conversations::emit_conversation_upsert(&emitter, &conn, parent).await;
            created(row, parent)
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_dir_all(&home).await;
        }
        result
    })
    .await
    .map_err(|_| {
        AppCommandError::task_execution_failed("Could not finish creating the side question")
    })?
}

async fn persist(
    conn: &DatabaseConnection,
    source: Source,
    request_id: String,
    title: Option<String>,
    native_id: String,
) -> Result<conversation::Model, AppCommandError> {
    use crate::db::error::DbError;
    let trx = conn.begin().await.map_err(DbError::from)?;
    // 主线如果在分支期间被删除或切成另一个原生会话，不把旁问挂到错误的记录上。
    let current = conversation::Entity::find_by_id(source.row.id)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(&trx)
        .await
        .map_err(DbError::from)?
        .filter(|row| {
            row.external_id == source.row.external_id && row.folder_id == source.row.folder_id
        })
        .ok_or_else(|| Unavailable::SourceUnavailable.error())?;
    let model = source.config.get("model").cloned();
    let selection = ConversationSelection {
        config_values: source.config,
        ..Default::default()
    };
    let now = Utc::now();
    let row = conversation::ActiveModel {
        folder_id: Set(current.folder_id),
        title: Set(title),
        title_locked: Set(true),
        agent_type: Set(current.agent_type),
        kind: Set(ConversationKind::Ask),
        status: Set(ConversationStatus::Completed),
        model: Set(model),
        git_branch: Set(current.git_branch),
        external_id: Set(Some(native_id)),
        parent_id: Set(Some(current.id)),
        message_count: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        origin_cwd: Set(Some(source.cwd)),
        selector_state: Set(Some(selection.to_json())),
        readonly_ask_policy: Set(Some(POLICY.into())),
        readonly_ask_request_id: Set(Some(request_id)),
        ..Default::default()
    }
    .insert(&trx)
    .await
    .map_err(DbError::from)?;
    trx.commit().await.map_err(DbError::from)?;
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};

    #[test]
    fn readonly_ask_anchor_ignores_open_turns_subagents_and_partial_records() {
        let cutoff: DateTime<Utc> = "2026-11-28T09:00:05Z".parse().unwrap();
        let completed = Uuid::new_v4();
        let record = |uuid: Uuid, timestamp: &str, reason: &str, child: bool| {
            json!({
                "type": "assistant", "uuid": uuid, "timestamp": timestamp, "isSidechain": child,
                "message": {"stop_reason": reason},
            })
        };
        let trailing = record(Uuid::new_v4(), "2026-11-28T09:00:02Z", "end_turn", false);
        let transcript = format!(
            "{}
{}
{}
{}
{}",
            record(completed, "2026-11-28T09:00:01Z", "end_turn", false),
            record(Uuid::new_v4(), "2026-11-28T09:00:02Z", "tool_use", false),
            record(Uuid::new_v4(), "2026-11-28T09:00:03Z", "end_turn", true),
            record(Uuid::new_v4(), "2026-11-28T09:00:06Z", "end_turn", false),
            trailing
        );
        assert_eq!(
            completed_anchor(transcript.as_bytes(), cutoff),
            Some(completed)
        );
        assert_eq!(
            completed_anchor(trailing.to_string().as_bytes(), cutoff),
            None
        );
    }

    #[tokio::test]
    async fn readonly_ask_row_identity_survives_legacy_operations() {
        use sea_orm::IntoActiveModel;
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-readonly-ask").await;
        let parent =
            conversation_service::create(&db.conn, folder, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        let legacy = conversation_service::create_ask(
            &db.conn,
            parent.id,
            folder,
            AgentType::ClaudeCode,
            None,
            None,
        )
        .await
        .unwrap();
        let native_id = Uuid::new_v4().to_string();
        let env = BTreeMap::new();
        assert!(
            prepare_resume(&db.conn, Some(legacy.id), None, AgentType::ClaudeCode, &env)
                .await
                .unwrap()
                .is_none()
        );
        assert!(conversation_service::detach_ask(&db.conn, legacy.id)
            .await
            .unwrap()
            .is_some());

        let mut parent_model = parent.clone().into_active_model();
        parent_model.external_id = Set(Some(Uuid::new_v4().to_string()));
        let parent = parent_model.update(&db.conn).await.unwrap();
        let source = Source {
            row: parent.clone(),
            transcript: PathBuf::new(),
            cutoff: Utc::now(),
            cwd: "/tmp/codeg-readonly-ask".into(),
            config: BTreeMap::from([
                ("model".into(), "model".into()),
                ("effort".into(), "medium".into()),
            ]),
        };
        let request_id = Uuid::new_v4().to_string();
        let row = persist(
            &db.conn,
            source,
            request_id.clone(),
            None,
            native_id.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            conversation::Entity::find_by_id(parent.id)
                .one(&db.conn)
                .await
                .unwrap(),
            Some(parent.clone())
        );
        assert_eq!(
            created(row.clone(), parent.id).unwrap().conversation_id,
            row.id
        );
        assert!(conversation_service::detach_ask(&db.conn, row.id)
            .await
            .unwrap()
            .is_none());
        assert!(conversation_service::bind_external_id(&db.conn, row.id, &native_id, &[])
            .await
            .is_ok());
        assert!(conversation_service::bind_external_id(&db.conn, row.id, "different-session", &[])
            .await
            .is_err());
        assert!(!conversation_service::set_selector_state(
            &db.conn,
            row.id,
            &ConversationSelection::default()
        )
        .await
        .unwrap());
        assert_eq!(
            row_by_native(&db.conn, &native_id)
                .await
                .unwrap()
                .unwrap()
                .readonly_ask_request_id
                .as_deref(),
            Some(request_id.as_str())
        );
        assert!(prepare_resume(
            &db.conn,
            Some(parent.id),
            Some(&native_id),
            AgentType::ClaudeCode,
            &env
        )
        .await
        .is_err());
        assert!(
            prepare_resume(&db.conn, None, Some(&native_id), AgentType::Codex, &env)
                .await
                .is_err()
        );
        let mut row = row.into_active_model();
        row.readonly_ask_policy = Set(Some("future-policy".into()));
        let row = row.update(&db.conn).await.unwrap();
        assert!(
            prepare_resume(&db.conn, Some(row.id), None, AgentType::ClaudeCode, &env)
                .await
                .is_err()
        );
        assert!(conversation_service::detach_ask(&db.conn, row.id)
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn readonly_ask_never_exposes_local_commands_or_inherited_agent_overrides() {
        let home = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([
            ("ANTHROPIC_API_KEY".into(), "fixture-key".into()),
            ("CLAUDE_CODE_EXECUTABLE".into(), "fixture-override".into()),
            ("NODE_OPTIONS".into(), "fixture-override".into()),
        ]);
        let isolated = provider_env(&env, home.path()).unwrap();
        assert!(!isolated.contains_key("CLAUDE_CODE_EXECUTABLE"));
        assert!(!isolated.contains_key("NODE_OPTIONS"));
        assert_eq!(
            isolated.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            home.path().to_str()
        );
        let block = |text: &str| PromptInputBlock::Text { text: text.into() };
        assert!(validate_prompt(&[block("  /clear")]).is_err());
        assert!(validate_prompt(&[block("What does /clear do?")]).is_ok());
    }

    #[test]
    fn readonly_ask_config_requires_both_model_and_effort() {
        let both = BTreeMap::from([
            ("model".to_string(), "gateway-model".to_string()),
            ("effort".to_string(), "medium".to_string()),
        ]);
        assert_eq!(frozen_config(&both).map(|c| c.len()), Some(2));
        // 只有 model 时无法在连接上还原相同的推理强度，按不可用处理而不是静默降级。
        let model_only = BTreeMap::from([("model".to_string(), "gateway-model".to_string())]);
        assert!(frozen_config(&model_only).is_none());
        let empty_effort = BTreeMap::from([
            ("model".to_string(), "gateway-model".to_string()),
            ("effort".to_string(), String::new()),
        ]);
        assert!(frozen_config(&empty_effort).is_none());
    }
}
