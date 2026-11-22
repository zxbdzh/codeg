use super::*;

const SESSION: &str = "11111111-2222-4333-8444-555555555555";

fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
    args.windows(2)
        .any(|pair| pair[0] == flag && pair[1] == value)
}

fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter()
        .position(|arg| arg == flag)
        .and_then(|index| args.get(index + 1))
        .map(String::as_str)
}

fn codex(servers: Option<&[String]>) -> Result<SideLaunch, SidePolicyError> {
    launch(SideAgent::Codex, SESSION, Platform::Windows, servers)
}

#[test]
fn codex_denies_writes_and_side_channels() {
    let empty: Vec<String> = Vec::new();
    let plan = codex(Some(&empty)).expect("codex policy should launch");

    assert!(has_pair(&plan.args, "-s", "read-only"));
    assert!(has_pair(&plan.args, "-a", "never"));
    for feature in [
        "hooks",
        "plugins",
        "apps",
        "browser_use",
        "multi_agent",
        "multi_agent_v2",
        "skill_mcp_dependency_install",
    ] {
        assert!(
            has_pair(&plan.args, "--disable", feature),
            "feature {feature} must be disabled"
        );
    }

    // 这些参数都会让旁问获得写权限或额外的可写目录，任何一个出现都说明策略失效。
    for forbidden in [
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
        "--approve-for-me",
        "--add-dir",
        "--worktree",
        "--search",
    ] {
        assert!(
            !plan.args.iter().any(|arg| arg == forbidden),
            "{forbidden} must never be passed"
        );
    }
}

#[test]
fn codex_resumes_the_given_session() {
    let empty: Vec<String> = Vec::new();
    let plan = codex(Some(&empty)).expect("codex policy should launch");

    let resume = plan
        .args
        .iter()
        .position(|arg| arg == "resume")
        .expect("resume subcommand is required");
    assert_eq!(plan.args.get(resume + 1).map(String::as_str), Some(SESSION));
    assert_eq!(plan.args.last().map(String::as_str), Some(SESSION));
}

#[test]
fn codex_disables_every_known_mcp_server_in_one_override() {
    let servers = vec![
        "deepwiki".to_string(),
        "github.com/zcaceres/fetch-mcp".to_string(),
    ];
    let plan = codex(Some(&servers)).expect("codex policy should launch");

    let overrides: Vec<&String> = plan
        .args
        .iter()
        .filter(|arg| arg.starts_with("mcp_servers="))
        .collect();
    assert_eq!(overrides.len(), 1, "MCP servers must be disabled in one -c");
    let override_arg = overrides[0];
    assert!(override_arg.contains("\"deepwiki\" = { enabled = false }"));
    assert!(override_arg.contains("\"github.com/zcaceres/fetch-mcp\" = { enabled = false }"));
    assert_eq!(override_arg.matches("enabled = false").count(), 2);
    assert!(has_pair(&plan.args, "-c", override_arg));
}

#[test]
fn codex_without_mcp_inventory_is_unsupported() {
    let error = codex(None).expect_err("unknown MCP inventory must not be claimed safe");
    match error {
        SidePolicyError::Unsupported {
            agent,
            reason,
            remedy,
        } => {
            assert_eq!(agent, SideAgent::Codex);
            assert!(reason.to_lowercase().contains("mcp"));
            assert!(remedy.contains("codex mcp list"));
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
}

#[test]
fn codex_empty_mcp_inventory_adds_no_override() {
    let empty: Vec<String> = Vec::new();
    let plan = codex(Some(&empty)).expect("codex policy should launch");
    assert!(
        !plan.args.iter().any(|arg| arg.starts_with("mcp_servers=")),
        "an empty inventory needs no override"
    );
}

#[test]
fn codex_mcp_override_is_sorted_deduplicated_and_escaped() {
    let servers = vec![
        "zeta".to_string(),
        "weird\"name\\path".to_string(),
        "alpha".to_string(),
        "zeta".to_string(),
    ];
    let plan = codex(Some(&servers)).expect("codex policy should launch");
    let override_arg = plan
        .args
        .iter()
        .find(|arg| arg.starts_with("mcp_servers="))
        .expect("override argument is required");

    assert_eq!(
        override_arg.matches("enabled = false").count(),
        3,
        "duplicates must collapse"
    );
    assert!(override_arg.contains("\"weird\\\"name\\\\path\" = { enabled = false }"));
    let alpha = override_arg.find("\"alpha\"").expect("alpha present");
    let zeta = override_arg.find("\"zeta\"").expect("zeta present");
    assert!(alpha < zeta, "argument order must be deterministic");
}

#[test]
fn codex_mcp_name_with_control_characters_is_unsupported() {
    let servers = vec!["bad\nname".to_string()];
    let error = codex(Some(&servers)).expect_err("unsafe names cannot be encoded");
    assert!(matches!(
        error,
        SidePolicyError::Unsupported {
            agent: SideAgent::Codex,
            ..
        }
    ));
}

#[test]
fn claude_enables_only_read_only_tools() {
    let plan = launch(SideAgent::ClaudeCode, SESSION, Platform::Unix, None)
        .expect("claude policy should launch");

    assert!(plan.args.iter().any(|arg| arg == "--safe-mode"));
    assert!(plan.args.iter().any(|arg| arg == "--restricted"));
    assert!(plan.args.iter().any(|arg| arg == "--strict-mcp-config"));
    assert!(has_pair(&plan.args, "--permission-mode", "plan"));
    assert!(has_pair(&plan.args, "--resume", SESSION));
    assert_eq!(flag_value(&plan.args, "--tools"), Some("Read,Grep,Glob"));

    let tools = flag_value(&plan.args, "--tools").expect("tools allowlist is required");
    for denied in [
        "Bash",
        "PowerShell",
        "Edit",
        "Write",
        "NotebookEdit",
        "WebFetch",
    ] {
        assert!(
            !tools.split(',').any(|tool| tool == denied),
            "{denied} must not be enabled"
        );
    }
    for forbidden in [
        "--dangerously-skip-permissions",
        "--fork-session",
        "--no-session-persistence",
        "--mcp-config",
        "--bare",
    ] {
        assert!(
            !plan.args.iter().any(|arg| arg == forbidden),
            "{forbidden} must never be passed"
        );
    }
    assert!(!has_pair(
        &plan.args,
        "--permission-mode",
        "bypassPermissions"
    ));
}

#[test]
fn pi_enables_only_read_only_tools() {
    let plan =
        launch(SideAgent::Pi, SESSION, Platform::Windows, None).expect("pi policy should launch");

    assert_eq!(flag_value(&plan.args, "--tools"), Some("read,grep,find,ls"));
    assert!(
        !plan
            .args
            .iter()
            .any(|arg| arg.contains("bash") || arg.contains("powershell")),
        "shell tools must not be enabled"
    );
    for flag in [
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
    ] {
        assert!(
            plan.args.iter().any(|arg| arg == flag),
            "{flag} is required"
        );
    }
    assert!(has_pair(&plan.args, "--session", SESSION));
    assert_eq!(plan.args.last().map(String::as_str), Some(SESSION));
    for forbidden in ["--fork", "--no-session", "--continue", "--resume"] {
        assert!(
            !plan.args.iter().any(|arg| arg == forbidden),
            "{forbidden} would break persistent-session reuse"
        );
    }
}

#[test]
fn dsh_requires_the_native_guard_overlay_before_resuming() {
    let plan = launch(SideAgent::DeepSeek, SESSION, Platform::Windows, None)
        .expect("DSH can run with the final native tool guard");
    assert!(has_pair(&plan.args, "--profile", "dsh-tui"));
    assert!(has_pair(&plan.args, "--patch", "__CODEG_DSH_READONLY_PATCH__"));
    assert!(has_pair(&plan.args, "--backend", "dsh"));
    assert!(has_pair(&plan.args, "--resume", SESSION));
    assert!(plan.guarantee.contains("guard"));
}

#[test]
fn invalid_session_ids_are_rejected_before_any_agent_runs() {
    let empty: Vec<String> = Vec::new();
    for session in ["", "-rf", "a\nb", "a b", "   "] {
        for agent in [
            SideAgent::Codex,
            SideAgent::ClaudeCode,
            SideAgent::Pi,
            SideAgent::DeepSeek,
        ] {
            let result = launch(agent, session, Platform::Unix, Some(&empty));
            assert!(
                matches!(result, Err(SidePolicyError::InvalidSession { .. })),
                "{agent:?} accepted unsafe session id {session:?}"
            );
        }
    }
}

#[test]
fn codex_guarantee_names_the_platform_sandbox() {
    let empty: Vec<String> = Vec::new();
    let windows = launch(SideAgent::Codex, SESSION, Platform::Windows, Some(&empty))
        .expect("codex policy should launch");
    assert!(windows.guarantee.to_lowercase().contains("windows"));

    let unix = launch(SideAgent::Codex, SESSION, Platform::Unix, Some(&empty))
        .expect("codex policy should launch");
    assert!(unix.guarantee.to_lowercase().contains("seatbelt"));
}
