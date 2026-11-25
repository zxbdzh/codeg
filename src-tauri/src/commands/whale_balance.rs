#[cfg(feature = "tauri-runtime")]
use std::sync::Arc;

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::app_error::AppCommandError;
use crate::models::{AgentType, TurnUsage};
use crate::parsers::{codex::CodexParser, AgentParser};
use crate::whale_balance::{
    UpdateWhaleBalanceSettingsInput, WhaleBalanceLedger, WhaleBalancePresentation,
    WhaleBalancePresentationInput, WhaleBalanceReconcileInput, WhaleBalanceService,
    WhaleBalanceSettingsView, WhaleBalanceSnapshot, WhaleBalanceTestResult,
};

pub async fn whale_balance_get_state_core(
    service: &WhaleBalanceService,
) -> Result<WhaleBalanceSnapshot, AppCommandError> {
    service.get_state().await
}

pub async fn whale_balance_refresh_core(
    service: &WhaleBalanceService,
) -> Result<WhaleBalanceSnapshot, AppCommandError> {
    service.refresh_now().await
}

pub async fn whale_balance_get_settings_core(
    service: &WhaleBalanceService,
) -> Result<WhaleBalanceSettingsView, AppCommandError> {
    service.get_settings().await
}

pub async fn whale_balance_update_settings_core(
    service: &WhaleBalanceService,
    settings: UpdateWhaleBalanceSettingsInput,
) -> Result<WhaleBalanceSettingsView, AppCommandError> {
    service.update_settings(settings).await
}

pub async fn whale_balance_test_settings_core(
    service: &WhaleBalanceService,
    settings: UpdateWhaleBalanceSettingsInput,
) -> Result<WhaleBalanceTestResult, AppCommandError> {
    service.test_settings(settings).await
}

pub async fn whale_balance_get_ledger_core(
    service: &WhaleBalanceService,
) -> Result<WhaleBalanceLedger, AppCommandError> {
    service.get_ledger().await
}

pub async fn whale_balance_reconcile_core(
    service: &WhaleBalanceService,
    input: WhaleBalanceReconcileInput,
) -> Result<WhaleBalanceSnapshot, AppCommandError> {
    service.reconcile(input).await
}

pub async fn whale_balance_get_presentation_core(
    service: &WhaleBalanceService,
) -> Result<WhaleBalancePresentation, AppCommandError> {
    service.get_presentation().await
}

pub async fn whale_balance_save_presentation_core(
    service: &WhaleBalanceService,
    input: WhaleBalancePresentationInput,
) -> Result<WhaleBalancePresentation, AppCommandError> {
    service.save_presentation(input).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_balance_get_state(
    service: State<'_, Arc<WhaleBalanceService>>,
) -> Result<WhaleBalanceSnapshot, AppCommandError> {
    whale_balance_get_state_core(&service).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_balance_refresh(
    service: State<'_, Arc<WhaleBalanceService>>,
) -> Result<WhaleBalanceSnapshot, AppCommandError> {
    whale_balance_refresh_core(&service).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_balance_get_settings(
    service: State<'_, Arc<WhaleBalanceService>>,
) -> Result<WhaleBalanceSettingsView, AppCommandError> {
    whale_balance_get_settings_core(&service).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_balance_update_settings(
    service: State<'_, Arc<WhaleBalanceService>>,
    settings: UpdateWhaleBalanceSettingsInput,
) -> Result<WhaleBalanceSettingsView, AppCommandError> {
    whale_balance_update_settings_core(&service, settings).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_balance_test_settings(
    service: State<'_, Arc<WhaleBalanceService>>,
    settings: UpdateWhaleBalanceSettingsInput,
) -> Result<WhaleBalanceTestResult, AppCommandError> {
    whale_balance_test_settings_core(&service, settings).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_balance_get_ledger(
    service: State<'_, Arc<WhaleBalanceService>>,
) -> Result<WhaleBalanceLedger, AppCommandError> {
    whale_balance_get_ledger_core(&service).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_balance_reconcile(
    service: State<'_, Arc<WhaleBalanceService>>,
    input: WhaleBalanceReconcileInput,
) -> Result<WhaleBalanceSnapshot, AppCommandError> {
    whale_balance_reconcile_core(&service, input).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_balance_get_presentation(
    service: State<'_, Arc<WhaleBalanceService>>,
) -> Result<WhaleBalancePresentation, AppCommandError> {
    whale_balance_get_presentation_core(&service).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_balance_save_presentation(
    service: State<'_, Arc<WhaleBalanceService>>,
    input: WhaleBalancePresentationInput,
) -> Result<WhaleBalancePresentation, AppCommandError> {
    whale_balance_save_presentation_core(&service, input).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_widget_get_options(
    service: State<'_, Arc<WhaleBalanceService>>,
) -> Result<serde_json::Value, AppCommandError> {
    service.get_widget_options().await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_widget_save_options(
    service: State<'_, Arc<WhaleBalanceService>>,
    input: serde_json::Value,
) -> Result<serde_json::Value, AppCommandError> {
    service.save_widget_options(input).await
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhaleWidgetCodexUsageInput {
    pub start: Option<chrono::DateTime<chrono::Utc>>,
    pub models: Option<Vec<String>>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhaleWidgetCodexUsageWindow {
    pub label: String,
    pub percent: u32,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhaleWidgetCodexUsage {
    pub tokens: u64,
    pub sessions: u32,
    pub truncated: bool,
    pub windows: Vec<WhaleWidgetCodexUsageWindow>,
}

pub async fn whale_widget_codex_usage_core(
    conn: &sea_orm::DatabaseConnection,
    input: WhaleWidgetCodexUsageInput,
) -> Result<WhaleWidgetCodexUsage, AppCommandError> {
    let env = crate::db::service::agent_setting_service::load_agent_env(conn, AgentType::Codex)
        .await;
    let parser = CodexParser::for_env(&env);
    let detail_parser = CodexParser::for_env(&env);
    let models = input.models.unwrap_or_default();
    let summaries = match tokio::task::spawn_blocking(move || parser.list_conversations()).await {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            tracing::warn!(%error, "whale widget: Codex local usage scan failed");
            Vec::new()
        }
        Err(error) => {
            return Err(AppCommandError::task_execution_failed(format!(
                "Codex usage scan failed: {error}"
            )))
        }
    };

    let mut result = WhaleWidgetCodexUsage::default();
    for summary in &summaries {
        if let Some(start) = input.start {
            if summary.ended_at.is_none_or(|ended| ended < start) {
                continue;
            }
        }
        result.sessions += 1;
        result.truncated = result.sessions >= MAX_CODEX_SESSIONS;
        let detail = match detail_parser.get_conversation(&summary.id) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(session_id = %summary.id, %error, "whale widget: Codex usage parse failed");
                continue;
            }
        };
        let session_tokens = detail
            .session_stats
            .as_ref()
            .and_then(|stats| stats.total_usage.as_ref())
            .map(total_usage_tokens)
            .or_else(|| {
                detail
                    .session_stats
                    .as_ref()
                    .and_then(|stats| stats.total_tokens)
            });
        if let Some(value) = session_tokens {
            if models.is_empty()
                || summary
                    .model
                    .as_deref()
                    .is_some_and(|model| models.iter().any(|filter| model == filter))
            {
                result.tokens += value;
            }
        }
        if result.truncated {
            break;
        }
    }

    result.windows = scan_codex_rate_limits(&detail_parser, &summaries);
    Ok(result)
}

fn scan_codex_rate_limits(
    parser: &CodexParser,
    summaries: &[crate::models::ConversationSummary],
) -> Vec<WhaleWidgetCodexUsageWindow> {
    let now = chrono::Utc::now();
    // Codex 只在最近活动后留下订阅窗口；跳过 6 小时快照，避免显示早已重置的旧限额。
    let rate_limits = summaries
        .iter()
        .take(20)
        .filter(|summary| {
            summary
                .ended_at
                .is_none_or(|ended| ended > now - chrono::Duration::hours(6))
        })
        .find_map(|summary| {
            parser
                .find_current_rollout(&summary.id)
                .and_then(|path| latest_rate_limits(path.as_path(), now))
                .map(|limits| (summary, limits))
        });
    let Some((summary, rate_limits)) = rate_limits else { return Vec::new() };
    let now_ms = now.timestamp_millis();
    let mut windows = Vec::new();
    if let Some(primary) = rate_limits.get("primary") {
        if let Some(window) = codex_usage_window(primary, now_ms) {
            windows.push(window);
        }
    }
    if let Some(secondary) = rate_limits.get("secondary") {
        if let Some(window) = codex_usage_window(secondary, now_ms) {
            windows.push(window);
        }
    }
    if windows.is_empty() {
        return Vec::new();
    }
    tracing::debug!(session_id = %summary.id, "whale widget: Codex rate limits found");
    windows
}

fn latest_rate_limits(
    path: &std::path::Path,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<serde_json::Value> {
    const MAX_SCAN_BYTES: u64 = 2 * 1024 * 1024;
    let metadata = std::fs::metadata(path).ok()?;
    let modified_at: chrono::DateTime<chrono::Utc> = metadata.modified().ok()?.into();
    if metadata.len() > MAX_SCAN_BYTES || modified_at > now {
        return None;
    }
    // 只需要文件尾部的最新快照，避免为 1GB 历史会话重新做完整解析。
    let bytes = std::fs::read(path).ok()?;
    for line in String::from_utf8_lossy(&bytes).lines().rev().take(2000) {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value.get("type").and_then(serde_json::Value::as_str) != Some("event_msg") {
            continue;
        }
        let Some(payload) = value.get("payload") else { continue };
        if payload.get("type").and_then(serde_json::Value::as_str) != Some("token_count") {
            continue;
        }
        let Some(limits) = payload.get("rate_limits") else { continue };
        if limits.get("primary").or_else(|| limits.get("secondary")).is_none() {
            continue;
        }
        return Some(limits.clone());
    }
    None
}

fn codex_usage_window(value: &serde_json::Value, now_ms: i64) -> Option<WhaleWidgetCodexUsageWindow> {
    let number = |keys: &[&str]| {
        keys.iter().find_map(|key| {
            value.get(*key).and_then(serde_json::Value::as_f64)
        })
    };
    let mut percent = number(&[
        "used_percent",
        "usedPercent",
        "percent",
        "used_pct",
        "usage_percent",
        "usagePercent",
    ])
    .or_else(|| {
        number(&[
            "remaining_percent",
            "remainingPercent",
            "left_percent",
            "remaining_pct",
        ])
        .map(|remaining| 100.0 - remaining)
    })?;
    percent = percent.clamp(0.0, 100.0);
    let label = value
        .get("limit_name")
        .or_else(|| value.get("name"))
        .or_else(|| value.get("label"))
        .or_else(|| value.get("window_name"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let resets_at = number(&[
        "resets_in_seconds",
        "resetsInSeconds",
        "reset_after_seconds",
        "reset_in_seconds",
        "seconds_until_reset",
    ])
    .filter(|seconds| *seconds >= 0.0)
    .map(|seconds| now_ms.div_euclid(1000) + (seconds as i64))
    .or_else(|| {
        number(&["resets_at", "reset_at", "reset_time", "next_reset", "resetAt", "nextResetTime"])
            .map(|at| if at < 1e12 { (at * 1000.0) as i64 } else { at as i64 })
    });
    Some(WhaleWidgetCodexUsageWindow {
        label: if label.is_empty() { "limit".to_string() } else { label },
        percent: percent.round() as u32,
        resets_at,
    })
}

fn total_usage_tokens(usage: &TurnUsage) -> u64 {
    usage.input_tokens
        + usage.cache_creation_input_tokens
        + usage.cache_read_input_tokens
        + usage.output_tokens
}

const MAX_CODEX_SESSIONS: u32 = 10_000;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::entities::agent_setting;
    use sea_orm::{ActiveModelTrait, Set};

    fn usage_input(start: Option<&str>, models: &[&str]) -> WhaleWidgetCodexUsageInput {
        WhaleWidgetCodexUsageInput {
            start: start.map(|value| {
                chrono::DateTime::parse_from_rfc3339(value)
                    .expect("valid test timestamp")
                    .with_timezone(&chrono::Utc)
            }),
            models: Some(models.iter().map(|value| value.to_string()).collect()),
        }
    }

    #[tokio::test]
    async fn codex_usage_reports_empty_results_without_a_home() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        // 测试不能扫描真实的 ~/.codex 历史：把 CODEX_HOME 指向空目录，结果才确定且快速。
        let codex_home = tempfile::tempdir().expect("codex home");
        let now = chrono::Utc::now();
        agent_setting::ActiveModel {
            id: sea_orm::NotSet,
            agent_type: Set(serde_json::to_string(&AgentType::Codex).unwrap()),
            registry_id: Set("codex".to_string()),
            enabled: Set(true),
            sort_order: Set(0),
            installed_version: Set(None),
            env_json: Set(Some(
                serde_json::json!({ "CODEX_HOME": codex_home.path() }).to_string(),
            )),
            model_provider_id: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&db.conn)
        .await
        .expect("insert codex agent setting");
        let result = whale_widget_codex_usage_core(&db.conn, usage_input(None, &[]))
            .await
            .expect("codex usage");
        assert_eq!(result.tokens, 0);
        assert_eq!(result.sessions, 0);
        // 没有订阅快照就不造窗口，和原挂件「无 rate_limits 不显示」一致。
        assert!(result.windows.is_empty());
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn whale_widget_codex_usage(
    state: tauri::State<'_, Arc<crate::app_state::AppState>>,
    input: WhaleWidgetCodexUsageInput,
) -> Result<WhaleWidgetCodexUsage, AppCommandError> {
    whale_widget_codex_usage_core(&state.db.conn, input).await
}
