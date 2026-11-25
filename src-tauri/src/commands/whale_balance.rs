#[cfg(feature = "tauri-runtime")]
use std::sync::Arc;

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::app_error::AppCommandError;
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
