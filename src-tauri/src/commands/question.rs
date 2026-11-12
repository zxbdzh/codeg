//! Shared persistence for the question toggle and answer deadline.
//! Zero minutes means no Codeg deadline; upstream cancellation still applies.

use sea_orm::{DatabaseConnection, TransactionTrait};
use serde::{Deserialize, Serialize};

use crate::acp::question::{QuestionConfig, QuestionRuntimeConfig};
use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter, QUESTION_SETTINGS_CHANGED_EVENT};

pub const KEY_QUESTION_ENABLED: &str = "question.enabled";
pub const KEY_QUESTION_TIMEOUT_MINUTES: &str = "question.timeout_minutes";
pub const MAX_QUESTION_TIMEOUT_MINUTES: u32 = 10_080;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuestionSettings {
    pub enabled: bool,
    /// 0 不设答题期限；停止会话、断连和上游撤回仍正常取消。
    #[serde(default)]
    pub timeout_minutes: u32,
}

/// 旧客户端只提交开关时保留等待时长，不重置用户偏好。
#[derive(Debug, Clone, Deserialize)]
pub struct QuestionSettingsUpdate {
    pub enabled: bool,
    pub timeout_minutes: Option<u32>,
}

impl Default for QuestionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            timeout_minutes: 0,
        }
    }
}

impl QuestionSettings {
    fn into_runtime_config(self) -> QuestionConfig {
        QuestionConfig {
            enabled: self.enabled,
            timeout_minutes: self.timeout_minutes,
        }
    }
}

fn parse_timeout(raw: Option<String>) -> u32 {
    raw.and_then(|raw| raw.parse::<u32>().ok())
        .filter(|minutes| *minutes <= MAX_QUESTION_TIMEOUT_MINUTES)
        .unwrap_or(0)
}

pub async fn load_question_settings(conn: &DatabaseConnection) -> QuestionSettings {
    let mut settings = QuestionSettings::default();
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, KEY_QUESTION_ENABLED).await {
        if let Ok(v) = raw.parse::<bool>() {
            settings.enabled = v;
        }
    }
    if let Ok(raw) = app_metadata_service::get_value(conn, KEY_QUESTION_TIMEOUT_MINUTES).await {
        settings.timeout_minutes = parse_timeout(raw);
    }
    settings
}

pub async fn apply_persisted_question_config(
    conn: &DatabaseConnection,
    config: &QuestionRuntimeConfig,
) {
    config
        .set(load_question_settings(conn).await.into_runtime_config())
        .await;
}

/// Both transports share validation, persistence, runtime application and broadcast.
pub async fn set_question_settings_core(
    conn: &DatabaseConnection,
    config: &QuestionRuntimeConfig,
    emitter: &EventEmitter,
    update: QuestionSettingsUpdate,
) -> Result<QuestionSettings, AppCommandError> {
    if update
        .timeout_minutes
        .is_some_and(|v| v > MAX_QUESTION_TIMEOUT_MINUTES)
    {
        return Err(AppCommandError::configuration_invalid(
            "Question timeout must be between 0 and 10080 minutes",
        ));
    }
    // 合并与写入在同一事务内，避免开关和时长只保存一半。
    let txn = conn
        .begin()
        .await
        .map_err(crate::db::error::DbError::from)
        .map_err(AppCommandError::from)?;
    let timeout_minutes = match update.timeout_minutes {
        Some(minutes) => minutes,
        None => parse_timeout(
            app_metadata_service::get_value_conn(&txn, KEY_QUESTION_TIMEOUT_MINUTES)
                .await
                .map_err(AppCommandError::from)?,
        ),
    };
    let desired = QuestionSettings {
        enabled: update.enabled,
        timeout_minutes,
    };
    app_metadata_service::upsert_value(&txn, KEY_QUESTION_ENABLED, &desired.enabled.to_string())
        .await
        .map_err(AppCommandError::from)?;
    app_metadata_service::upsert_value(
        &txn,
        KEY_QUESTION_TIMEOUT_MINUTES,
        &timeout_minutes.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    txn.commit()
        .await
        .map_err(crate::db::error::DbError::from)
        .map_err(AppCommandError::from)?;
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, QUESTION_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_question_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<QuestionSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_question_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_question_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, QuestionRuntimeConfig>,
    settings: QuestionSettingsUpdate,
) -> Result<QuestionSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        set_question_settings_core(&db.conn, &config, &EventEmitter::Tauri(app), settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_returns_default_enabled_when_unset() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        assert_eq!(
            load_question_settings(&db.conn).await,
            QuestionSettings::default()
        );
    }

    #[tokio::test]
    async fn set_then_load_round_trip_and_runtime_applied() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = QuestionRuntimeConfig::new();
        for minutes in [45, MAX_QUESTION_TIMEOUT_MINUTES, 0] {
            let saved = set_question_settings_core(
                &db.conn,
                &config,
                &EventEmitter::Noop,
                QuestionSettingsUpdate {
                    enabled: false,
                    timeout_minutes: Some(minutes),
                },
            )
            .await
            .unwrap();
            assert_eq!(load_question_settings(&db.conn).await, saved);
            assert_eq!(config.snapshot().await.timeout_minutes, minutes);
            assert!(!config.is_enabled().await);
        }
    }

    #[tokio::test]
    async fn toggle_only_preserves_timeout_and_invalid_update_is_atomic() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = QuestionRuntimeConfig::new();
        app_metadata_service::upsert_value(&db.conn, KEY_QUESTION_TIMEOUT_MINUTES, "90")
            .await
            .unwrap();
        let update: QuestionSettingsUpdate =
            serde_json::from_value(serde_json::json!({"enabled": false})).unwrap();
        let saved = set_question_settings_core(&db.conn, &config, &EventEmitter::Noop, update)
            .await
            .unwrap();
        assert_eq!(saved.timeout_minutes, 90);
        let invalid = QuestionSettingsUpdate {
            enabled: true,
            timeout_minutes: Some(MAX_QUESTION_TIMEOUT_MINUTES + 1),
        };
        assert!(
            set_question_settings_core(&db.conn, &config, &EventEmitter::Noop, invalid)
                .await
                .is_err()
        );
        assert_eq!(load_question_settings(&db.conn).await, saved);
        assert!(!config.is_enabled().await);
        assert_eq!(config.snapshot().await.timeout_minutes, 90);
    }

    #[tokio::test]
    async fn persisted_config_applies_and_corrupt_timeout_defaults_to_forever() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = QuestionRuntimeConfig::new();
        app_metadata_service::upsert_value(&db.conn, KEY_QUESTION_ENABLED, "false")
            .await
            .unwrap();
        for raw in ["15", "-1", "10081", "invalid"] {
            app_metadata_service::upsert_value(&db.conn, KEY_QUESTION_TIMEOUT_MINUTES, raw)
                .await
                .unwrap();
            apply_persisted_question_config(&db.conn, &config).await;
            assert!(!config.is_enabled().await);
            assert_eq!(
                config.snapshot().await.timeout_minutes,
                if raw == "15" { 15 } else { 0 }
            );
        }
    }
}
