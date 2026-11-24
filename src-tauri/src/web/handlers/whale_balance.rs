use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::whale_balance as whale_commands;
use crate::whale_balance::{
    UpdateWhaleBalanceSettingsInput, WhaleBalanceSettingsView, WhaleBalanceSnapshot,
    WhaleBalanceTestResult,
};

#[derive(Deserialize)]
pub struct WhaleBalanceSettingsParams {
    pub settings: UpdateWhaleBalanceSettingsInput,
}

pub async fn whale_balance_get_state(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<WhaleBalanceSnapshot>, AppCommandError> {
    let snap = whale_commands::whale_balance_get_state_core(&state.whale_balance).await?;
    Ok(Json(snap))
}

pub async fn whale_balance_refresh(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<WhaleBalanceSnapshot>, AppCommandError> {
    let snap = whale_commands::whale_balance_refresh_core(&state.whale_balance).await?;
    Ok(Json(snap))
}

pub async fn whale_balance_get_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<WhaleBalanceSettingsView>, AppCommandError> {
    let view = whale_commands::whale_balance_get_settings_core(&state.whale_balance).await?;
    Ok(Json(view))
}

pub async fn whale_balance_update_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<WhaleBalanceSettingsParams>,
) -> Result<Json<WhaleBalanceSettingsView>, AppCommandError> {
    let view =
        whale_commands::whale_balance_update_settings_core(&state.whale_balance, params.settings)
            .await?;
    Ok(Json(view))
}

pub async fn whale_balance_test_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<WhaleBalanceSettingsParams>,
) -> Result<Json<WhaleBalanceTestResult>, AppCommandError> {
    let res =
        whale_commands::whale_balance_test_settings_core(&state.whale_balance, params.settings)
            .await?;
    Ok(Json(res))
}
