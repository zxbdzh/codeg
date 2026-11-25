use std::collections::{BTreeMap, HashSet};
use std::net::IpAddr;
use std::time::{Duration, Instant};

use chrono::{Datelike, TimeZone, Timelike, Utc};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, TransactionTrait};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};
use url::Url;

use crate::app_error::AppCommandError;
use crate::db::entities::token_usage_turn;
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter};

const CONFIG_KV_KEY: &str = "whale_balance.config";
const SNAPSHOT_KV_KEY: &str = "whale_balance.snapshot";
const LEDGER_KV_KEY: &str = "whale_balance.ledger";
const PRESENTATION_KV_KEY: &str = "whale_balance.presentation";

pub const WHALE_BALANCE_DASHBOARD_EVENT: &str = "whale://dashboard-updated";
pub const WHALE_BALANCE_PRESENTATION_EVENT: &str = "whale://presentation-updated";
pub const WHALE_BALANCE_UPDATED_EVENT: &str = "whale://balance-updated";

const DEFAULT_METHOD: &str = "GET";
const DEFAULT_AUTH_HEADER: &str = "Bearer {key}";
const DEFAULT_REMAINING_PATH: &str = "balance";
const DEFAULT_USED_PATH: &str = "api_key_quota.used";
const DEFAULT_SCALE: f64 = 1.0;
const DEFAULT_POLL_INTERVAL_SECS: u64 = 60;
const MIN_POLL_INTERVAL_SECS: u64 = 15;
const MAX_POLL_INTERVAL_SECS: u64 = 3600;
const REQUEST_TIMEOUT_SECS: u64 = 15;
const MIN_MANUAL_REFRESH_COOLDOWN_MS: u64 = 1500;

/// Backend configuration keeps the original single-model fields for rollback
/// compatibility. New clients use `models`; secrets never leave Rust.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceConfig {
    pub enabled: bool,
    pub account_name: String,
    pub url: String,
    pub method: String,
    pub auth_header: String,
    pub api_key: String,
    pub remaining_path: String,
    pub used_path: String,
    pub scale: f64,
    pub poll_interval_secs: u64,
    pub account_generation: u64,
    #[serde(default)]
    pub models: Vec<WhaleBalanceModelConfig>,
    #[serde(default)]
    pub active_model_id: String,
    #[serde(default)]
    pub peak_price: Option<f64>,
    #[serde(default)]
    pub off_peak_price: Option<f64>,
    #[serde(default = "default_currency")]
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceModelConfig {
    pub id: String,
    pub account_name: String,
    pub url: String,
    pub method: String,
    pub auth_header: String,
    pub api_key: String,
    pub remaining_path: String,
    pub used_path: String,
    #[serde(default)]
    pub total_path: String,
    #[serde(default)]
    pub unit_path: String,
    pub scale: f64,
    pub account_generation: u64,
}

impl Default for WhaleBalanceModelConfig {
    fn default() -> Self {
        Self {
            id: "default".to_string(),
            account_name: String::default(),
            url: String::default(),
            method: DEFAULT_METHOD.to_string(),
            auth_header: DEFAULT_AUTH_HEADER.to_string(),
            api_key: String::default(),
            remaining_path: DEFAULT_REMAINING_PATH.to_string(),
            used_path: DEFAULT_USED_PATH.to_string(),
            total_path: String::default(),
            unit_path: String::default(),
            scale: DEFAULT_SCALE,
            account_generation: 1,
        }
    }
}

impl WhaleBalanceModelConfig {
    fn is_configured(&self) -> bool {
        !self.url.trim().is_empty() && !self.remaining_path.trim().is_empty()
    }

    fn signature_differs(&self, other: &Self) -> bool {
        self.account_name != other.account_name
            || self.url != other.url
            || self.method != other.method
            || self.auth_header != other.auth_header
            || self.api_key != other.api_key
            || self.remaining_path != other.remaining_path
            || self.used_path != other.used_path
            || self.total_path != other.total_path
            || self.unit_path != other.unit_path
            || (self.scale - other.scale).abs() > f64::EPSILON
    }
}

fn default_currency() -> String {
    "CNY".to_string()
}

impl Default for WhaleBalanceConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            account_name: String::default(),
            url: String::default(),
            method: DEFAULT_METHOD.to_string(),
            auth_header: DEFAULT_AUTH_HEADER.to_string(),
            api_key: String::default(),
            remaining_path: DEFAULT_REMAINING_PATH.to_string(),
            used_path: DEFAULT_USED_PATH.to_string(),
            scale: DEFAULT_SCALE,
            poll_interval_secs: DEFAULT_POLL_INTERVAL_SECS,
            account_generation: 1,
            models: Vec::new(),
            active_model_id: "default".to_string(),
            peak_price: None,
            off_peak_price: None,
            currency: default_currency(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceModelView {
    pub id: String,
    pub account_name: String,
    pub url: String,
    pub method: String,
    pub auth_header: String,
    pub has_api_key: bool,
    pub api_key_hint: Option<String>,
    pub remaining_path: String,
    pub used_path: String,
    pub total_path: String,
    pub unit_path: String,
    pub scale: f64,
}

impl From<&WhaleBalanceModelConfig> for WhaleBalanceModelView {
    fn from(model: &WhaleBalanceModelConfig) -> Self {
        Self {
            id: model.id.clone(),
            account_name: model.account_name.clone(),
            url: model.url.clone(),
            method: model.method.clone(),
            auth_header: model.auth_header.clone(),
            has_api_key: !model.api_key.is_empty(),
            api_key_hint: mask_api_key(&model.api_key),
            remaining_path: model.remaining_path.clone(),
            used_path: model.used_path.clone(),
            total_path: model.total_path.clone(),
            unit_path: model.unit_path.clone(),
            scale: model.scale,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceModelInput {
    pub id: String,
    pub account_name: String,
    pub url: String,
    pub method: Option<String>,
    pub auth_header: Option<String>,
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
    pub remaining_path: Option<String>,
    pub used_path: Option<String>,
    pub total_path: Option<String>,
    pub unit_path: Option<String>,
    pub scale: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceSnapshot {
    pub configured: bool,
    pub enabled: bool,
    pub account_name: String,
    /// `None` means there has been no successful reading; zero is a real value.
    pub balance: Option<f64>,
    /// Amount reported by the configured API `usedPath`, not the local ledger.
    pub used: Option<f64>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub accounts: Vec<WhaleBalanceModelSnapshot>,
    #[serde(default)]
    pub observed_today: Option<f64>,
    #[serde(default)]
    pub estimated_cost_today: Option<f64>,
    #[serde(default = "default_currency")]
    pub currency: String,
    #[serde(default)]
    pub is_peak_period: bool,
    #[serde(default)]
    pub current_price: Option<f64>,
    pub last_success_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub stale: bool,
    pub refreshing: bool,
    pub account_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceModelSnapshot {
    pub id: String,
    pub account_name: String,
    pub balance: Option<f64>,
    pub used: Option<f64>,
    pub total: Option<f64>,
    pub unit: Option<String>,
    pub last_success_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub stale: bool,
    pub refreshing: bool,
    pub account_generation: u64,
}

impl WhaleBalanceSnapshot {
    fn empty_from_config(config: &WhaleBalanceConfig) -> Self {
        let accounts = config.models.iter().map(empty_model_snapshot).collect();
        Self {
            configured: config.models.iter().any(WhaleBalanceModelConfig::is_configured),
            enabled: config.enabled,
            account_name: config.account_name.clone(),
            balance: None,
            used: None,
            total: None,
            unit: None,
            model_id: config.active_model_id.clone(),
            accounts,
            observed_today: None,
            estimated_cost_today: None,
            currency: config.currency.clone(),
            is_peak_period: false,
            current_price: None,
            last_success_at: None,
            last_attempt_at: None,
            last_error: None,
            stale: false,
            refreshing: false,
            account_generation: config.account_generation,
        }
    }
}

fn empty_model_snapshot(model: &WhaleBalanceModelConfig) -> WhaleBalanceModelSnapshot {
    WhaleBalanceModelSnapshot {
        id: model.id.clone(),
        account_name: model.account_name.clone(),
        balance: None,
        used: None,
        total: None,
        unit: None,
        last_success_at: None,
        last_attempt_at: None,
        last_error: None,
        stale: false,
        refreshing: false,
        account_generation: model.account_generation,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceSettingsView {
    pub enabled: bool,
    pub account_name: String,
    pub url: String,
    pub method: String,
    pub auth_header: String,
    pub has_api_key: bool,
    pub api_key_hint: Option<String>,
    pub remaining_path: String,
    pub used_path: String,
    pub total_path: String,
    pub unit_path: String,
    pub scale: f64,
    pub poll_interval_secs: u64,
    pub models: Vec<WhaleBalanceModelView>,
    pub active_model_id: String,
    pub peak_price: Option<f64>,
    pub off_peak_price: Option<f64>,
    pub currency: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWhaleBalanceSettingsInput {
    pub enabled: bool,
    pub account_name: String,
    pub url: String,
    pub method: Option<String>,
    pub auth_header: Option<String>,
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
    pub remaining_path: Option<String>,
    pub used_path: Option<String>,
    pub scale: Option<f64>,
    pub poll_interval_secs: Option<u64>,
    #[serde(default)]
    pub models: Option<Vec<WhaleBalanceModelInput>>,
    pub active_model_id: Option<String>,
    pub peak_price: Option<Option<f64>>,
    #[serde(default)]
    pub clear_peak_price: bool,
    pub off_peak_price: Option<Option<f64>>,
    #[serde(default)]
    pub clear_off_peak_price: bool,
    pub currency: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceTestResult {
    pub ok: bool,
    pub balance: Option<f64>,
    pub used: Option<f64>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceLedger {
    #[serde(default)]
    pub balance_adjustments: BTreeMap<String, f64>,
    #[serde(default)]
    pub entries: Vec<WhaleBalanceLedgerEntry>,
    #[serde(default)]
    pub baseline_dates: BTreeMap<String, String>,
    #[serde(default)]
    pub baseline_balances: BTreeMap<String, f64>,
    /// 按「模型 → 北京时间日期 → 余额下降累计量」聚合。
    /// `entries` 会被裁剪，今日消费必须靠这张表才不会随裁剪少算。
    #[serde(default)]
    pub daily_consumption: BTreeMap<String, BTreeMap<String, f64>>,
}


#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceLedgerEntry {
    pub model_id: String,
    pub at: String,
    /// `consumption`, `balance_increase`, or `reconciliation`.
    pub kind: String,
    pub amount: f64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalancePresentation {
    pub show_balance: bool,
    pub show_api_used: bool,
    pub show_observed_today: bool,
    pub show_token_cost: bool,
    pub widget_size: u8,
}

impl Default for WhaleBalancePresentation {
    fn default() -> Self {
        Self {
            show_balance: true,
            show_api_used: true,
            show_observed_today: false,
            show_token_cost: false,
            widget_size: 44,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceReconcileInput {
    pub model_id: String,
    pub amount: f64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalancePresentationInput {
    pub show_balance: bool,
    pub show_api_used: bool,
    pub show_observed_today: bool,
    pub show_token_cost: bool,
    pub widget_size: u8,
}

struct ServiceInner {
    loaded: bool,
    config: WhaleBalanceConfig,
    snapshot: WhaleBalanceSnapshot,
    ledger: WhaleBalanceLedger,
    last_polled_at: Option<Instant>,
}

pub struct WhaleBalanceService {
    db: DatabaseConnection,
    emitter: EventEmitter,
    client: reqwest::Client,
    inner: RwLock<ServiceInner>,
    refresh_lock: Mutex<()>,
    mutation_lock: Mutex<()>,
}

impl WhaleBalanceService {
    pub fn new(db: DatabaseConnection, emitter: EventEmitter) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self::with_client(db, emitter, client)
    }

    pub fn with_client(
        db: DatabaseConnection,
        emitter: EventEmitter,
        client: reqwest::Client,
    ) -> Self {
        let config = WhaleBalanceConfig::default();
        let snapshot = WhaleBalanceSnapshot::empty_from_config(&config);
        Self {
            db,
            emitter,
            client,
            inner: RwLock::new(ServiceInner {
                loaded: false,
                config,
                snapshot,
                ledger: WhaleBalanceLedger::default(),
                last_polled_at: None,
            }),
            refresh_lock: Mutex::new(()),
            mutation_lock: Mutex::new(()),
        }
    }

    async fn ensure_loaded(&self) -> Result<(), AppCommandError> {
        if self.inner.read().await.loaded {
            return Ok(());
        }
        let _mutation = self.mutation_lock.lock().await;
        let mut guard = self.inner.write().await;
        if guard.loaded {
            return Ok(());
        }

        let cfg_raw = app_metadata_service::get_value(&self.db, CONFIG_KV_KEY)
            .await
            .map_err(AppCommandError::db)?;
        let mut config = match cfg_raw.as_deref() {
            Some(raw) => serde_json::from_str::<WhaleBalanceConfig>(raw).map_err(|error| {
                AppCommandError::io_error(format!("Stored whale balance config is invalid: {error}"))
            })?,
            None => WhaleBalanceConfig::default(),
        };
        let legacy_config = config.models.is_empty();
        migrate_legacy_config(&mut config);

        let snap_raw = app_metadata_service::get_value(&self.db, SNAPSHOT_KV_KEY)
            .await
            .map_err(AppCommandError::db)?;
        let mut snapshot = match snap_raw.as_deref() {
            Some(raw) => serde_json::from_str::<WhaleBalanceSnapshot>(raw).map_err(|error| {
                AppCommandError::io_error(format!("Stored whale balance snapshot is invalid: {error}"))
            })?,
            None => WhaleBalanceSnapshot::empty_from_config(&config),
        };
        let legacy_snapshot = snapshot.accounts.is_empty();
        migrate_legacy_snapshot(&mut snapshot, &config);
        let ledger_raw = app_metadata_service::get_value(&self.db, LEDGER_KV_KEY)
            .await
            .map_err(AppCommandError::db)?;
        let ledger = match ledger_raw.as_deref() {
            Some(raw) => serde_json::from_str::<WhaleBalanceLedger>(raw).map_err(|error| {
                AppCommandError::io_error(format!("Stored whale balance ledger is invalid: {error}"))
            })?,
            None => WhaleBalanceLedger::default(),
        };
        let ledger_needs_backfill = ledger.daily_consumption.is_empty();
        let mut ledger = ledger;
        backfill_daily_consumption(&mut ledger);
        sync_snapshot_config(&mut snapshot, &config, &ledger);

        if cfg_raw.is_none()
            || legacy_config
            || legacy_snapshot
            || snapshot.accounts.len() != config.models.len()
            || ledger_raw.is_none()
            || ledger_needs_backfill
        {
            let cfg_json = serialize(&config, "whale balance config")?;
            let snap_json = serialize(&snapshot, "whale balance snapshot")?;
            let ledger_json = serialize(&ledger, "whale balance ledger")?;
            persist_values(
                &self.db,
                &[
                    (CONFIG_KV_KEY, cfg_json.as_str()),
                    (SNAPSHOT_KV_KEY, snap_json.as_str()),
                    (LEDGER_KV_KEY, ledger_json.as_str()),
                ],
            )
            .await?;
        }
        guard.config = config;
        guard.snapshot = snapshot;
        guard.ledger = ledger;
        guard.loaded = true;
        Ok(())
    }

    pub async fn get_settings(&self) -> Result<WhaleBalanceSettingsView, AppCommandError> {
        self.ensure_loaded().await?;
        let guard = self.inner.read().await;
        Ok(settings_view(&guard.config))
    }

    pub async fn get_presentation(&self) -> Result<WhaleBalancePresentation, AppCommandError> {
        self.ensure_loaded().await?;
        let raw = app_metadata_service::get_value(&self.db, PRESENTATION_KV_KEY)
            .await
            .map_err(AppCommandError::db)?;
        Ok(raw
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default())
    }

    pub async fn save_presentation(
        &self,
        input: WhaleBalancePresentationInput,
    ) -> Result<WhaleBalancePresentation, AppCommandError> {
        let _mutation = self.mutation_lock.lock().await;
        let presentation = WhaleBalancePresentation {
            show_balance: input.show_balance,
            show_api_used: input.show_api_used,
            show_observed_today: input.show_observed_today,
            show_token_cost: input.show_token_cost,
            widget_size: input.widget_size.clamp(32, 96),
        };
        let encoded = serialize(&presentation, "whale balance presentation")?;
        persist_values(&self.db, &[(PRESENTATION_KV_KEY, &encoded)]).await?;
        emit_event(
            &self.emitter,
            WHALE_BALANCE_PRESENTATION_EVENT,
            &presentation,
        );
        Ok(presentation)
    }

    pub async fn get_ledger(&self) -> Result<WhaleBalanceLedger, AppCommandError> {
        self.ensure_loaded().await?;
        Ok(self.inner.read().await.ledger.clone())
    }

    pub async fn get_state(&self) -> Result<WhaleBalanceSnapshot, AppCommandError> {
        self.ensure_loaded().await?;
        let (mut snapshot, config, ledger) = {
            let guard = self.inner.read().await;
            (
                guard.snapshot.clone(),
                guard.config.clone(),
                guard.ledger.clone(),
            )
        };
        let tokens_today = today_token_count(&self.db).await?;
        update_dashboard_fields(&mut snapshot, &config, &ledger, tokens_today);
        Ok(snapshot)
    }

    pub async fn update_settings(
        &self,
        input: UpdateWhaleBalanceSettingsInput,
    ) -> Result<WhaleBalanceSettingsView, AppCommandError> {
        self.ensure_loaded().await?;
        let _mutation = self.mutation_lock.lock().await;
        let next = {
            let guard = self.inner.read().await;
            normalize_config_input(&guard.config, input, true)?
        };
        let (view, snapshot) = {
            let mut guard = self.inner.write().await;
            let mut next = next;
            preserve_model_generations(&guard.config, &mut next);
            let snapshot_changed = guard.config.models != next.models
                || guard.config.active_model_id != next.active_model_id;
            let mut snapshot = if snapshot_changed {
                let mut fresh = WhaleBalanceSnapshot::empty_from_config(&next);
                for account in &mut fresh.accounts {
                    if let Some(old) = guard
                        .snapshot
                        .accounts
                        .iter()
                        .find(|old| old.id == account.id)
                    {
                        if old.account_generation == account.account_generation {
                            *account = old.clone();
                        }
                    }
                }
                fresh
            } else {
                guard.snapshot.clone()
            };
            sync_snapshot_config(&mut snapshot, &next, &guard.ledger);
            let view = settings_view(&next);
            let cfg_json = serialize(&next, "whale balance config")?;
            let snap_json = serialize(&snapshot, "whale balance snapshot")?;
            let ledger_json = serialize(&guard.ledger, "whale balance ledger")?;
            persist_values(
                &self.db,
                &[
                    (CONFIG_KV_KEY, &cfg_json),
                    (SNAPSHOT_KV_KEY, &snap_json),
                    (LEDGER_KV_KEY, &ledger_json),
                ],
            )
            .await?;
            guard.config = next;
            guard.snapshot = snapshot.clone();
            guard.last_polled_at = None;
            (view, snapshot)
        };
        emit_event(&self.emitter, WHALE_BALANCE_UPDATED_EVENT, &snapshot);
        drop(_mutation);
        if snapshot.enabled && snapshot.configured {
            let _ = self.refresh_internal(true).await;
        }
        Ok(view)
    }

    pub async fn test_settings(
        &self,
        input: UpdateWhaleBalanceSettingsInput,
    ) -> Result<WhaleBalanceTestResult, AppCommandError> {
        self.ensure_loaded().await?;
        let guard = self.inner.read().await;
        let candidate = normalize_config_input(&guard.config, input, false)?;
        let model = candidate
            .models
            .iter()
            .find(|m| m.id == candidate.active_model_id)
            .or_else(|| candidate.models.first());
        let Some(model) = model.filter(|m| m.is_configured()) else {
            return Ok(test_failure("请先填写余额接口地址和余额字段路径"));
        };
        match fetch_balance_once(&self.client, model).await {
            Ok(reading) => Ok(WhaleBalanceTestResult {
                ok: true,
                balance: Some(reading.balance),
                used: reading.used,
                total: reading.total,
                unit: reading.unit,
                error: None,
            }),
            Err(err) => Ok(test_failure(&err)),
        }
    }

    pub async fn reconcile(
        &self,
        input: WhaleBalanceReconcileInput,
    ) -> Result<WhaleBalanceSnapshot, AppCommandError> {
        self.ensure_loaded().await?;
        if !input.amount.is_finite() || input.amount == 0.0 {
            return Err(AppCommandError::invalid_input(
                "校正金额必须是非零有限数",
            ));
        }
        let _mutation = self.mutation_lock.lock().await;
        let guard = self.inner.read().await;
        if !guard.config.models.iter().any(|model| model.id == input.model_id) {
            return Err(AppCommandError::invalid_input("找不到指定的余额模型"));
        }
        let now = Utc::now();
        let mut ledger = guard.ledger.clone();
        *ledger
            .balance_adjustments
            .entry(input.model_id.clone())
            .or_insert(0.0) += input.amount;
        ledger.entries.push(WhaleBalanceLedgerEntry {
            model_id: input.model_id,
            at: now.to_rfc3339(),
            kind: "reconciliation".to_string(),
            amount: input.amount,
            note: input.note.map(|note| note.chars().take(160).collect()),
        });
        let mut snapshot = guard.snapshot.clone();
        let config = guard.config.clone();
        drop(guard);
        // 校正必须马上体现到余额，否则用户点完看不出变化。
        sync_snapshot_config(&mut snapshot, &config, &ledger);
        update_dashboard_fields(
            &mut snapshot,
            &config,
            &ledger,
            today_token_count(&self.db).await?,
        );
        let snap_json = serialize(&snapshot, "whale balance snapshot")?;
        let ledger_json = serialize(&ledger, "whale balance ledger")?;
        persist_values(
            &self.db,
            &[
                (SNAPSHOT_KV_KEY, &snap_json),
                (LEDGER_KV_KEY, &ledger_json),
            ],
        )
        .await?;
        let mut guard = self.inner.write().await;
        guard.ledger = ledger;
        guard.snapshot = snapshot.clone();
        emit_event(&self.emitter, WHALE_BALANCE_UPDATED_EVENT, &snapshot);
        emit_event(&self.emitter, WHALE_BALANCE_DASHBOARD_EVENT, &snapshot);
        Ok(snapshot)
    }

    pub async fn refresh_now(&self) -> Result<WhaleBalanceSnapshot, AppCommandError> {
        self.ensure_loaded().await?;
        self.refresh_internal(false).await
    }

    pub async fn poll_if_due(&self) {
        if self.ensure_loaded().await.is_err() {
            return;
        }
        let due = {
            let guard = self.inner.read().await;
            guard.config.enabled
                && guard.config.models.iter().any(WhaleBalanceModelConfig::is_configured)
                && guard.last_polled_at.is_none_or(|last| {
                    last.elapsed() >= Duration::from_secs(guard.config.poll_interval_secs)
                })
        };
        if due {
            let _ = self.refresh_internal(false).await;
        }
    }

    async fn refresh_internal(
        &self,
        bypass_cooldown: bool,
    ) -> Result<WhaleBalanceSnapshot, AppCommandError> {
        let _refresh = self.refresh_lock.lock().await;
        let config = {
            let _mutation = self.mutation_lock.lock().await;
            let mut guard = self.inner.write().await;
            let now = Instant::now();
            if !guard.config.models.iter().any(WhaleBalanceModelConfig::is_configured) {
                return Ok(guard.snapshot.clone());
            }
            if !bypass_cooldown
                && guard.last_polled_at.is_some_and(|last| {
                    last.elapsed() < Duration::from_millis(MIN_MANUAL_REFRESH_COOLDOWN_MS)
                })
            {
                return Ok(guard.snapshot.clone());
            }
            guard.last_polled_at = Some(now);
            let configured_ids: HashSet<String> = guard
                .config
                .models
                .iter()
                .filter(|model| model.is_configured())
                .map(|model| model.id.clone())
                .collect();
            for account in &mut guard.snapshot.accounts {
                account.refreshing = configured_ids.contains(&account.id);
            }
            guard.snapshot.refreshing = true;
            guard.snapshot.clone()
        };
        emit_event(&self.emitter, WHALE_BALANCE_UPDATED_EVENT, &config);

        let model_configs = self.inner.read().await.config.models.clone();
        let results = futures::future::join_all(model_configs.iter().map(|model| async move {
            let result = if model.is_configured() {
                Some(fetch_balance_once(&self.client, model).await)
            } else {
                None
            };
            (model.id.clone(), model.account_generation, result)
        }))
        .await;
        let now = Utc::now();
        let now_iso = now.to_rfc3339();
        let tokens_today = today_token_count(&self.db).await?;
        let _mutation = self.mutation_lock.lock().await;
        let mut guard = self.inner.write().await;
        let mut ledger = guard.ledger.clone();
        let mut snapshot = guard.snapshot.clone();
        for (id, generation, result) in results {
            let generation_is_current = guard
                .config
                .models
                .iter()
                .any(|model| model.id == id && model.account_generation == generation);
            if !generation_is_current {
                continue;
            }
            let Some(account) = snapshot.accounts.iter_mut().find(|row| row.id == id) else {
                continue;
            };
            account.refreshing = false;
            let Some(result) = result else { continue };
            account.last_attempt_at = Some(now_iso.clone());
            match result {
                Ok(reading) => {
                    let local_date = Utc::now()
                        .with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).expect("valid UTC+8"))
                        .date_naive()
                        .to_string();
                    let same_local_day = account
                        .last_success_at
                        .as_deref()
                        .and_then(parse_timestamp)
                        .is_some_and(|previous| {
                            previous
                                .with_timezone(&beijing_offset())
                                .date_naive()
                                .to_string()
                                == local_date
                        });
                    if ledger.baseline_dates.get(&id) != Some(&local_date) {
                        ledger.baseline_dates.insert(id.clone(), local_date.clone());
                        ledger.baseline_balances.insert(id.clone(), reading.balance);
                    }
                    // 币种/单位切换造成的数值跳变不是真实消费，只重置基准。
                    let unit_changed = account
                        .unit
                        .as_deref()
                        .is_some_and(|previous| Some(previous) != reading.unit.as_deref());
                    if unit_changed {
                        ledger.baseline_balances.insert(id.clone(), reading.balance);
                    }
                    if same_local_day && !unit_changed {
                        if let Some(previous) = account.balance {
                            let (kind, amount) = if previous > reading.balance {
                                ("consumption", previous - reading.balance)
                            } else if reading.balance > previous {
                                ("balance_increase", reading.balance - previous)
                            } else {
                                ("", 0.0)
                            };
                            if !kind.is_empty() && amount > 0.0 {
                                ledger.entries.push(WhaleBalanceLedgerEntry {
                                    model_id: id.clone(),
                                    at: now_iso.clone(),
                                    kind: kind.to_string(),
                                    amount,
                                    note: None,
                                });
                                if kind == "consumption" {
                                    *ledger
                                        .daily_consumption
                                        .entry(id.clone())
                                        .or_default()
                                        .entry(local_date.clone())
                                        .or_insert(0.0) += amount;
                                }
                                trim_ledger(&mut ledger);
                            }
                        }
                    }
                    account.balance = Some(reading.balance);
                    account.used = reading.used;
                    account.total = reading.total;
                    account.unit = reading.unit;
                    account.last_success_at = Some(now_iso.clone());
                    account.last_error = None;
                    account.stale = false;
                }
                Err(error) => {
                    account.last_error = Some(error);
                    account.stale = account.last_success_at.is_some();
                }
            }
        }
        snapshot.refreshing = snapshot.accounts.iter().any(|account| account.refreshing);
        sync_snapshot_config(&mut snapshot, &guard.config, &ledger);
        update_dashboard_fields(&mut snapshot, &guard.config, &ledger, tokens_today);
        let snapshot_json = serialize(&snapshot, "whale balance snapshot")?;
        let ledger_json = serialize(&ledger, "whale balance ledger")?;
        persist_values(
            &self.db,
            &[
                (SNAPSHOT_KV_KEY, &snapshot_json),
                (LEDGER_KV_KEY, &ledger_json),
            ],
        )
        .await?;
        guard.snapshot = snapshot.clone();
        guard.ledger = ledger;
        emit_event(&self.emitter, WHALE_BALANCE_UPDATED_EVENT, &snapshot);
        emit_event(&self.emitter, WHALE_BALANCE_DASHBOARD_EVENT, &snapshot);
        Ok(snapshot)
    }
}

fn serialize<T: Serialize>(value: &T, label: &str) -> Result<String, AppCommandError> {
    serde_json::to_string(value)
        .map_err(|error| AppCommandError::io_error(format!("Failed to serialize {label}: {error}")))
}

async fn persist_values(
    db: &DatabaseConnection,
    values: &[(&str, &str)],
) -> Result<(), AppCommandError> {
    let transaction = db
        .begin()
        .await
        .map_err(|error| AppCommandError::db(error.into()))?;
    for (key, value) in values {
        app_metadata_service::upsert_value(&transaction, key, value)
            .await
            .map_err(AppCommandError::db)?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| AppCommandError::db(error.into()))?;
    Ok(())
}

fn migrate_legacy_config(config: &mut WhaleBalanceConfig) {
    if config.models.is_empty() {
        let model = WhaleBalanceModelConfig {
            account_name: config.account_name.clone(),
            url: config.url.clone(),
            method: config.method.clone(),
            auth_header: config.auth_header.clone(),
            api_key: config.api_key.clone(),
            remaining_path: config.remaining_path.clone(),
            used_path: config.used_path.clone(),
            scale: config.scale,
            account_generation: config.account_generation.max(1),
            ..WhaleBalanceModelConfig::default()
        };
        config.models.push(model);
        config.active_model_id = "default".to_string();
    }
    if !config.models.iter().any(|model| model.id == config.active_model_id) {
        config.active_model_id = config.models[0].id.clone();
    }
    if config.currency.trim().is_empty() {
        config.currency = default_currency();
    }
}

fn migrate_legacy_snapshot(snapshot: &mut WhaleBalanceSnapshot, config: &WhaleBalanceConfig) {
    if snapshot.accounts.is_empty() {
        if let Some(model) = config.models.first() {
            let mut account = empty_model_snapshot(model);
            account.balance = snapshot.balance;
            account.used = snapshot.used;
            account.last_success_at = snapshot.last_success_at.clone();
            account.last_attempt_at = snapshot.last_attempt_at.clone();
            account.last_error = snapshot.last_error.clone();
            account.stale = snapshot.stale;
            account.refreshing = false;
            snapshot.accounts.push(account);
        }
    }
}

fn preserve_model_generations(old: &WhaleBalanceConfig, next: &mut WhaleBalanceConfig) {
    for model in &mut next.models {
        if let Some(previous) = old.models.iter().find(|previous| previous.id == model.id) {
            model.account_generation = if previous.signature_differs(model) {
                previous.account_generation.saturating_add(1)
            } else {
                previous.account_generation
            };
        }
    }
}

fn sync_snapshot_config(
    snapshot: &mut WhaleBalanceSnapshot,
    config: &WhaleBalanceConfig,
    ledger: &WhaleBalanceLedger,
) {
    let old_accounts = std::mem::take(&mut snapshot.accounts);
    snapshot.accounts = config
        .models
        .iter()
        .map(|model| {
            old_accounts
                .iter()
                .find(|account| {
                    account.id == model.id
                        && account.account_generation == model.account_generation
                })
                .cloned()
                .unwrap_or_else(|| empty_model_snapshot(model))
        })
        .collect();
    snapshot.enabled = config.enabled;
    snapshot.model_id = config.active_model_id.clone();
    snapshot.account_generation = config
        .models
        .iter()
        .find(|model| model.id == config.active_model_id)
        .map_or(1, |model| model.account_generation);
    snapshot.configured = config.models.iter().any(WhaleBalanceModelConfig::is_configured);
    snapshot.currency = config.currency.clone();
    if let Some(active) = snapshot.accounts.iter().find(|a| a.id == config.active_model_id) {
        snapshot.account_name = active.account_name.clone();
        snapshot.balance = active.balance.map(|balance| {
            balance + ledger.balance_adjustments.get(&active.id).copied().unwrap_or(0.0)
        });
        snapshot.used = active.used;
        snapshot.total = active.total;
        snapshot.unit = active.unit.clone();
        snapshot.last_success_at = active.last_success_at.clone();
        snapshot.last_attempt_at = active.last_attempt_at.clone();
        snapshot.last_error = active.last_error.clone();
        snapshot.stale = active.stale;
        snapshot.refreshing = active.refreshing;
    }
    update_dashboard_fields(snapshot, config, ledger, None);
}

fn settings_view(config: &WhaleBalanceConfig) -> WhaleBalanceSettingsView {
    let active = config
        .models
        .iter()
        .find(|model| model.id == config.active_model_id)
        .or_else(|| config.models.first());
    let active = active.cloned().unwrap_or_default();
    WhaleBalanceSettingsView {
        enabled: config.enabled,
        account_name: active.account_name.clone(),
        url: active.url.clone(),
        method: active.method.clone(),
        auth_header: active.auth_header.clone(),
        has_api_key: !active.api_key.is_empty(),
        api_key_hint: mask_api_key(&active.api_key),
        remaining_path: active.remaining_path.clone(),
        used_path: active.used_path.clone(),
        total_path: active.total_path.clone(),
        unit_path: active.unit_path.clone(),
        scale: active.scale,
        poll_interval_secs: config.poll_interval_secs,
        models: config.models.iter().map(WhaleBalanceModelView::from).collect(),
        active_model_id: config.active_model_id.clone(),
        peak_price: config.peak_price,
        off_peak_price: config.off_peak_price,
        currency: config.currency.clone(),
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct TodayTokenUsage {
    total: i64,
    peak: i64,
    off_peak: i64,
}

fn update_dashboard_fields(
    snapshot: &mut WhaleBalanceSnapshot,
    config: &WhaleBalanceConfig,
    ledger: &WhaleBalanceLedger,
    tokens_today: Option<TodayTokenUsage>,
) {
    let today = Utc::now()
        .with_timezone(&beijing_offset())
        .date_naive()
        .to_string();
    // 今日观测消费只累加“余额下降”事件。充值（余额上升）单独记账，
    // 不会因为余额变大而把当天已观测到的消费冲掉。
    let observed_today = ledger
        .daily_consumption
        .get(&config.active_model_id)
        .and_then(|days| days.get(&today))
        .copied()
        .unwrap_or_else(|| {
            // 老账本（无聚合表）或极早的归档数据回退到明细累加。
            ledger
                .entries
                .iter()
                .filter(|entry| {
                    entry.model_id == config.active_model_id
                        && entry.kind == "consumption"
                        && local_date_for(&entry.at).as_deref() == Some(today.as_str())
                })
                .map(|entry| entry.amount)
                .sum()
        });
    let local_now = Utc::now().with_timezone(&beijing_offset());
    snapshot.is_peak_period = is_peak_instant(local_now.weekday(), local_now.hour());
    snapshot.current_price = if snapshot.is_peak_period {
        config.peak_price
    } else {
        config.off_peak_price
    };
    // 从未成功观测过余额时，今日观测消费无意义，保持空而不是 0。
    snapshot.observed_today = snapshot.balance.map(|_| observed_today);
    snapshot.estimated_cost_today = tokens_today.and_then(|usage| {
        let peak_cost = match (usage.peak, config.peak_price) {
            (0, _) => Some(0.0),
            (_, Some(price)) => Some(price * usage.peak as f64 / 1_000_000.0),
            _ => None,
        }?;
        let off_peak_cost = match (usage.off_peak, config.off_peak_price) {
            (0, _) => Some(0.0),
            (_, Some(price)) => Some(price * usage.off_peak as f64 / 1_000_000.0),
            _ => None,
        }?;
        (usage.total > 0).then_some(peak_cost + off_peak_cost)
    });
}

fn parse_timestamp(value: &str) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

fn local_date_for(value: &str) -> Option<String> {
    parse_timestamp(value).map(|value| {
        value
            .with_timezone(&beijing_offset())
            .date_naive()
            .to_string()
    })
}

/// 北京时间（UTC+8），与 DeepSeek 官方计费时段口径一致。
fn beijing_offset() -> chrono::FixedOffset {
    chrono::FixedOffset::east_opt(8 * 3600).expect("UTC+8 is a valid offset")
}

/// 高峰时段：北京时间工作日 09:00–12:00 与 14:00–18:00，周末全天谷价。
fn is_peak_instant(weekday: chrono::Weekday, hour: u32) -> bool {
    let is_workday = weekday.number_from_monday() <= 5;
    is_workday && ((9..12).contains(&hour) || (14..18).contains(&hour))
}

async fn today_token_count(
    db: &DatabaseConnection,
) -> Result<Option<TodayTokenUsage>, AppCommandError> {
    let utc8 = beijing_offset();
    let day_start = Utc::now()
        .with_timezone(&utc8)
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("valid midnight");
    let start = utc8
        .from_local_datetime(&day_start)
        .single()
        .expect("unambiguous midnight")
        .with_timezone(&Utc);
    let rows = token_usage_turn::Entity::find()
        .filter(token_usage_turn::Column::OccurredAt.gte(start))
        .all(db)
        .await
        .map_err(|error| AppCommandError::db(error.into()))?;
    if rows.is_empty() {
        return Ok(None);
    }
    let mut usage = TodayTokenUsage::default();
    for row in rows {
        usage.total += row.total_tokens;
        let local = row.occurred_at.with_timezone(&utc8);
        if is_peak_instant(local.weekday(), local.hour()) {
            usage.peak += row.total_tokens;
        } else {
            usage.off_peak += row.total_tokens;
        }
    }
    Ok(Some(usage))
}

/// 账本明细上限：超出后丢弃最旧的记录，避免无限增长。
const MAX_LEDGER_ENTRIES: usize = 5_000;
/// 日聚合保留天数：远超“今日”所需，同时限制体积。
const MAX_LEDGER_DAYS: usize = 400;

fn trim_ledger(ledger: &mut WhaleBalanceLedger) {
    if ledger.entries.len() > MAX_LEDGER_ENTRIES {
        let excess = ledger.entries.len() - MAX_LEDGER_ENTRIES;
        ledger.entries.drain(0..excess);
    }
    // 键是 ISO 日期，字典序即时间序。
    for days in ledger.daily_consumption.values_mut() {
        while days.len() > MAX_LEDGER_DAYS {
            let Some(oldest) = days.keys().next().cloned() else {
                break;
            };
            days.remove(&oldest);
        }
    }
}

/// 旧账本首次读取时用明细回填日聚合，避免升级后“今日消费”突然归零。
fn backfill_daily_consumption(ledger: &mut WhaleBalanceLedger) {
    if !ledger.daily_consumption.is_empty() {
        return;
    }
    for entry in &ledger.entries {
        if entry.kind != "consumption" {
            continue;
        }
        if let Some(date) = local_date_for(&entry.at) {
            *ledger
                .daily_consumption
                .entry(entry.model_id.clone())
                .or_default()
                .entry(date)
                .or_insert(0.0) += entry.amount;
        }
    }
}

fn test_failure(message: &str) -> WhaleBalanceTestResult {
    WhaleBalanceTestResult {
        ok: false,
        balance: None,
        used: None,
        total: None,
        unit: None,
        error: Some(message.to_string()),
    }
}

fn normalize_config_input(
    existing: &WhaleBalanceConfig,
    input: UpdateWhaleBalanceSettingsInput,
    strict_required: bool,
) -> Result<WhaleBalanceConfig, AppCommandError> {
    let mut next = existing.clone();
    next.enabled = input.enabled;
    next.poll_interval_secs = input
        .poll_interval_secs
        .unwrap_or(existing.poll_interval_secs)
        .clamp(MIN_POLL_INTERVAL_SECS, MAX_POLL_INTERVAL_SECS);
    if input.clear_peak_price {
        next.peak_price = None;
    } else if let Some(price) = input.peak_price {
        if price.is_some_and(|price| !price.is_finite() || price < 0.0) {
            return Err(AppCommandError::invalid_input("高峰单价必须是非负有限数"));
        }
        next.peak_price = price;
    }
    if input.clear_off_peak_price {
        next.off_peak_price = None;
    } else if let Some(price) = input.off_peak_price {
        if price.is_some_and(|price| !price.is_finite() || price < 0.0) {
            return Err(AppCommandError::invalid_input("低谷单价必须是非负有限数"));
        }
        next.off_peak_price = price;
    }
    if let Some(currency) = input.currency {
        let currency = currency.trim().to_ascii_uppercase();
        if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(AppCommandError::invalid_input("币种必须是三个大写字母"));
        }
        next.currency = currency;
    }

    if let Some(models) = input.models {
        let old_models = next.models.clone();
        let mut updated = Vec::with_capacity(models.len());
        let mut ids = HashSet::new();
        for incoming in models {
            let id = incoming.id.trim().to_string();
            if id.is_empty()
                || id.len() > 64
                || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                || !ids.insert(id.clone())
            {
                return Err(AppCommandError::invalid_input("模型 ID 无效或重复"));
            }
            let old = old_models.iter().find(|model| model.id == id);
            let mut model = old.cloned().unwrap_or_else(|| WhaleBalanceModelConfig {
                id: id.clone(),
                ..WhaleBalanceModelConfig::default()
            });
            model.id = id;
            model.account_name = incoming.account_name.trim().to_string();
            model.url = incoming.url.trim().to_string();
            if !model.url.is_empty() {
                assert_safe_balance_url(&model.url)?;
            }
            model.method = incoming
                .method
                .as_deref()
                .map(str::trim)
                .filter(|method| !method.is_empty())
                .map(str::to_ascii_uppercase)
                .unwrap_or_else(|| model.method.clone());
            if model.method != "GET" && model.method != "POST" {
                return Err(AppCommandError::invalid_input("请求方法仅支持 GET 或 POST"));
            }
            model.auth_header = incoming
                .auth_header
                .as_deref()
                .map(str::trim)
                .filter(|header| !header.is_empty())
                .unwrap_or(&model.auth_header)
                .to_string();
            if incoming.clear_api_key {
                model.api_key.clear();
            } else if let Some(key) = incoming.api_key.filter(|key| !key.trim().is_empty()) {
                model.api_key = key.trim().to_string();
            }
            model.remaining_path = incoming
                .remaining_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .unwrap_or(DEFAULT_REMAINING_PATH)
                .to_string();
            model.used_path = incoming
                .used_path
                .as_deref()
                .map(str::trim)
                .unwrap_or(DEFAULT_USED_PATH)
                .to_string();
            model.total_path = incoming.total_path.unwrap_or(model.total_path).trim().to_string();
            model.unit_path = incoming.unit_path.unwrap_or(model.unit_path).trim().to_string();
            model.scale = incoming.scale.unwrap_or(model.scale);
            if !model.scale.is_finite() || model.scale <= 0.0 {
                return Err(AppCommandError::invalid_input("数值倍率必须是大于 0 的有限数"));
            }
            model.account_generation = old.map_or(1, |old| old.account_generation);
            updated.push(model);
        }
        if updated.is_empty() && strict_required && next.enabled {
            return Err(AppCommandError::invalid_input("启用小鲸鱼余额挂件时至少需要一个模型"));
        }
        next.models = updated;
    } else {
        let model_id = existing.active_model_id.clone();
        let mut model = existing
            .models
            .iter()
            .find(|model| model.id == model_id)
            .cloned()
            .unwrap_or_else(|| WhaleBalanceModelConfig {
                id: model_id.clone(),
                ..WhaleBalanceModelConfig::default()
            });
        model.account_name = input.account_name.trim().to_string();
        model.url = input.url.trim().to_string();
        if !model.url.is_empty() {
            assert_safe_balance_url(&model.url)?;
        }
        model.method = input
            .method
            .as_deref()
            .map(str::trim)
            .filter(|method| !method.is_empty())
            .map(str::to_ascii_uppercase)
            .unwrap_or_else(|| model.method.clone());
        if model.method != "GET" && model.method != "POST" {
            return Err(AppCommandError::invalid_input("请求方法仅支持 GET 或 POST"));
        }
        model.auth_header = input
            .auth_header
            .as_deref()
            .map(str::trim)
            .filter(|header| !header.is_empty())
            .unwrap_or(&model.auth_header)
            .to_string();
        if input.clear_api_key {
            model.api_key.clear();
        } else if let Some(key) = input.api_key.filter(|key| !key.trim().is_empty()) {
            model.api_key = key.trim().to_string();
        }
        model.remaining_path = input
            .remaining_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .unwrap_or(DEFAULT_REMAINING_PATH)
            .to_string();
        model.used_path = input
            .used_path
            .as_deref()
            .map(str::trim)
            .unwrap_or(DEFAULT_USED_PATH)
            .to_string();
        model.scale = input.scale.unwrap_or(model.scale);
        if !model.scale.is_finite() || model.scale <= 0.0 {
            return Err(AppCommandError::invalid_input("数值倍率必须是大于 0 的有限数"));
        }
        if existing.models.iter().all(|old| old.id != model.id) {
            next.models.push(model);
        } else if let Some(saved) = next.models.iter_mut().find(|old| old.id == model.id) {
            *saved = model;
        }
    }

    next.active_model_id = input
        .active_model_id
        .filter(|id| next.models.iter().any(|model| &model.id == id))
        .unwrap_or_else(|| {
            if next.models.iter().any(|model| model.id == next.active_model_id) {
                next.active_model_id.clone()
            } else {
                next.models.first().map_or_else(String::new, |model| model.id.clone())
            }
        });
    let selected = next.models.iter().find(|model| model.id == next.active_model_id);
    if let Some(model) = selected {
        next.account_name = model.account_name.clone();
        next.url = model.url.clone();
        next.method = model.method.clone();
        next.auth_header = model.auth_header.clone();
        next.api_key = model.api_key.clone();
        next.remaining_path = model.remaining_path.clone();
        next.used_path = model.used_path.clone();
        next.scale = model.scale;
        next.account_generation = model.account_generation;
    }
    if strict_required && next.enabled && !selected.is_some_and(WhaleBalanceModelConfig::is_configured) {
        return Err(AppCommandError::invalid_input(
            "启用小鲸鱼余额挂件时，当前模型必须配置接口地址和余额字段路径",
        ));
    }
    Ok(next)
}

/// 独立后台轮询，桌面和 server 两种运行时共用。
pub async fn run_whale_balance_poller(service: std::sync::Arc<WhaleBalanceService>) {
    tokio::time::sleep(Duration::from_secs(2)).await;
    loop {
        service.poll_if_due().await;
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

/// 在当前 Tokio 运行时上下文中启动后台轮询任务。
pub fn spawn_whale_balance_poller(service: std::sync::Arc<WhaleBalanceService>) {
    tokio::spawn(run_whale_balance_poller(service));
}

/// URL 安全校验：仅允许 http/https，禁止 userinfo、云元数据地址和 link-local 地址。
pub fn assert_safe_balance_url(raw: &str) -> Result<(), AppCommandError> {
    let parsed = Url::parse(raw)
        .map_err(|_| AppCommandError::invalid_input("无效的余额接口地址"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(AppCommandError::invalid_input(format!(
            "不支持的协议: {scheme}"
        )));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(AppCommandError::invalid_input(
            "接口地址不允许携带用户名或密码",
        ));
    }
    let Some(host_raw) = parsed.host_str() else {
        return Err(AppCommandError::invalid_input("接口地址缺少主机名"));
    };
    let host = host_raw.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "metadata.google.internal"
        || host == "metadata.goog"
        || host == "100.100.100.200"
    {
        return Err(AppCommandError::invalid_input("禁止访问云元数据地址"));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(v4) => {
                let oct = v4.octets();
                if (oct[0] == 169 && oct[1] == 254) || oct[0] == 0 {
                    return Err(AppCommandError::invalid_input("禁止访问该 IP 地址段"));
                }
            }
            IpAddr::V6(v6) => {
                let seg = v6.segments()[0];
                if (seg & 0xffc0) == 0xfe80 {
                    return Err(AppCommandError::invalid_input("禁止访问 link-local 地址"));
                }
            }
        }
    }
    Ok(())
}

/// 解析类似 DSH 的 `auth` 配置：`Bearer {key}` 或分号分隔 `Header: value` 列表。
pub fn build_auth_headers(auth_tpl: &str, api_key: &str) -> HeaderMap {
    let mut out = HeaderMap::new();
    let deny: HashSet<&'static str> = [
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
        "te",
        "upgrade",
        "cookie",
        "proxy-authorization",
        "proxy-connection",
        "keep-alive",
    ]
    .into_iter()
    .collect();

    let raw = if auth_tpl.trim().is_empty() {
        DEFAULT_AUTH_HEADER
    } else {
        auth_tpl
    };
    let clipped = &raw[..raw.len().min(2000)];

    let mut count = 0usize;
    for seg in clipped.split(';') {
        let s = seg.trim();
        if s.is_empty() {
            continue;
        }
        let (name_str, val_raw) = match s.find(':') {
            Some(0) => continue,
            Some(idx) => (s[..idx].trim(), s[idx + 1..].trim()),
            None => ("Authorization", s),
        };
        if name_str.is_empty() || name_str.len() > 64 {
            continue;
        }
        if deny.contains(&name_str.to_ascii_lowercase().as_str()) {
            continue;
        }
        let replaced = val_raw
            .replace(['\r', '\n'], " ")
            .replace("{key}", api_key);
        if replaced.trim().is_empty() {
            continue;
        }
        if let (Ok(hname), Ok(hval)) = (
            HeaderName::from_bytes(name_str.as_bytes()),
            HeaderValue::from_str(replaced.trim()),
        ) {
            if !out.contains_key(&hname) && count >= 10 {
                continue;
            }
            out.insert(hname, hval);
            count += 1;
        }
    }
    out
}

/// 解析路径如 `balance`、`api_key_quota.used`、`balance_infos[0].total_balance`。
pub fn pick_json_path<'a>(root: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.replace('[', ".").replace(']', "");
    let mut cur = root;
    for part in normalized.split('.').filter(|p| !p.is_empty()) {
        if let Ok(idx) = part.parse::<usize>() {
            match cur {
                serde_json::Value::Array(arr) => {
                    cur = arr.get(idx)?;
                }
                serde_json::Value::Object(map) => {
                    cur = map.get(part)?;
                }
                _ => return None,
            }
        } else {
            cur = cur.as_object()?.get(part)?;
        }
    }
    Some(cur)
}

fn parse_scaled_number(val: &serde_json::Value, scale: f64) -> Option<f64> {
    let raw = match val {
        serde_json::Value::Number(n) => n.as_f64()?,
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !raw.is_finite() {
        return None;
    }
    let scaled = raw * scale;
    if scaled.is_finite() {
        Some(scaled)
    } else {
        None
    }
}

fn sanitize_error_message(msg: &str, api_key: &str) -> String {
    let mut clean = msg.to_string();
    if !api_key.trim().is_empty() {
        clean = clean.replace(api_key.trim(), "[REDACTED]");
    }
    clean.chars().take(180).collect()
}

fn mask_api_key(key: &str) -> Option<String> {
    let k = key.trim();
    if k.is_empty() {
        return None;
    }
    let chars: Vec<char> = k.chars().collect();
    if chars.len() <= 8 {
        return Some("****".to_string());
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    Some(format!("{head}****{tail}"))
}

#[derive(Debug, Clone)]
struct BalanceReading {
    balance: f64,
    used: Option<f64>,
    total: Option<f64>,
    unit: Option<String>,
}

async fn fetch_balance_once(
    client: &reqwest::Client,
    config: &WhaleBalanceModelConfig,
) -> Result<BalanceReading, String> {
    assert_safe_balance_url(&config.url).map_err(|e| e.to_string())?;
    let target_url = config.url.replace("{key}", config.api_key.trim());
    assert_safe_balance_url(&target_url).map_err(|e| e.to_string())?;

    if config.auth_header.contains("{key}") && config.api_key.trim().is_empty() {
        return Err("未配置 API 密钥".to_string());
    }

    let headers = build_auth_headers(&config.auth_header, config.api_key.trim());
    let mut req = if config.method == "POST" {
        client
            .post(&target_url)
            .header(CONTENT_TYPE, "application/json")
            .body("{}")
    } else {
        client.get(&target_url)
    };
    req = req.headers(headers);

    let resp = req
        .send()
        .await
        .map_err(|e| sanitize_error_message(&format!("余额接口请求失败: {e}"), &config.api_key))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("余额接口返回 HTTP {}", status.as_u16()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| sanitize_error_message(&format!("响应不是有效 JSON: {e}"), &config.api_key))?;

    let balance = pick_json_path(&body, &config.remaining_path)
        .and_then(|value| parse_scaled_number(value, config.scale))
        .ok_or_else(|| format!("返回 JSON 中未找到有效余额字段（路径: {}）", config.remaining_path))?;
    let used = read_optional_number(&body, &config.used_path, config.scale);
    let total = read_optional_number(&body, &config.total_path, config.scale);
    let unit = if config.unit_path.trim().is_empty() {
        None
    } else {
        pick_json_path(&body, &config.unit_path)
            .and_then(serde_json::Value::as_str)
            .map(|value| value.chars().take(24).collect())
    };
    Ok(BalanceReading {
        balance,
        used,
        total,
        unit,
    })
}

fn read_optional_number(root: &serde_json::Value, path: &str, scale: f64) -> Option<f64> {
    if path.trim().is_empty() {
        return None;
    }
    pick_json_path(root, path).and_then(|value| parse_scaled_number(value, scale))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::net::TcpListener;

    #[test]
    fn test_pick_json_path_and_lk888_shape() {
        let payload = json!({
            "balance": 3203.13,
            "unit": "算力",
            "api_key_quota": {
                "limit": 0,
                "used": 3006.36
            }
        });
        assert_eq!(
            pick_json_path(&payload, "balance").and_then(|v| parse_scaled_number(v, 1.0)),
            Some(3203.13)
        );
        assert_eq!(
            pick_json_path(&payload, "api_key_quota.used").and_then(|v| parse_scaled_number(v, 1.0)),
            Some(3006.36)
        );
    }

    #[test]
    fn legacy_config_migration_preserves_single_account_and_secret() {
        let raw = serde_json::json!({
            "enabled": true,
            "accountName": "legacy",
            "url": "https://api.example.com/balance",
            "method": "GET",
            "authHeader": "Bearer {key}",
            "apiKey": "private-token",
            "remainingPath": "balance",
            "usedPath": "usage",
            "scale": 0.01,
            "pollIntervalSecs": 45,
            "accountGeneration": 7
        });
        let mut config: WhaleBalanceConfig = serde_json::from_value(raw).unwrap();
        migrate_legacy_config(&mut config);
        assert_eq!(config.models.len(), 1);
        assert_eq!(config.models[0].id, "default");
        assert_eq!(config.models[0].api_key, "private-token");
        assert_eq!(config.models[0].account_generation, 7);
        // 脱敏只保留前 4 位与后 4 位，中间固定四个星号。
        assert_eq!(
            settings_view(&config).api_key_hint.as_deref(),
            Some("priv****oken")
        );
    }

    #[test]
    fn model_generation_invalidates_only_changed_account_snapshot() {
        let mut old = WhaleBalanceConfig::default();
        migrate_legacy_config(&mut old);
        let second = WhaleBalanceModelConfig {
            id: "second".to_string(),
            account_name: "second".to_string(),
            ..old.models[0].clone()
        };
        old.models.push(second);
        let mut next = old.clone();
        next.models[1].url = "https://other.example.com/balance".to_string();
        preserve_model_generations(&old, &mut next);
        assert_eq!(next.models[0].account_generation, old.models[0].account_generation);
        assert_eq!(next.models[1].account_generation, old.models[1].account_generation + 1);
    }

    #[test]
    fn dashboard_cost_uses_tokens_per_million_and_utc8_peak_window() {
        let mut config = WhaleBalanceConfig::default();
        migrate_legacy_config(&mut config);
        config.peak_price = Some(2.0);
        config.off_peak_price = Some(1.0);
        let mut snapshot = WhaleBalanceSnapshot::empty_from_config(&config);
        snapshot.balance = Some(10.0);
        let ledger = WhaleBalanceLedger::default();
        update_dashboard_fields(
            &mut snapshot,
            &config,
            &ledger,
            Some(TodayTokenUsage {
                total: 500_000,
                peak: 250_000,
                off_peak: 250_000,
            }),
        );
        assert_eq!(snapshot.estimated_cost_today, Some(0.75));
        // 余额为 Some 时，今日观测消费是真实值 0.0（当日尚无下降记录），不是缺数。
        assert_eq!(snapshot.observed_today, Some(0.0));
        update_dashboard_fields(
            &mut snapshot,
            &config,
            &ledger,
            Some(TodayTokenUsage {
                total: 500_000,
                peak: 500_000,
                off_peak: 0,
            }),
        );
        assert!(snapshot.estimated_cost_today.is_some());
    }

    #[test]
    fn peak_window_matches_deepseek_workday_hours() {
        use chrono::Weekday;
        // 工作日高峰：09–12、14–18。
        assert!(is_peak_instant(Weekday::Mon, 9));
        assert!(is_peak_instant(Weekday::Fri, 11));
        assert!(is_peak_instant(Weekday::Tue, 14));
        assert!(is_peak_instant(Weekday::Wed, 17));
        // 工作日非高峰。
        assert!(!is_peak_instant(Weekday::Mon, 8));
        assert!(!is_peak_instant(Weekday::Mon, 12));
        assert!(!is_peak_instant(Weekday::Mon, 13));
        assert!(!is_peak_instant(Weekday::Thu, 18));
        assert!(!is_peak_instant(Weekday::Thu, 21));
        // 周末全天谷价。
        assert!(!is_peak_instant(Weekday::Sat, 10));
        assert!(!is_peak_instant(Weekday::Sun, 15));
    }

    #[test]
    fn observed_today_survives_a_top_up() {
        let mut config = WhaleBalanceConfig::default();
        migrate_legacy_config(&mut config);
        let today = Utc::now().with_timezone(&beijing_offset()).to_rfc3339();
        let model_id = config.active_model_id.clone();
        let mut ledger = WhaleBalanceLedger::default();
        ledger.entries.push(WhaleBalanceLedgerEntry {
            model_id: model_id.clone(),
            at: today.clone(),
            kind: "consumption".to_string(),
            amount: 3.5,
            note: None,
        });
        // 充值也单独记录，但不得抵消上面的消费。
        ledger.entries.push(WhaleBalanceLedgerEntry {
            model_id,
            at: today,
            kind: "balance_increase".to_string(),
            amount: 100.0,
            note: None,
        });
        let mut snapshot = WhaleBalanceSnapshot::empty_from_config(&config);
        snapshot.balance = Some(500.0);
        update_dashboard_fields(&mut snapshot, &config, &ledger, None);
        assert_eq!(snapshot.observed_today, Some(3.5));
    }

    #[test]
    fn daily_consumption_survives_ledger_trimming() {
        let mut config = WhaleBalanceConfig::default();
        migrate_legacy_config(&mut config);
        let model = config.active_model_id.clone();
        let today = Utc::now()
            .with_timezone(&beijing_offset())
            .date_naive()
            .to_string();
        let mut ledger = WhaleBalanceLedger::default();
        *ledger
            .daily_consumption
            .entry(model.clone())
            .or_default()
            .entry(today)
            .or_insert(0.0) += 7.25;
        // 明细持续增长后被裁剪，也不得影响当天已累计的消费。
        for _ in 0..(MAX_LEDGER_ENTRIES + 10) {
            ledger.entries.push(WhaleBalanceLedgerEntry {
                model_id: model.clone(),
                at: Utc::now().to_rfc3339(),
                kind: "balance_increase".to_string(),
                amount: 1.0,
                note: None,
            });
        }
        trim_ledger(&mut ledger);
        assert_eq!(ledger.entries.len(), MAX_LEDGER_ENTRIES);

        let mut snapshot = WhaleBalanceSnapshot::empty_from_config(&config);
        snapshot.balance = Some(100.0);
        update_dashboard_fields(&mut snapshot, &config, &ledger, None);
        assert_eq!(snapshot.observed_today, Some(7.25));
    }

    #[test]
    fn daily_consumption_is_scoped_per_model() {
        let mut config = WhaleBalanceConfig::default();
        migrate_legacy_config(&mut config);
        let today = Utc::now()
            .with_timezone(&beijing_offset())
            .date_naive()
            .to_string();
        let mut ledger = WhaleBalanceLedger::default();
        let mut other = config.models[0].clone();
        other.id = "other".to_string();
        config.models.push(other);

        *ledger
            .daily_consumption
            .entry(config.models[0].id.clone())
            .or_default()
            .entry(today.clone())
            .or_insert(0.0) += 3.0;
        *ledger
            .daily_consumption
            .entry("other".to_string())
            .or_default()
            .entry(today)
            .or_insert(0.0) += 9.0;

        let mut snapshot = WhaleBalanceSnapshot::empty_from_config(&config);
        snapshot.balance = Some(50.0);
        update_dashboard_fields(&mut snapshot, &config, &ledger, None);
        // 只统计当前选中模型的消耗，不能把其他模型算进来。
        assert_eq!(snapshot.observed_today, Some(3.0));
    }

    #[test]
    fn backfill_rebuilds_daily_consumption_from_entries() {
        let mut ledger = WhaleBalanceLedger::default();
        let today = Utc::now().to_rfc3339();
        ledger.entries.push(WhaleBalanceLedgerEntry {
            model_id: "default".to_string(),
            at: today.clone(),
            kind: "consumption".to_string(),
            amount: 2.5,
            note: None,
        });
        ledger.entries.push(WhaleBalanceLedgerEntry {
            model_id: "default".to_string(),
            at: today,
            kind: "reconciliation".to_string(),
            amount: 5.0,
            note: None,
        });
        backfill_daily_consumption(&mut ledger);

        let date = Utc::now()
            .with_timezone(&beijing_offset())
            .date_naive()
            .to_string();
        // 只回填消费，校正不计入消耗。
        assert_eq!(
            ledger
                .daily_consumption
                .get("default")
                .and_then(|days| days.get(&date))
                .copied(),
            Some(2.5)
        );
    }

    #[test]
    fn ledger_entries_are_capped() {
        let mut ledger = WhaleBalanceLedger::default();
        for index in 0..(MAX_LEDGER_ENTRIES + 25) {
            ledger.entries.push(WhaleBalanceLedgerEntry {
                model_id: "default".to_string(),
                at: Utc::now().to_rfc3339(),
                kind: "consumption".to_string(),
                amount: index as f64,
                note: None,
            });
        }
        trim_ledger(&mut ledger);
        assert_eq!(ledger.entries.len(), MAX_LEDGER_ENTRIES);
        // 保留的是最新的记录。
        assert_eq!(
            ledger.entries.last().map(|entry| entry.amount),
            Some((MAX_LEDGER_ENTRIES + 24) as f64)
        );
    }

    #[test]
    fn test_pick_json_path_array_and_zero() {
        let payload = json!({
            "balance_infos": [{ "total_balance": "0.00" }],
            "used": 0
        });
        assert_eq!(
            pick_json_path(&payload, "balance_infos[0].total_balance")
                .and_then(|v| parse_scaled_number(v, 1.0)),
            Some(0.0)
        );
        assert_eq!(
            pick_json_path(&payload, "used").and_then(|v| parse_scaled_number(v, 1.0)),
            Some(0.0)
        );
    }

    #[test]
    fn test_url_safety_and_header_filtering() {
        assert!(assert_safe_balance_url("https://api.lk888.ai/v1/skills/balance").is_ok());
        assert!(assert_safe_balance_url("http://169.254.169.254/latest/meta-data").is_err());
        let userinfo_url = format!("{}//{}@{}/balance", "https:", "alice:pw", "api.lk888.ai");
        assert!(assert_safe_balance_url(&userinfo_url).is_err());

        let headers = build_auth_headers(
            "x-api-key:{key};Host:evil.com;Cookie:a=b;x-extra:1",
            "demo-token-1234",
        );
        assert_eq!(headers.get("x-api-key").unwrap(), "demo-token-1234");
        assert_eq!(headers.get("x-extra").unwrap(), "1");
        assert!(headers.get("host").is_none());
        assert!(headers.get("cookie").is_none());
    }

    #[tokio::test]
    async fn test_service_lifecycle_zero_failure_retention_and_account_switch() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let emitter = EventEmitter::Noop;
        let service = WhaleBalanceService::new(db.conn.clone(), emitter);

        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_route = calls.clone();
        let app = Router::new()
            .route(
                "/balance",
                get(move || {
                    let count = calls_for_route.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if count == 0 {
                            (
                                axum::http::StatusCode::OK,
                                Json(json!({ "balance": 0.0, "api_key_quota": { "used": 12.5 } })),
                            )
                        } else {
                            (
                                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                                Json(json!({ "error": "boom" })),
                            )
                        }
                    }
                }),
            )
            .route(
                "/account2",
                get(|| async {
                    Json(json!({ "balance": 88.25, "api_key_quota": { "used": 1.75 } }))
                }),
            );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        // 1. 首次查询返回真实 0.00，且设置视图脱敏不暴露明文密钥。
        let view = service
            .update_settings(UpdateWhaleBalanceSettingsInput {
                enabled: true,
                account_name: "lk888".to_string(),
                url: format!("http://{addr}/balance"),
                method: None,
            auth_header: None,
            api_key: Some(["demo", "key", "9876"].join("-")),
            clear_api_key: false,
            remaining_path: None,
            used_path: None,
            scale: None,
            poll_interval_secs: None,
            models: None,
            active_model_id: None,
            peak_price: None,
            clear_peak_price: false,
            off_peak_price: None,
            clear_off_peak_price: false,
            currency: None,
        })
            .await
            .unwrap();
        assert!(view.has_api_key);
        assert_eq!(view.api_key_hint.as_deref(), Some("demo****9876"));

        let snap1 = service.get_state().await.unwrap();
        assert_eq!(snap1.balance, Some(0.0));
        assert_eq!(snap1.used, Some(12.5));
        assert!(!snap1.stale);
        assert!(snap1.last_success_at.is_some());

        // 2. 第二次查询失败时沿用上次成功读数 0.00 和更新时间，标记 stale=true。
        // 测试中跳过手动刷新防抖冷却，直接触发第二次远端请求。
        let snap2 = service.refresh_internal(true).await.unwrap();
        assert_eq!(snap2.balance, Some(0.0));
        assert_eq!(snap2.used, Some(12.5));
        assert!(snap2.stale);
        assert_eq!(snap2.last_success_at, snap1.last_success_at);
        assert!(snap2.last_error.is_some());

        // 3. 切换账户配置后，旧账户读数被清空并切换到新账户读数。
        service
            .update_settings(UpdateWhaleBalanceSettingsInput {
                enabled: true,
                account_name: "acct-2".to_string(),
                url: format!("http://{addr}/account2"),
                method: None,
                auth_header: None,
                api_key: None, // 保留旧密钥
                clear_api_key: false,
                remaining_path: None,
                used_path: None,
                scale: None,
                poll_interval_secs: None,
                models: None,
                active_model_id: None,
                peak_price: None,
                clear_peak_price: false,
                off_peak_price: None,
                clear_off_peak_price: false,
                currency: None,
            })
            .await
            .unwrap();
        let snap3 = service.get_state().await.unwrap();
        assert_eq!(snap3.account_name, "acct-2");
        assert_eq!(snap3.balance, Some(88.25));
        assert_eq!(snap3.used, Some(1.75));
        assert!(!snap3.stale);
        assert!(snap3.account_generation > snap1.account_generation);
    }

    #[tokio::test]
    async fn presentation_defaults_and_round_trips_through_storage() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let service = WhaleBalanceService::new(db.conn.clone(), EventEmitter::Noop);

        // 默认：余额与接口已用可见，今日观测与估算费用不默认显示。
        let defaults = service.get_presentation().await.unwrap();
        assert!(defaults.show_balance);
        assert!(defaults.show_api_used);
        assert!(!defaults.show_observed_today);
        assert!(!defaults.show_token_cost);

        let saved = service
            .save_presentation(WhaleBalancePresentationInput {
                show_balance: true,
                show_api_used: false,
                show_observed_today: true,
                show_token_cost: true,
                // 超出范围的值必须被夹紧，避免前端拿到非法尺寸。
                widget_size: 200,
            })
            .await
            .unwrap();
        assert!(!saved.show_api_used);
        assert!(saved.show_observed_today);
        assert_eq!(saved.widget_size, 96);

        // 重新加载服务后仍然保留（走 KV，不是内存）。
        let reloaded = WhaleBalanceService::new(db.conn.clone(), EventEmitter::Noop);
        let persisted = reloaded.get_presentation().await.unwrap();
        assert_eq!(persisted, saved);
    }

    #[tokio::test]
    async fn multiple_models_keep_separate_keys_and_active_selection() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let service = WhaleBalanceService::new(db.conn.clone(), EventEmitter::Noop);

        let view = service
            .update_settings(UpdateWhaleBalanceSettingsInput {
                enabled: true,
                account_name: String::new(),
                url: String::new(),
                method: None,
                auth_header: None,
                api_key: None,
                clear_api_key: false,
                remaining_path: None,
                used_path: None,
                scale: None,
                poll_interval_secs: None,
                models: Some(vec![
                    WhaleBalanceModelInput {
                        id: "main".to_string(),
                        account_name: "Main".to_string(),
                        url: "https://api.example.com/balance".to_string(),
                        method: None,
                        auth_header: None,
                        api_key: Some("main-secret-key".to_string()),
                        clear_api_key: false,
                        remaining_path: Some("balance".to_string()),
                        used_path: None,
                        total_path: None,
                        unit_path: None,
                        scale: Some(0.01),
                    },
                    WhaleBalanceModelInput {
                        id: "backup".to_string(),
                        account_name: "Backup".to_string(),
                        url: "https://api.example.com/other".to_string(),
                        method: None,
                        auth_header: None,
                        api_key: Some("backup-secret-key".to_string()),
                        clear_api_key: false,
                        remaining_path: Some("data.balance".to_string()),
                        used_path: None,
                        total_path: None,
                        unit_path: None,
                        scale: Some(1.0),
                    },
                ]),
                active_model_id: Some("backup".to_string()),
                peak_price: Some(Some(2.0)),
                clear_peak_price: false,
                off_peak_price: Some(Some(1.0)),
                clear_off_peak_price: false,
                currency: Some("cny".to_string()),
            })
            .await
            .unwrap();

        assert_eq!(view.active_model_id, "backup");
        assert_eq!(view.models.len(), 2);
        // 币种统一大写，价格可选保存。
        assert_eq!(view.currency, "CNY");
        assert_eq!(view.peak_price, Some(2.0));

        // 每个模型各自持有密钥，且视图只暴露脱敏提示。
        let main = view.models.iter().find(|m| m.id == "main").unwrap();
        let backup = view.models.iter().find(|m| m.id == "backup").unwrap();
        assert!(main.has_api_key);
        assert!(backup.has_api_key);
        assert_ne!(main.api_key_hint, backup.api_key_hint);
        // 当前模型视图与当前选中模型一致。
        assert_eq!(view.remaining_path, "data.balance");
        assert_eq!(view.scale, 1.0);
    }
}
