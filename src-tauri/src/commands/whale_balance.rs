#[cfg(feature = "tauri-runtime")]
use std::sync::Arc;

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::app_error::AppCommandError;
use crate::whale_balance::{
    UpdateWhaleBalanceSettingsInput, WhaleBalanceService, WhaleBalanceSettingsView,
    WhaleBalanceSnapshot, WhaleBalanceTestResult,
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
