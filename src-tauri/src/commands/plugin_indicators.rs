use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::db::service::agent_setting_service;
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::parsers::AgentEnv;

#[cfg(feature = "tauri-runtime")]
use crate::acp::error::AcpError;
#[cfg(feature = "tauri-runtime")]
use tauri::State;

const ADHD_ID: &str = "i-have-adhd";
const ADHD_PLUGIN_KEY: &str = "i-have-adhd@i-have-adhd";
const PONYTAIL_ID: &str = "ponytail";
const PONYTAIL_PLUGIN_KEY: &str = "ponytail@ponytail";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginIndicator {
    pub id: String,
    pub enabled: Option<bool>,
    pub state: String,
    pub source: String,
    pub scope: String,
}

#[derive(Clone, Copy)]
enum PluginKind {
    Adhd,
    Ponytail,
}

impl PluginKind {
    fn id(self) -> &'static str {
        match self {
            Self::Adhd => ADHD_ID,
            Self::Ponytail => PONYTAIL_ID,
        }
    }

    fn qualified_id(self) -> &'static str {
        match self {
            Self::Adhd => ADHD_PLUGIN_KEY,
            Self::Ponytail => PONYTAIL_PLUGIN_KEY,
        }
    }

    fn codex_cache_path(self, home: &Path) -> PathBuf {
        match self {
            Self::Adhd => home.join("plugins/cache/i-have-adhd/i-have-adhd"),
            Self::Ponytail => home.join("plugins/cache/ponytail/ponytail"),
        }
    }

    fn codex_data_path(self, home: &Path) -> PathBuf {
        home.join(format!("plugins/data/{}-{}", self.id(), self.id()))
    }
}

/// 只展示存在安装清单的插件，避免移除插件后残留的启用配置制造误报。
pub async fn list_agent_plugin_indicators_core(
    agent_type: AgentType,
    workspace_path: Option<String>,
    db: &AppDatabase,
) -> Vec<AgentPluginIndicator> {
    if !matches!(agent_type, AgentType::ClaudeCode | AgentType::Codex) {
        return Vec::new();
    }

    let env = agent_setting_service::load_agent_env(&db.conn, agent_type).await;
    match agent_type {
        AgentType::ClaudeCode => claude_indicators(&env, workspace_path.as_deref()),
        AgentType::Codex => codex_indicators(&env),
        _ => Vec::new(),
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_list_agent_plugin_indicators(
    agent_type: AgentType,
    workspace_path: Option<String>,
    db: State<'_, AppDatabase>,
) -> Result<Vec<AgentPluginIndicator>, AcpError> {
    // 异步命令借用 State 时必须返回 Result，Tauri 才能正确管理命令 Future 的生命周期。
    Ok(list_agent_plugin_indicators_core(agent_type, workspace_path, &db).await)
}

fn claude_indicators(env: &AgentEnv, workspace_path: Option<&str>) -> Vec<AgentPluginIndicator> {
    let home = crate::parsers::claude::resolve_claude_config_dir_for_env(env);
    let index = read_json(&home.join("plugins/installed_plugins.json"));
    let settings = read_json(&home.join("settings.json"));
    let mut indicators = Vec::new();

    for kind in [PluginKind::Adhd, PluginKind::Ponytail] {
        if claude_install_path(index.as_ref(), kind).is_none() {
            continue;
        }

        let enabled = settings.as_ref().map(|settings| {
            settings
                .get("enabledPlugins")
                .and_then(|plugins| plugins.get(kind.qualified_id()))
                .and_then(Value::as_bool)
                .unwrap_or(true)
        });

        indicators.push(match kind {
            PluginKind::Adhd => claude_adhd_indicator(&home, enabled),
            PluginKind::Ponytail => claude_ponytail_indicator(&home, workspace_path, enabled),
        });
    }

    indicators
}

fn claude_install_path(index: Option<&Value>, kind: PluginKind) -> Option<PathBuf> {
    index?
        .get("plugins")?
        .get(kind.qualified_id())?
        .as_array()?
        .iter()
        .filter_map(|install| install.get("installPath")?.as_str().map(PathBuf::from))
        .find(|install_path| install_path.is_dir())
}

fn claude_adhd_indicator(home: &Path, enabled: Option<bool>) -> AgentPluginIndicator {
    adhd_indicator(home.join(".i-have-adhd-always").is_file(), enabled)
}

fn adhd_indicator(always_on: bool, enabled: Option<bool>) -> AgentPluginIndicator {
    // 常开标记只能证明启动配置；当前会话仍可手动关闭。
    let disabled = enabled == Some(false);
    AgentPluginIndicator {
        id: ADHD_ID.to_string(),
        enabled,
        state: if disabled {
            "unknown"
        } else if always_on {
            "always_on_configured"
        } else {
            "unknown"
        }
        .to_string(),
        source: if disabled {
            "plugin_disabled".to_string()
        } else if always_on {
            "always_on_config".to_string()
        } else {
            "session_state_unobservable".to_string()
        },
        scope: if always_on {
            "user".to_string()
        } else {
            "session".to_string()
        },
    }
}

fn claude_ponytail_indicator(
    home: &Path,
    workspace_path: Option<&str>,
    enabled: Option<bool>,
) -> AgentPluginIndicator {
    let project_path = workspace_path
        .filter(|path| !path.trim().is_empty())
        .map(|path| ponytail_project_state_path(home, path));
    let project_scoped = project_path.is_some();
    let state_path = project_path.unwrap_or_else(|| home.join(".ponytail-active"));
    // 同一项目的 Ponytail 会话共用此标记；它不能证明当前 CLI 进程已成功加载 hook。
    let state = if enabled == Some(false) {
        "unknown".to_string()
    } else {
        read_mode(&state_path).unwrap_or_else(|| "unknown".to_string())
    };

    AgentPluginIndicator {
        id: PONYTAIL_ID.to_string(),
        enabled,
        state,
        source: if enabled == Some(false) {
            "plugin_disabled".to_string()
        } else if project_scoped {
            "project_mode_marker".to_string()
        } else {
            "shared_mode_marker".to_string()
        },
        scope: if project_scoped {
            "project_shared".to_string()
        } else {
            "user_shared".to_string()
        },
    }
}

fn ponytail_project_state_path(home: &Path, workspace_path: &str) -> PathBuf {
    let normalized = Path::new(workspace_path)
        .components()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned();
    let digest = Sha256::digest(normalized.as_bytes());
    let hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    home.join("ponytail-modes").join(hash)
}

fn codex_indicators(env: &AgentEnv) -> Vec<AgentPluginIndicator> {
    let home = crate::parsers::codex::resolve_codex_home_dir_for_env(env);
    let config = read_toml_document(&home.join("config.toml"));
    let mut indicators = Vec::new();

    for kind in [PluginKind::Adhd, PluginKind::Ponytail] {
        if !codex_plugin_is_installed(kind, &home) {
            continue;
        }

        let enabled = config
            .as_ref()
            .and_then(|document| document.get("plugins"))
            .and_then(|plugins| plugins.get(kind.qualified_id()))
            .and_then(|plugin| plugin.get("enabled"))
            .and_then(|value| value.as_bool());

        indicators.push(match kind {
            PluginKind::Adhd => adhd_indicator(codex_adhd_always_on(&home), enabled),
            PluginKind::Ponytail => {
                let state = if enabled == Some(false) {
                    "unknown".to_string()
                } else {
                    read_mode(&kind.codex_data_path(&home).join(".ponytail-active"))
                        .unwrap_or_else(|| "unknown".to_string())
                };
                AgentPluginIndicator {
                    id: PONYTAIL_ID.to_string(),
                    enabled,
                    state,
                    source: if enabled == Some(false) {
                        "plugin_disabled".to_string()
                    } else {
                        "shared_mode_marker".to_string()
                    },
                    scope: "user_shared".to_string(),
                }
            }
        });
    }

    indicators
}

fn codex_adhd_always_on(home: &Path) -> bool {
    // 跟随 Codex 的全局规则优先级；覆盖文件有内容时不能再使用被覆盖的常开设置。
    let Some(instructions) = ["AGENTS.override.md", "AGENTS.md"]
        .iter()
        .filter_map(|name| fs::read_to_string(home.join(name)).ok())
        .find(|text| !text.trim().is_empty())
    else {
        return false;
    };

    // 只识别独立维护的完整常开段，避免把历史记忆里提到插件误报为已配置。
    instructions
        .split_once("<!-- i-have-adhd:begin")
        .and_then(|(_, rest)| rest.split_once("-->"))
        .and_then(|(_, rest)| rest.split_once("<!-- i-have-adhd:end -->"))
        .is_some_and(|(body, _)| !body.trim().is_empty())
}

fn codex_plugin_is_installed(kind: PluginKind, home: &Path) -> bool {
    let cache = kind.codex_cache_path(home);
    let Ok(versions) = fs::read_dir(cache) else {
        return false;
    };

    versions.flatten().any(|entry| {
        let version = entry.path();
        version.is_dir() && version.join(".codex-plugin/plugin.json").is_file()
    })
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn read_toml_document(path: &Path) -> Option<toml_edit::Document> {
    let text = fs::read_to_string(path).ok()?;
    toml_edit::Document::from_str(&text).ok()
}

fn read_mode(path: &Path) -> Option<String> {
    let mode = fs::read_to_string(path).ok()?.trim().to_ascii_lowercase();
    matches!(mode.as_str(), "off" | "lite" | "full" | "ultra").then_some(mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const CODEX_ALWAYS_ON: &str = "<!-- i-have-adhd:begin -->\n\
        Use i-have-adhd by default for every new session.\n\
        <!-- i-have-adhd:end -->";

    fn codex_adhd_fixture(
        instructions: Option<&str>,
        override_instructions: Option<&str>,
        enabled: bool,
    ) -> AgentPluginIndicator {
        let temp = TempDir::new().unwrap();
        let plugin = temp
            .path()
            .join("plugins/cache/i-have-adhd/i-have-adhd/0.4.1/.codex-plugin");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("plugin.json"), "{}").unwrap();
        fs::write(
            temp.path().join("config.toml"),
            format!("[plugins.\"{ADHD_PLUGIN_KEY}\"]\nenabled = {enabled}\n"),
        )
        .unwrap();
        if let Some(content) = instructions {
            fs::write(temp.path().join("AGENTS.md"), content).unwrap();
        }
        if let Some(content) = override_instructions {
            fs::write(temp.path().join("AGENTS.override.md"), content).unwrap();
        }
        let env = AgentEnv::with_overrides(&[("CODEX_HOME", temp.path().to_str().unwrap())]);
        codex_indicators(&env).into_iter().next().unwrap()
    }

    #[test]
    fn codex_adhd_reports_configured_always_on_instructions() {
        let indicator = codex_adhd_fixture(Some(CODEX_ALWAYS_ON), None, true);

        assert_eq!(indicator.state, "always_on_configured");
        assert_eq!(indicator.source, "always_on_config");
        assert_eq!(indicator.scope, "user");
    }

    #[test]
    fn codex_adhd_does_not_infer_always_on_from_installation_or_mentions() {
        for instructions in [
            None,
            Some("Previously installed i-have-adhd."),
            Some("<!-- i-have-adhd:begin -->\nMissing end marker."),
            Some("<!-- i-have-adhd:begin --><!-- i-have-adhd:end -->"),
        ] {
            let indicator = codex_adhd_fixture(instructions, None, true);
            assert_eq!(indicator.state, "unknown");
            assert_eq!(indicator.source, "session_state_unobservable");
            assert_eq!(indicator.scope, "session");
        }
    }

    #[test]
    fn codex_adhd_follows_global_override_precedence() {
        let indicator = codex_adhd_fixture(
            Some(CODEX_ALWAYS_ON),
            Some("Use the normal output style."),
            true,
        );
        assert_eq!(indicator.state, "unknown");

        let indicator = codex_adhd_fixture(None, Some(CODEX_ALWAYS_ON), true);
        assert_eq!(indicator.state, "always_on_configured");

        let indicator = codex_adhd_fixture(Some(CODEX_ALWAYS_ON), Some(" \n"), true);
        assert_eq!(indicator.state, "always_on_configured");
    }

    #[test]
    fn codex_disabled_adhd_does_not_claim_always_on() {
        let indicator = codex_adhd_fixture(Some(CODEX_ALWAYS_ON), None, false);

        assert_eq!(indicator.enabled, Some(false));
        assert_eq!(indicator.state, "unknown");
        assert_eq!(indicator.source, "plugin_disabled");
    }

    #[test]
    fn claude_ponytail_uses_a_project_specific_shared_marker() {
        let temp = TempDir::new().unwrap();
        let workspace = temp.path().join("repo");
        fs::create_dir_all(&workspace).unwrap();
        let state_path = ponytail_project_state_path(temp.path(), workspace.to_str().unwrap());
        fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        fs::write(&state_path, "ultra\n").unwrap();

        let indicator = claude_ponytail_indicator(temp.path(), workspace.to_str(), Some(true));

        assert_eq!(indicator.state, "ultra");
        assert_eq!(indicator.source, "project_mode_marker");
        assert_eq!(indicator.scope, "project_shared");
    }

    #[test]
    fn unreadable_session_modes_remain_unknown() {
        let temp = TempDir::new().unwrap();
        let indicator = claude_ponytail_indicator(temp.path(), Some("/missing"), Some(true));

        assert_eq!(indicator.state, "unknown");
        assert_eq!(indicator.scope, "project_shared");
    }

    #[test]
    fn disabled_plugins_do_not_claim_a_live_ponytail_mode() {
        let temp = TempDir::new().unwrap();
        let state_path = temp.path().join(".ponytail-active");
        fs::write(&state_path, "full").unwrap();

        let indicator = claude_ponytail_indicator(temp.path(), None, Some(false));

        assert_eq!(indicator.state, "unknown");
        assert_eq!(indicator.source, "plugin_disabled");
    }

    #[test]
    fn disabled_adhd_ignores_an_always_on_flag() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join(".i-have-adhd-always"), "").unwrap();

        let indicator = claude_adhd_indicator(temp.path(), Some(false));

        assert_eq!(indicator.state, "unknown");
        assert_eq!(indicator.source, "plugin_disabled");
    }

    #[test]
    fn invalid_mode_files_are_not_reported_as_active() {
        let temp = TempDir::new().unwrap();
        let path = temp.path().join("mode");
        fs::write(&path, "review").unwrap();

        assert_eq!(read_mode(&path), None);
    }

    #[test]
    fn codex_install_detection_requires_the_native_manifest() {
        let temp = TempDir::new().unwrap();
        let plugin = temp.path().join("plugins/cache/ponytail/ponytail/5.0.0");
        fs::create_dir_all(&plugin).unwrap();
        assert!(!codex_plugin_is_installed(
            PluginKind::Ponytail,
            temp.path()
        ));

        fs::create_dir_all(plugin.join(".codex-plugin")).unwrap();
        fs::write(plugin.join(".codex-plugin/plugin.json"), "{}").unwrap();
        assert!(codex_plugin_is_installed(PluginKind::Ponytail, temp.path()));
    }

    #[test]
    fn claude_install_lookup_skips_stale_index_entries() {
        let temp = TempDir::new().unwrap();
        let current = temp.path().join("current");
        fs::create_dir_all(&current).unwrap();
        let stale = temp.path().join("removed");
        let mut plugins = serde_json::Map::new();
        plugins.insert(
            ADHD_PLUGIN_KEY.to_string(),
            serde_json::json!([
                { "installPath": stale.to_string_lossy() },
                { "installPath": current.to_string_lossy() }
            ]),
        );
        let index = serde_json::json!({
            "plugins": plugins
        });

        assert_eq!(
            claude_install_path(Some(&index), PluginKind::Adhd),
            Some(current)
        );
    }
}
