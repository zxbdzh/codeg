//! 旁问（native side question）的只读 PTY 启动与重连。
//!
//! 这里只做一件事：把一条已经 fork 好的 `side_question_session` 行变成 PTY。
//!
//! - 会话身份只取 `row.native_session_id`，绝不新建、fork 或续写主线；
//! - 只读参数完全交给 [`crate::native_side_policy::launch`]，本模块不自己拼接
//!   沙箱开关，也不在策略不支持时降级成"应该不会写"；
//! - 已经在运行的终端复用同一个 `terminalId`；不存在或已退出才用独立 argv
//!   PTY 启动，绝不经过通用 shell 文本。

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::Value;
use uuid::Uuid;

use crate::app_error::AppCommandError;
use crate::commands::acp::{
    build_session_runtime_env, cached_npm_global_prefix, pi_command_for_env,
    resolve_npx_command_for, resolve_pi_command_in, resolve_system_agent_binary_for,
};
use crate::db::entities::side_question_session;
use crate::db::AppDatabase;
use crate::models::AgentType;
use crate::native_side_policy::{self, Platform, SideAgent, SidePolicyError};
use crate::terminal::error::TerminalError;
use crate::terminal::manager::{ArgvSpawnOptions, TerminalManager};
use crate::web::event_bridge::EventEmitter;

/// `codex mcp list --json` 只该输出一份服务器清单；超过这个大小说明配置或
/// 输出方式异常，宁可拒绝解析。
const MAX_INVENTORY_BYTES: usize = 1024 * 1024;
/// Pi 的 session header 在最前面；限制行数和字节数，避免被异常文件拖住。
const MAX_PI_HEADER_LINES: usize = 64;
const MAX_PI_HEADER_BYTES: usize = 256 * 1024;

/// 一次可执行的启动计划。`env` 与 ACP 启动共用同一份运行时环境，不额外
/// 注入凭据，也不回传给调用方展示。
struct LaunchPlan {
    program: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    files: Vec<tempfile::TempPath>,
}

/// 解析后的 CLI 入口。JS 入口必须由 `node` 运行，因此分成"程序 + 前置参数"。
struct CliEntry {
    program: String,
    prefix: Vec<String>,
}

impl CliEntry {
    fn command(&self, args: &[String]) -> (String, Vec<String>) {
        let mut full = self.prefix.clone();
        full.extend_from_slice(args);
        (self.program.clone(), full)
    }
}

/// 旁问终端的唯一 id，与 `commands::native_session` 的关闭路径保持同一派生。
///
/// 行里存的是 UUID 字符串；这里按规范形式重新格式化，避免调用方写入大写或
/// 带多余空白的 id 后，打开与关闭算出两个不同的终端。
pub fn side_terminal_id(row_id: &str) -> Result<String, AppCommandError> {
    let id = Uuid::parse_str(row_id.trim()).map_err(|_| {
        AppCommandError::invalid_input("The side question id is not a UUID")
    })?;
    Ok(format!("native-side-{id}"))
}

/// 在 fork 之前做的只读启动探测。
///
/// 只验证"这个 agent 现在能不能以只读方式恢复这条会话"，不创建终端、不写库。
/// 例如 Codex 必须在真实 cwd/env 下读到完整 MCP 清单，否则无法保证只读。
pub async fn preflight(
    db: &AppDatabase,
    agent: AgentType,
    session_id: &str,
    cwd: &Path,
    data_dir: &Path,
) -> Result<(), AppCommandError> {
    validate_launch_inputs(agent, session_id, cwd)?;
    let runtime_env = runtime_env_for(db, agent, session_id, data_dir).await?;
    plan_launch(agent, session_id, None, cwd, &runtime_env)
        .await
        .map(|_| ())
}

/// 打开（或重新连接）一条旁问终端。
///
/// 先做完整校验再决定复用还是启动，所以"终端还活着"不能成为跳过策略检查的
/// 理由：CLI 可能已被卸载，策略也可能已经收紧。
pub async fn open(
    db: &AppDatabase,
    terminals: &TerminalManager,
    emitter: EventEmitter,
    data_dir: &Path,
    owner: &str,
    row: &side_question_session::Model,
) -> Result<String, AppCommandError> {
    let owner = owner.trim();
    if owner.is_empty() {
        return Err(AppCommandError::invalid_input(
            "ownerWindowLabel is required",
        ));
    }
    let terminal_id = side_terminal_id(&row.id)?;
    let agent = validate_row(row)?;
    let cwd = Path::new(&row.cwd);

    let runtime_env = runtime_env_for(db, agent, &row.native_session_id, data_dir).await?;
    let plan = plan_launch(
        agent,
        &row.native_session_id,
        row.pi_session_file.as_deref(),
        cwd,
        &runtime_env,
    )
    .await?;

    if let Some(existing) = reuse_running(terminals, &terminal_id, owner)? {
        return Ok(existing);
    }

    // shortcut: `spawn_argv_with_id` 只做 `cmd.env(k, v)`，不识别 runtime_env
    // 里空串代表“移除继承变量”的约定；当前四个旁问 agent 不依赖该语义。
    // 若将来接入会在空值上做鉴权区分的 CLI，需要先让 terminal manager 支持 env_remove。
    let extra_env = plan.env.into_iter().collect();
    let spawn = terminals.spawn_argv_with_id(
        ArgvSpawnOptions {
            terminal_id: terminal_id.clone(),
            program: plan.program,
            args: plan.args,
            working_dir: row.cwd.clone(),
            owner_window_label: owner.to_string(),
            extra_env: Some(extra_env),
            temp_files: plan.files.iter().map(|file| file.to_path_buf()).collect(),
        },
        emitter,
    );

    match spawn {
        Ok(id) => {
            for file in plan.files {
                // PTY 生命周期接管临时策略文件，退出时由 TerminalManager 清理。
                let _ = file.keep();
            }
            Ok(id)
        }
        Err(error) => {
            // 并发 open 可能已经抢先启动了同一个 terminalId；只复用同 owner
            // 的活终端，其他情况保留原始失败原因。
            if let Some(existing) = reuse_running(terminals, &terminal_id, owner)? {
                return Ok(existing);
            }
            let detail = error.to_string();
            Err(match error {
                TerminalError::NotFound(_) => AppCommandError::not_found(detail),
                _ => AppCommandError::task_execution_failed(
                    "Could not start the side-question terminal",
                )
                .with_detail(detail),
            })
        }
    }
}

fn validate_launch_inputs(
    agent: AgentType,
    session_id: &str,
    cwd: &Path,
) -> Result<(), AppCommandError> {
    side_agent(agent)?;
    if session_id.trim().is_empty() {
        return Err(AppCommandError::invalid_input(
            "A native session id is required",
        ));
    }
    // 相对路径会按 codeg 自己的 cwd 解析，恢复出来的 CLI 会跑在错误目录里。
    if !cwd.is_absolute() {
        return Err(AppCommandError::invalid_input(
            "The side-question working directory is not an absolute path",
        ));
    }
    if !cwd.is_dir() {
        return Err(AppCommandError::invalid_input(format!(
            "The side-question working directory does not exist: {}",
            cwd.display()
        )));
    }
    Ok(())
}

/// 校验一行旁问记录，返回它声明的 agent。
fn validate_row(row: &side_question_session::Model) -> Result<AgentType, AppCommandError> {
    let agent = AgentType::from_wire(&row.source_agent_type).ok_or_else(|| {
        AppCommandError::invalid_input(format!(
            "Unknown side-question agent: {}",
            row.source_agent_type
        ))
    })?;
    side_agent(agent)?;
    if row.native_session_id.trim().is_empty() {
        return Err(AppCommandError::invalid_input(
            "The side question has no native session id",
        ));
    }
    // 只允许恢复 fork 出来的旁问；指向主会话会把主线再开一份，也绕过了旁问
    // 的独立生命周期。
    if row.native_session_id == row.source_session_id {
        return Err(AppCommandError::invalid_input(
            "The side question session is the source session; only forked sessions may be reopened",
        ));
    }
    validate_launch_inputs(agent, &row.native_session_id, Path::new(&row.cwd)).map(|_| agent)
}

async fn runtime_env_for(
    db: &AppDatabase,
    agent: AgentType,
    session_id: &str,
    data_dir: &Path,
) -> Result<BTreeMap<String, String>, AppCommandError> {
    build_session_runtime_env(db, agent, Some(session_id), data_dir)
        .await
        .map_err(|error| {
            AppCommandError::configuration_invalid(
                "Could not resolve the agent runtime settings",
            )
            .with_detail(error.to_string())
        })
}

fn side_agent(agent: AgentType) -> Result<SideAgent, AppCommandError> {
    match agent {
        AgentType::Codex => Ok(SideAgent::Codex),
        AgentType::ClaudeCode => Ok(SideAgent::ClaudeCode),
        AgentType::Pi => Ok(SideAgent::Pi),
        AgentType::DeepSeek => Ok(SideAgent::DeepSeek),
        other => Err(AppCommandError::invalid_input(format!(
            "Agent {} has no read-only side terminal",
            other.as_wire()
        ))),
    }
}

fn current_platform() -> Platform {
    if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Unix
    }
}

fn policy_error(error: SidePolicyError) -> AppCommandError {
    let message = error.to_string();
    match error {
        // 策略拒绝的是"无法给出可验证的只读保证"，而不是参数写错；按依赖缺失
        // 上报，让调用方看到 remedy 而不是误以为可以重试。
        SidePolicyError::Unsupported { .. } => AppCommandError::dependency_missing(message),
        SidePolicyError::InvalidSession { .. } => AppCommandError::invalid_input(message),
    }
}

async fn plan_launch(
    agent: AgentType,
    session_id: &str,
    pi_session_file: Option<&str>,
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<LaunchPlan, AppCommandError> {
    let side = side_agent(agent)?;
    let platform = current_platform();

    // Codex 的只读保证依赖"完整 MCP 清单"：清单要在 resume 的同一 cwd/env 下
    // 读到，拿不到就拒绝，而不是假装服务器列表为空。
    let (launch, codex_entry) = if side == SideAgent::Codex {
        let entry = codex_entry(env).await?;
        let servers = codex_mcp_inventory(&entry, env, cwd).await?;
        let launch = native_side_policy::launch(side, session_id, platform, Some(servers.as_slice()))
            .map_err(policy_error)?;
        (launch, Some(entry))
    } else {
        (
            native_side_policy::launch(side, session_id, platform, None)
                .map_err(policy_error)?,
            None,
        )
    };

    // Pi 的 branch 可能落在带空格的 session 文件路径里。只替换策略给出的
    // `--session` 值，工具白名单等只读参数保持原样；PTY 用 argv 数组传参，
    // 空格不会被 shell 拆开。
    let mut args = match (side, pi_session_file) {
        (SideAgent::Pi, Some(raw)) => {
            with_pi_session_arg(launch.args, &validated_pi_session_file(raw, session_id)?)?
        }
        _ => launch.args,
    };
    // Codex 0.166+ 的 resume 默认交给常驻 daemon；旁问 PTY 必须自己持有进程、
    // 关掉后不留下后台会话，所以显式禁用 daemon（与主线原生终端一致）。
    if side == SideAgent::Codex {
        args = with_codex_no_daemon(args);
    }

    let files = if side == SideAgent::DeepSeek {
        let files = dsh_readonly_files()?;
        let patch = args
            .iter_mut()
            .find(|value| value.as_str() == native_side_policy::DSH_READONLY_PATCH_ARGUMENT)
            .ok_or_else(|| AppCommandError::configuration_invalid("DSH read-only policy is missing"))?;
        *patch = files[1].to_string_lossy().into_owned();
        files
    } else {
        Vec::new()
    };
    let entry = match codex_entry {
        Some(entry) => entry,
        None => resolve_entry(agent, env, cwd).await?,
    };
    let entry = ensure_launchable(agent, &args, entry).await?;
    let (program, args) = entry.command(&args);
    let mut env = env.clone();
    crate::native_session_main::configure_dsh_tui_resume(agent, session_id, &mut env);

    Ok(LaunchPlan {
        program,
        args,
        env,
        files,
    })
}

fn dsh_readonly_files() -> Result<Vec<tempfile::TempPath>, AppCommandError> {
    let mut guard = tempfile::Builder::new()
        .prefix("codeg-dsh-readonly-")
        .suffix(".mjs")
        .tempfile()
        .map_err(AppCommandError::io)?;
    guard
        .write_all(include_bytes!("side_question/dsh-readonly.mjs"))
        .map_err(AppCommandError::io)?;
    guard.flush().map_err(AppCommandError::io)?;
    let guard = guard.into_temp_path();
    let guard_url = url::Url::from_file_path(&guard)
        .map_err(|_| AppCommandError::configuration_invalid("Invalid DSH guard path"))?;
    let overlay = serde_json::json!([
        {"insert": [{
            "id": "codeg-side-readonly",
            "name": guard_url.as_str()
        }]},
        // 缺少 guard 或插件加载失败时 TUI 不得启动，否则会回落到 Windows 全权限。
        {"id": "dsh-tui", "inject": [
            "codegSideReadonly", "workspaceRegistry", "agents", "tuiWorkspaces",
            "tuiScenes", "tuiPanels", "tuiDialogs", "tuiStatus", "tuiShortcuts",
            "tuiRenderers", "tuiThemes"
        ]},
        {"id": "hmr", "disabled": true}
    ]);
    let mut patch = tempfile::Builder::new()
        .prefix("codeg-dsh-readonly-")
        .suffix(".json")
        .tempfile()
        .map_err(AppCommandError::io)?;
    serde_json::to_writer(&mut patch, &overlay)
        .map_err(|error| AppCommandError::configuration_invalid(error.to_string()))?;
    patch.flush().map_err(AppCommandError::io)?;
    Ok(vec![guard, patch.into_temp_path()])
}

/// 每个 agent 真正可执行的入口。Codex 不走这里（它需要先读 MCP 清单）。
async fn resolve_entry(
    agent: AgentType,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<CliEntry, AppCommandError> {
    match agent {
        AgentType::ClaudeCode => {
            // 优先厂商自己的 `claude` CLI；npm 全局副本只作为回退。
            let program = match resolve_system_agent_binary_for(agent, "claude") {
                Some(path) => path,
                None => resolve_npx_command_for(agent, "claude").await.ok_or_else(|| {
                    AppCommandError::dependency_missing(
                        "The Claude Code CLI is not installed; side questions need the `claude` command",
                    )
                })?,
            };
            entry_from_path(program, "Claude Code CLI")
        }
        AgentType::Pi => pi_entry(env, cwd).await,
        AgentType::DeepSeek => {
            let program = match resolve_system_agent_binary_for(agent, "dsh") {
                Some(path) => Some(path),
                None => resolve_npx_command_for(agent, "dsh").await,
            }
            .ok_or_else(|| {
                AppCommandError::dependency_missing(
                    "The DSH CLI is not installed; side questions need the `dsh` command",
                )
            })?;
            entry_from_path(program, "DSH CLI")
        }
        other => Err(AppCommandError::invalid_input(format!(
            "Agent {} has no read-only side terminal",
            other.as_wire()
        ))),
    }
}

/// Codex 入口：设置里的 `CODEX_PATH` 优先，其次才是已确认的 `codex.js`。
/// 两者都不存在时拒绝借用 PATH 上来源不明的 `codex`，避免旁问跑在另一个
/// 运行时上。
async fn codex_entry(env: &BTreeMap<String, String>) -> Result<CliEntry, AppCommandError> {
    let configured = configured_codex_path(env);
    // `.cmd/.bat/.ps1` 装不下 `-c mcp_servers={ "x" = { enabled = false } }`
    // 这种带空格和引号的参数。此时同一份安装只有 JS 入口能跑通，改由 node 执行。
    if configured.as_deref().is_some_and(is_script_shim) {
        return codex_js_entry().await;
    }
    if let Some(path) = configured {
        return entry_from_path(path, "Codex CLI");
    }
    codex_js_entry().await
}

fn configured_codex_path(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    env.get("CODEX_PATH")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("CODEX_PATH")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
}

/// 已确认的 Codex JS 入口：优先 codex-acp 自带的那份（与主线 ACP 是同一个
/// 运行时），其次 npm 全局 `@openai/codex`。都没有就 fail closed。
async fn codex_js_entry() -> Result<CliEntry, AppCommandError> {
    if let Some(js) = verified_codex_js().await {
        return node_entry(&js);
    }
    if let Some(js) = codex_npm_js().await {
        return node_entry(&js);
    }
    Err(AppCommandError::dependency_missing(
        "The Codex CLI entry could not be verified; install or repair the Codex adapter, or point CODEX_PATH at a codex executable",
    ))
}

async fn verified_codex_js() -> Option<PathBuf> {
    let runtime = crate::acp::codex_runtime::current().await;
    if !runtime.confirmed {
        return None;
    }
    runtime.codex_js.filter(|path| path.is_file())
}

async fn codex_npm_js() -> Option<PathBuf> {
    let prefix = cached_npm_global_prefix().await?;
    let js = npm_package_dir(&prefix, "@openai/codex")
        .join("bin")
        .join("codex.js");
    js.is_file().then_some(js)
}

/// 读取 Codex 的完整 MCP 清单。
///
/// 命令结果可能包含服务器配置，因此失败时只带退出码，不把 stdout/stderr 写进
/// 错误或日志。
async fn codex_mcp_inventory(
    entry: &CliEntry,
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Vec<String>, AppCommandError> {
    let (program, prefix) = entry.command(&[]);
    let mut command = crate::process::tokio_command(&program);
    command.args(&prefix);
    command.args(["mcp", "list", "--json"]);
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in env {
        command.env(key, value);
    }

    let output = tokio::time::timeout(
        crate::acp::codex_runtime::CODEX_SUBPROCESS_TIMEOUT,
        command.output(),
    )
    .await
    .map_err(|_| {
        AppCommandError::task_execution_failed(
            "Timed out while reading the Codex MCP inventory",
        )
    })?
    .map_err(|error| {
        AppCommandError::task_execution_failed("Could not run the Codex MCP inventory command")
            .with_detail(error.to_string())
    })?;

    if !output.status.success() {
        let status = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        return Err(AppCommandError::task_execution_failed(format!(
            "The Codex MCP inventory command failed (status {status})"
        )));
    }
    if output.stdout.len() > MAX_INVENTORY_BYTES {
        return Err(AppCommandError::task_execution_failed(
            "The Codex MCP inventory is unexpectedly large",
        ));
    }
    parse_codex_mcp_inventory(&output.stdout)
}

fn parse_codex_mcp_inventory(stdout: &[u8]) -> Result<Vec<String>, AppCommandError> {
    let value: Value = serde_json::from_slice(stdout).map_err(|_| {
        AppCommandError::task_execution_failed(
            "The Codex MCP inventory is not valid JSON; refusing to guess which servers are enabled",
        )
    })?;
    let entries = value.as_array().ok_or_else(|| {
        AppCommandError::task_execution_failed(
            "The Codex MCP inventory is not a JSON array; refusing to guess which servers are enabled",
        )
    })?;
    let mut names = Vec::with_capacity(entries.len());
    for entry in entries {
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                AppCommandError::task_execution_failed(
                    "The Codex MCP inventory has an entry without a usable name",
                )
            })?;
        // 已禁用的服务器也一并交给策略：重复禁用没有副作用，漏掉才会破坏只读。
        names.push(name.to_string());
    }
    Ok(names)
}

async fn pi_entry(
    env: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<CliEntry, AppCommandError> {
    let configured = env
        .get("PI_ACP_PI_COMMAND")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            std::env::var("PI_ACP_PI_COMMAND")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });

    match resolve_pi_command_in(&pi_command_for_env(env), env, cwd) {
        Some(path) => entry_from_path(path, "Pi CLI"),
        // 配置了自定义命令却解析不到，说明那份安装已经坏了；退回别的 pi 会让
        // 旁问跑到和主会话不同的运行时。
        None if configured.is_some() => Err(AppCommandError::dependency_missing(
            "The configured Pi CLI (PI_ACP_PI_COMMAND) cannot be found",
        )),
        None => pi_npm_entry().await,
    }
}

/// npm 全局安装的 Pi JS 入口；WSH shim 装不下复杂 argv 时的回退。
async fn pi_npm_entry() -> Result<CliEntry, AppCommandError> {
    let prefix = cached_npm_global_prefix().await.ok_or_else(|| {
        AppCommandError::dependency_missing(
            "The npm global prefix is unavailable; Pi needs a Node entry point",
        )
    })?;
    let package = npm_package_dir(&prefix, "@earendil-works/pi-coding-agent");
    let cli = package.join("dist").join("bundle").join("cli.js");
    if !cli.is_file() {
        return Err(AppCommandError::dependency_missing(
            "The Pi npm package is not installed; install @earendil-works/pi-coding-agent",
        ));
    }
    node_entry(&cli)
}

/// npm 全局包的落地目录：Windows 直接在 prefix 下，Unix 在 `lib/node_modules`。
fn npm_package_dir(prefix: &Path, package: &str) -> PathBuf {
    if cfg!(windows) {
        prefix.join("node_modules").join(package)
    } else {
        prefix.join("lib").join("node_modules").join(package)
    }
}

fn entry_from_path(path: PathBuf, label: &str) -> Result<CliEntry, AppCommandError> {
    if !path.is_file() {
        return Err(AppCommandError::dependency_missing(format!(
            "{label} was not found at the configured path"
        )));
    }
    if is_js_script(&path) {
        return node_entry(&path);
    }
    let program = path.to_str().ok_or_else(|| {
        AppCommandError::configuration_invalid(format!("{label} path is not valid UTF-8"))
    })?;
    Ok(CliEntry {
        program: program.to_string(),
        prefix: Vec::new(),
    })
}

fn node_entry(script: &Path) -> Result<CliEntry, AppCommandError> {
    let node = which::which("node").map_err(|_| {
        AppCommandError::dependency_missing(
            "Node.js is required to start this agent's JavaScript CLI entry",
        )
    })?;
    let program = node.to_str().ok_or_else(|| {
        AppCommandError::configuration_invalid("The Node.js path is not valid UTF-8")
    })?;
    let script = script.to_str().ok_or_else(|| {
        AppCommandError::configuration_invalid("The agent CLI path is not valid UTF-8")
    })?;
    Ok(CliEntry {
        program: program.to_string(),
        prefix: vec![script.to_string()],
    })
}

fn is_js_script(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            ext.eq_ignore_ascii_case("js")
                || ext.eq_ignore_ascii_case("mjs")
                || ext.eq_ignore_ascii_case("cjs")
        })
}

fn is_batch_shim(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// 需要经过别的解释器才能启动的 shim。PowerShell 脚本会被 terminal manager
/// 直接拒绝（启动脚本会重写 argv），因此 Codex 遇到它们同样要走 JS 入口。
fn is_script_shim(path: &Path) -> bool {
    is_batch_shim(path)
        || path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("ps1"))
}

/// 用 terminal manager 的真实 argv 校验器做前置检查。
///
/// `.cmd/.bat` 对参数有字符限制；Pi 的 session 路径可能带空格，这时同包的
/// JS 入口是唯一可靠的方式，而不是把路径拼成 shell 字符串。
async fn ensure_launchable(
    agent: AgentType,
    args: &[String],
    entry: CliEntry,
) -> Result<CliEntry, AppCommandError> {
    let (program, full) = entry.command(args);
    match crate::terminal::manager::resolve_argv(&program, &full) {
        Ok(_) => Ok(entry),
        Err(TerminalError::SpawnFailed(detail)) => {
            if agent == AgentType::Pi && is_batch_shim(Path::new(&program)) {
                let fallback = pi_npm_entry().await?;
                let (program, args) = fallback.command(args);
                crate::terminal::manager::resolve_argv(&program, &args)
                    .map(|_| fallback)
                    .map_err(|_| {
                        AppCommandError::dependency_missing(
                            "The Pi CLI cannot carry the side-question arguments; install the npm package so it runs through Node",
                        )
                    })
            } else {
                Err(AppCommandError::configuration_invalid(
                    "The side-question CLI cannot be started with its read-only arguments",
                )
                .with_detail(detail))
            }
        }
        Err(error) => Err(AppCommandError::configuration_invalid(error.to_string())),
    }
}

fn with_pi_session_arg(
    mut args: Vec<String>,
    session_file: &Path,
) -> Result<Vec<String>, AppCommandError> {
    let position = args
        .iter()
        .position(|arg| arg == "--session")
        .ok_or_else(|| {
            AppCommandError::configuration_invalid(
                "The Pi launch policy no longer carries a --session argument",
            )
        })?;
    let value = position + 1;
    if value >= args.len() {
        return Err(AppCommandError::configuration_invalid(
            "The Pi launch policy has --session without a value",
        ));
    }
    args[value] = session_file.to_string_lossy().into_owned();
    Ok(args)
}

/// 把 `--no-daemon` 放在 `resume` 之前，保持 Codex 的全局参数顺序；策略更新
/// 后自己带上这个开关时不再重复插入。
fn with_codex_no_daemon(mut args: Vec<String>) -> Vec<String> {
    if args.iter().any(|arg| arg == "--no-daemon") {
        return args;
    }
    let at = args.iter().position(|arg| arg == "resume").unwrap_or(0);
    args.insert(at, "--no-daemon".to_string());
    args
}

fn validated_pi_session_file(
    raw: &str,
    session_id: &str,
) -> Result<PathBuf, AppCommandError> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(AppCommandError::invalid_input(
            "The recorded Pi session file path is not absolute",
        ));
    }
    // 让 Pi 按一个不存在的路径启动会变成另一条会话，必须先拒绝。
    if !path.is_file() {
        return Err(AppCommandError::invalid_input(
            "The recorded Pi session file is unavailable",
        ));
    }
    if !pi_session_file_matches(&path, session_id) {
        return Err(AppCommandError::invalid_input(
            "The recorded Pi session file belongs to another session",
        ));
    }
    Ok(path)
}

fn pi_session_file_matches(path: &Path, session_id: &str) -> bool {
    if pi_file_id(path).as_deref() == Some(session_id) {
        return true;
    }
    // Pi 会先写文件再补 header，两个身份来源有一个对上即可。
    pi_header_id(path).as_deref() == Some(session_id)
}

fn pi_file_id(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let id = stem.split_once('_').map(|(_, id)| id).unwrap_or(stem);
    (!id.is_empty()).then(|| id.to_string())
}

fn pi_header_id(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut bytes = 0usize;
    for _ in 0..MAX_PI_HEADER_LINES {
        line.clear();
        let read = reader.read_line(&mut line).ok()?;
        if read == 0 {
            return None;
        }
        bytes += read;
        if bytes > MAX_PI_HEADER_BYTES {
            return None;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            let id = value.get("id").and_then(Value::as_str)?.trim();
            return (!id.is_empty()).then(|| id.to_string());
        }
    }
    None
}

/// 复用已经在跑的终端；owner 不一致或无法证明归属时拒绝，避免误杀或误共享
/// 别的窗口的终端。
fn reuse_running(
    terminals: &TerminalManager,
    terminal_id: &str,
    owner: &str,
) -> Result<Option<String>, AppCommandError> {
    if !terminals.snapshot(terminal_id).alive {
        return Ok(None);
    }
    match terminals.owner_window_label_of(terminal_id) {
        Some(label) if label == owner => Ok(Some(terminal_id.to_string())),
        Some(label) => Err(AppCommandError::permission_denied(format!(
            "Terminal {terminal_id} belongs to window {label}, not {owner}"
        ))),
        None => Err(AppCommandError::permission_denied(format!(
            "Terminal {terminal_id} is already running, but its owner cannot be verified"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROW_ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    fn model(
        agent: &str,
        source: &str,
        native: &str,
        cwd: &str,
    ) -> side_question_session::Model {
        let now = chrono::Utc::now();
        side_question_session::Model {
            id: ROW_ID.to_string(),
            source_agent_type: agent.to_string(),
            source_session_id: source.to_string(),
            native_session_id: native.to_string(),
            cwd: cwd.to_string(),
            pi_session_file: None,
            title: "side question".to_string(),
            is_open: true,
            created_at: now,
            updated_at: now,
        }
    }

    fn cwd() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().to_string_lossy().into_owned();
        (dir, path)
    }

    fn pi_args() -> Vec<String> {
        [
            "--tools",
            "read,grep,find,ls",
            "--no-extensions",
            "--no-mcp",
            "--session",
            "branch-id",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    }

    #[test]
    fn terminal_id_is_canonical_and_derived_from_the_row() {
        let id = side_terminal_id("0F8FAD5B-D9CB-469F-A165-70867728950E").expect("valid uuid");
        assert_eq!(id, format!("native-side-{ROW_ID}"));
    }

    #[test]
    fn terminal_id_rejects_non_uuid_rows() {
        assert!(side_terminal_id("not-a-row-id").is_err());
        assert!(side_terminal_id("   ").is_err());
    }

    #[test]
    fn every_native_agent_maps_to_its_policy_agent() {
        assert_eq!(side_agent(AgentType::Codex).unwrap(), SideAgent::Codex);
        assert_eq!(
            side_agent(AgentType::ClaudeCode).unwrap(),
            SideAgent::ClaudeCode
        );
        assert_eq!(side_agent(AgentType::Pi).unwrap(), SideAgent::Pi);
        assert_eq!(
            side_agent(AgentType::DeepSeek).unwrap(),
            SideAgent::DeepSeek
        );
        // 没有原生终端的 agent 必须 fail closed。
        assert!(side_agent(AgentType::Gemini).is_err());
    }

    #[test]
    fn validation_requires_an_absolute_existing_directory() {
        let (_dir, cwd) = cwd();
        assert!(validate_row(&model("codex", "source", "branch", &cwd)).is_ok());
        assert!(validate_row(&model("codex", "source", "branch", "relative/dir")).is_err());
        assert!(validate_row(&model("codex", "source", "branch", &format!("{cwd}-missing")))
            .is_err());
    }

    #[test]
    fn validation_rejects_empty_and_main_line_sessions() {
        let (_dir, cwd) = cwd();
        assert!(validate_row(&model("codex", "source", "", &cwd)).is_err());
        assert!(validate_row(&model("codex", "same", "same", &cwd)).is_err());
    }

    #[test]
    fn validation_rejects_agents_without_a_native_terminal() {
        let (_dir, cwd) = cwd();
        assert!(validate_row(&model("gemini", "source", "branch", &cwd)).is_err());
        assert!(validate_row(&model("", "source", "branch", &cwd)).is_err());
    }

    #[test]
    fn codex_inventory_parses_names_and_fails_closed_on_garbage() {
        assert_eq!(
            parse_codex_mcp_inventory(br#"[]"#).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            parse_codex_mcp_inventory(
                br#"[{"name":"demo","enabled":true},{"name":"files","enabled":false}]"#
            )
            .unwrap(),
            vec!["demo".to_string(), "files".to_string()]
        );
        assert!(parse_codex_mcp_inventory(b"not json").is_err());
        assert!(parse_codex_mcp_inventory(br#"[{"enabled":true}]"#).is_err());
        assert!(parse_codex_mcp_inventory(br#"{"name":"x"}"#).is_err());
    }

    #[test]
    fn pi_session_argument_replaces_only_the_session_value() {
        let replaced =
            with_pi_session_arg(pi_args(), Path::new("F:\\tmp\\pi session branch.jsonl"))
                .expect("policy argv carries --session");
        assert_eq!(replaced[4], "--session");
        assert_eq!(replaced[5], "F:\\tmp\\pi session branch.jsonl");
        assert_eq!(replaced.len(), 6);
        assert_eq!(replaced[1], "read,grep,find,ls");
    }

    #[test]
    fn pi_session_argument_requires_the_policy_flag() {
        assert!(with_pi_session_arg(vec!["--no-mcp".to_string()], Path::new("x")).is_err());
        assert!(with_pi_session_arg(vec!["--session".to_string()], Path::new("x")).is_err());
    }

    #[test]
    fn pi_session_file_identity_follows_the_file_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("2026-11-21_branch-id.jsonl");
        std::fs::write(&path, "{\"type\":\"session\",\"id\":\"branch-id\"}\n").unwrap();
        let raw = path.to_str().unwrap();
        assert!(validated_pi_session_file(raw, "branch-id").is_ok());
        assert!(validated_pi_session_file(raw, "other").is_err());
    }

    #[test]
    fn pi_session_file_header_is_the_fallback_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"message\"}\n{\"type\":\"session\",\"id\":\"branch-id\"}\n",
        )
        .unwrap();
        assert!(validated_pi_session_file(path.to_str().unwrap(), "branch-id").is_ok());
        assert!(validated_pi_session_file(path.to_str().unwrap(), "other").is_err());
    }

    #[test]
    fn pi_session_file_must_be_absolute_and_present() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("2026-11-21_branch-id.jsonl");
        assert!(validated_pi_session_file("relative.jsonl", "branch-id").is_err());
        assert!(validated_pi_session_file(missing.to_str().unwrap(), "branch-id").is_err());
    }

    #[test]
    fn entry_kinds_are_detected_case_insensitively() {
        assert!(is_js_script(Path::new("cli.js")));
        assert!(is_js_script(Path::new("cli.MJS")));
        assert!(!is_js_script(Path::new("codex.exe")));
        assert!(is_batch_shim(Path::new("claude.CMD")));
        assert!(!is_batch_shim(Path::new("claude.exe")));
        assert!(is_script_shim(Path::new("codex.ps1")));
        assert!(!is_script_shim(Path::new("codex.exe")));
    }

    #[test]
    fn codex_disables_the_daemon_before_resume_exactly_once() {
        let args = ["-s", "read-only", "resume", "branch-id"]
            .into_iter()
            .map(str::to_string)
            .collect();
        let once = with_codex_no_daemon(args);
        assert_eq!(
            once,
            ["-s", "read-only", "--no-daemon", "resume", "branch-id"]
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>()
        );
        assert_eq!(with_codex_no_daemon(once.clone()), once);
    }

    #[test]
    fn npm_packages_live_where_npm_puts_them() {
        let prefix = Path::new("prefix");
        let package = npm_package_dir(prefix, "@earendil-works/pi-coding-agent");
        #[cfg(windows)]
        assert_eq!(
            package,
            prefix
                .join("node_modules")
                .join("@earendil-works/pi-coding-agent")
        );
        #[cfg(not(windows))]
        assert_eq!(
            package,
            prefix
                .join("lib")
                .join("node_modules")
                .join("@earendil-works/pi-coding-agent")
        );
    }
}
