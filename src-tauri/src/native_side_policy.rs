//! 原生终端旁问的只读启动策略。
//!
//! 这里只决定"用哪些参数启动"，不接管进程、不写配置：
//! 返回的 argv 直接交给 terminal manager 的 PTY spawn，环境变量保持父进程原样，
//! 因为恢复真实 session 依赖既有的 `CODEX_HOME` / `CLAUDE_CONFIG_DIR` 等环境。
//!
//! 三条硬约束：
//! - 只恢复调用方给定的原生 session（`resume` / `--resume` / `--session`），
//!   不 fork、不新建、不关闭持久化；
//! - 只读由 CLI 自身的机制保证（Codex 沙箱、Claude/Pi 工具白名单），不靠提示词；
//! - 无法给出可验证保证的 CLI 直接返回 `Unsupported`，绝不降级成"应该不会写"。

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SideAgent {
    Codex,
    ClaudeCode,
    Pi,
    /// DSH（DeepSeek Harness）。
    DeepSeek,
}

impl SideAgent {
    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::ClaudeCode => "Claude Code",
            Self::Pi => "Pi",
            Self::DeepSeek => "DSH",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Unix,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SideLaunch {
    /// 传给原生 CLI 的参数（不含程序名）。
    pub args: Vec<String>,
    /// 给 UI/日志展示的保证说明，避免把"只读"说成比实际更强。
    pub guarantee: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SidePolicyError {
    Unsupported {
        agent: SideAgent,
        reason: &'static str,
        remedy: &'static str,
    },
    InvalidSession {
        reason: &'static str,
    },
}

impl std::fmt::Display for SidePolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported {
                agent,
                reason,
                remedy,
            } => write!(
                f,
                "{} side questions are unavailable: {reason} Remedy: {remedy}",
                agent.label()
            ),
            Self::InvalidSession { reason } => {
                write!(f, "invalid native session id: {reason}")
            }
        }
    }
}

impl std::error::Error for SidePolicyError {}

/// Codex 里能在不破坏 `resume` 的前提下关闭的副作用通道。
/// 名称按 `codex features list` 校验过：拼错会让 Codex 直接报错退出，不是静默忽略。
const CODEX_DISABLED_FEATURES: [&str; 7] = [
    "hooks",
    "plugins",
    "apps",
    "browser_use",
    "multi_agent",
    "multi_agent_v2",
    "skill_mcp_dependency_install",
];

const CODEX_GUARANTEE_WINDOWS: &str = "Codex read-only sandbox (Windows restricted token) \
denies file writes; hooks, plugins, apps, browser automation, sub-agents and the listed MCP \
servers are disabled. Any MCP server missing from the supplied inventory stays enabled.";

const CODEX_GUARANTEE_UNIX: &str = "Codex read-only sandbox (seatbelt/landlock) denies file \
writes; hooks, plugins, apps, browser automation, sub-agents and the listed MCP servers are \
disabled. Any MCP server missing from the supplied inventory stays enabled.";

const CLAUDE_GUARANTEE: &str = "Only Read, Grep and Glob are available; safe mode drops MCP, \
plugins, hooks and settings, restricted mode removes command/code tools and confines file tools \
to the working directory, and plan mode blocks edits.";

const PI_GUARANTEE: &str = "Only read, grep, find and ls are available; extensions, MCP servers, \
skills and prompt templates are disabled.";

pub(crate) const DSH_READONLY_PATCH_ARGUMENT: &str = "__CODEG_DSH_READONLY_PATCH__";

/// 生成一次旁问的只读启动参数。
///
/// `codex_mcp_servers` 是 Codex 的**完整** MCP 清单（`codex mcp list` 在同一 cwd 下的
/// 结果）。Codex 没有"禁用全部 MCP"的开关，`-c mcp_servers={}` 也会被合并掉，所以
/// 拿不到清单时必须返回 `Unsupported`：MCP 是独立进程，沙箱管不到它。
pub fn launch(
    agent: SideAgent,
    session_id: &str,
    platform: Platform,
    codex_mcp_servers: Option<&[String]>,
) -> Result<SideLaunch, SidePolicyError> {
    validate_session(session_id)?;
    match agent {
        SideAgent::Codex => codex_launch(session_id, platform, codex_mcp_servers),
        SideAgent::ClaudeCode => Ok(claude_launch(session_id)),
        SideAgent::Pi => Ok(pi_launch(session_id)),
        SideAgent::DeepSeek => Ok(SideLaunch {
            args: [
                "--profile",
                "dsh-tui",
                "--patch",
                DSH_READONLY_PATCH_ARGUMENT,
                "--",
                "--backend",
                "dsh",
                "--resume",
                session_id,
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            guarantee: "The native final tool guard allows only read, read_image, glob and grep; \
                the terminal requires the guard service before it can start.",
        }),
    }
}

fn validate_session(session_id: &str) -> Result<(), SidePolicyError> {
    if session_id.trim().is_empty() {
        return Err(SidePolicyError::InvalidSession {
            reason: "session id is empty",
        });
    }
    // 以 '-' 开头会被 CLI 当成下一个参数，控制字符/空白则可能破坏 session 查找。
    if session_id.starts_with('-') {
        return Err(SidePolicyError::InvalidSession {
            reason: "session id must not start with '-'",
        });
    }
    if session_id
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(SidePolicyError::InvalidSession {
            reason: "session id contains control or whitespace characters",
        });
    }
    Ok(())
}

fn codex_launch(
    session_id: &str,
    platform: Platform,
    mcp_servers: Option<&[String]>,
) -> Result<SideLaunch, SidePolicyError> {
    let mcp_servers = mcp_servers.ok_or(SidePolicyError::Unsupported {
        agent: SideAgent::Codex,
        reason: "the Codex MCP inventory is unknown, and Codex has no flag that disables all \
                 MCP servers at once",
        remedy: "run `codex mcp list` in the session working directory, disable every server \
                 it reports, and pass the resulting names to this policy",
    })?;

    let mut args: Vec<String> = ["-s", "read-only", "-a", "never"]
        .into_iter()
        .map(str::to_string)
        .collect();
    for feature in CODEX_DISABLED_FEATURES {
        args.push("--disable".to_string());
        args.push(feature.to_string());
    }
    if let Some(override_arg) = codex_mcp_override(mcp_servers)? {
        args.push("-c".to_string());
        args.push(override_arg);
    }
    args.push("resume".to_string());
    args.push(session_id.to_string());

    Ok(SideLaunch {
        args,
        guarantee: match platform {
            Platform::Windows => CODEX_GUARANTEE_WINDOWS,
            Platform::Unix => CODEX_GUARANTEE_UNIX,
        },
    })
}

/// Codex 的 `-c` 按点号切分配置路径，带点的 MCP 名无法用
/// `mcp_servers.a.b.enabled=false` 表达；改用整张内联表覆盖，名称作为 TOML 字符串。
fn codex_mcp_override(servers: &[String]) -> Result<Option<String>, SidePolicyError> {
    if servers.is_empty() {
        return Ok(None);
    }
    let mut names: Vec<&str> = servers.iter().map(String::as_str).collect();
    // 重复键会让内联表解析失败；固定排序让同一组输入产生同一份 argv。
    names.sort_unstable();
    names.dedup();

    let mut entries = Vec::with_capacity(names.len());
    for name in names {
        if name.is_empty() || name.chars().any(char::is_control) {
            return Err(SidePolicyError::Unsupported {
                agent: SideAgent::Codex,
                reason: "a configured MCP server name cannot be encoded as a TOML key",
                remedy: "rename or remove the offending MCP server, then retry the side \
                         question",
            });
        }
        entries.push(format!(
            "\"{}\" = {{ enabled = false }}",
            escape_toml_basic_string(name)
        ));
    }
    Ok(Some(format!("mcp_servers={{ {} }}", entries.join(", "))))
}

fn escape_toml_basic_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn claude_launch(session_id: &str) -> SideLaunch {
    let args = [
        "--safe-mode",
        "--restricted",
        "--strict-mcp-config",
        "--tools",
        "Read,Grep,Glob",
        "--permission-mode",
        "plan",
        "--resume",
        session_id,
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    SideLaunch {
        args,
        guarantee: CLAUDE_GUARANTEE,
    }
}

fn pi_launch(session_id: &str) -> SideLaunch {
    let args = [
        "--tools",
        "read,grep,find,ls",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--session",
        session_id,
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    SideLaunch {
        args,
        guarantee: PI_GUARANTEE,
    }
}

#[cfg(test)]
#[path = "native_side_policy_tests.rs"]
mod tests;
