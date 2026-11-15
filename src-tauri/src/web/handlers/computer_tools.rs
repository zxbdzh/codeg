//! HTTP handlers for the computer-use settings — the web-mode mirror of the
//! Tauri commands in `commands::computer_tools`.
//!
//! 配置与窗口操作共同使用 AppState 中的运行时句柄，保证桌面、
//! Web 和运行中的 Agent 看到相同开关及授权约束。

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::computer_tools::{
    load_computer_tools_settings, set_computer_tools_enabled_core,
    set_computer_tools_preferences_core, set_computer_tools_settings_core,
    ComputerToolsPreferences, ComputerToolsSettings,
};

pub async fn get_computer_tools_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ComputerToolsSettings>, AppCommandError> {
    Ok(Json(load_computer_tools_settings(&state.db.conn).await))
}

#[derive(Deserialize)]
pub struct SetComputerToolsSettingsParams {
    pub settings: ComputerToolsSettings,
}

pub async fn set_computer_tools_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetComputerToolsSettingsParams>,
) -> Result<Json<ComputerToolsSettings>, AppCommandError> {
    let saved = set_computer_tools_settings_core(
        &state.db.conn,
        &state.computer_tools_config,
        &state.emitter,
        params.settings,
    )
    .await?;
    Ok(Json(saved))
}

#[derive(Deserialize)]
pub struct SetComputerToolsEnabledParams {
    pub enabled: bool,
}

pub async fn set_computer_tools_enabled(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetComputerToolsEnabledParams>,
) -> Result<Json<ComputerToolsSettings>, AppCommandError> {
    let saved = set_computer_tools_enabled_core(
        &state.db.conn,
        &state.computer_tools_config,
        &state.emitter,
        params.enabled,
    )
    .await?;
    Ok(Json(saved))
}

/// Any of them; an absent one is left as it is.
pub async fn set_computer_tools_preferences(
    Extension(state): Extension<Arc<AppState>>,
    Json(preferences): Json<ComputerToolsPreferences>,
) -> Result<Json<ComputerToolsSettings>, AppCommandError> {
    let saved = set_computer_tools_preferences_core(
        &state.db.conn,
        &state.computer_tools_config,
        &state.emitter,
        preferences,
    )
    .await?;
    Ok(Json(saved))
}
