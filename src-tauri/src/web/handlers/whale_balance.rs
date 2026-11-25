use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::whale_balance as whale_commands;
use crate::whale_balance::{
    UpdateWhaleBalanceSettingsInput, WhaleBalanceLedger, WhaleBalancePresentation,
    WhaleBalancePresentationInput, WhaleBalanceReconcileInput, WhaleBalanceSettingsView,
    WhaleBalanceSnapshot, WhaleBalanceTestResult,
};

#[derive(Deserialize)]
pub struct WhaleBalanceSettingsParams {
    pub settings: UpdateWhaleBalanceSettingsInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceReconcileParams {
    pub input: WhaleBalanceReconcileInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalancePresentationParams {
    pub input: WhaleBalancePresentationInput,
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

pub async fn whale_balance_get_ledger(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<WhaleBalanceLedger>, AppCommandError> {
    let ledger = whale_commands::whale_balance_get_ledger_core(&state.whale_balance).await?;
    Ok(Json(ledger))
}

pub async fn whale_balance_reconcile(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<WhaleBalanceReconcileParams>,
) -> Result<Json<WhaleBalanceSnapshot>, AppCommandError> {
    let snapshot =
        whale_commands::whale_balance_reconcile_core(&state.whale_balance, params.input).await?;
    Ok(Json(snapshot))
}

pub async fn whale_balance_get_presentation(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<WhaleBalancePresentation>, AppCommandError> {
    let presentation =
        whale_commands::whale_balance_get_presentation_core(&state.whale_balance).await?;
    Ok(Json(presentation))
}

pub async fn whale_balance_save_presentation(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<WhaleBalancePresentationParams>,
) -> Result<Json<WhaleBalancePresentation>, AppCommandError> {
    let presentation = whale_commands::whale_balance_save_presentation_core(
        &state.whale_balance,
        params.input,
    )
    .await?;
    Ok(Json(presentation))
}

pub async fn whale_widget_get_options(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, AppCommandError> {
    state.whale_balance.get_widget_options().await.map(Json)
}

#[derive(Deserialize)]
pub struct WhaleWidgetOptionsParams {
    input: serde_json::Value,
}

pub async fn whale_widget_save_options(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<WhaleWidgetOptionsParams>,
) -> Result<Json<serde_json::Value>, AppCommandError> {
    state.whale_balance.save_widget_options(params.input).await.map(Json)
}

#[derive(Deserialize)]
pub struct WhaleWidgetCodexUsageParams {
    input: whale_commands::WhaleWidgetCodexUsageInput,
}

pub async fn whale_widget_codex_usage(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<WhaleWidgetCodexUsageParams>,
) -> Result<Json<whale_commands::WhaleWidgetCodexUsage>, AppCommandError> {
    let usage = whale_commands::whale_widget_codex_usage_core(&state.db.conn, params.input).await?;
    Ok(Json(usage))
}
