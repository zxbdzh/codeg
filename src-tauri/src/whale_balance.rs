use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::Utc;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};
use url::Url;

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter};

const CONFIG_KV_KEY: &str = "whale_balance.config";
const SNAPSHOT_KV_KEY: &str = "whale_balance.snapshot";
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

/// 后端持久化的完整余额查询配置（包含仅后端持有的凭据）。
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
    /// 每次账户或查询目标改变时递增，用来丢弃在途的旧账户请求结果。
    pub account_generation: u64,
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
        }
    }
}

impl WhaleBalanceConfig {
    pub fn is_configured(&self) -> bool {
        !self.url.trim().is_empty() && !self.remaining_path.trim().is_empty()
    }

    fn account_signature_differs(&self, other: &Self) -> bool {
        self.account_name != other.account_name
            || self.url != other.url
            || self.method != other.method
            || self.auth_header != other.auth_header
            || self.api_key != other.api_key
            || self.remaining_path != other.remaining_path
            || self.used_path != other.used_path
            || (self.scale - other.scale).abs() > f64::EPSILON
    }
}

/// 返回给前端展示的小鲸鱼余额状态（仅含显示字段，绝不带密钥）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceSnapshot {
    pub configured: bool,
    pub enabled: bool,
    pub account_name: String,
    /// None 表示尚未成功获取过读数（前端显示「—」）；Some(0.0) 表示真实零余额。
    pub balance: Option<f64>,
    pub used: Option<f64>,
    pub last_success_at: Option<String>,
    pub last_attempt_at: Option<String>,
    pub last_error: Option<String>,
    /// 最近一次查询失败且保留了上次成功读数时为 true。
    pub stale: bool,
    pub refreshing: bool,
    pub account_generation: u64,
}

impl WhaleBalanceSnapshot {
    pub fn empty_from_config(config: &WhaleBalanceConfig) -> Self {
        Self {
            configured: config.is_configured(),
            enabled: config.enabled,
            account_name: config.account_name.clone(),
            balance: None,
            used: None,
            last_success_at: None,
            last_attempt_at: None,
            last_error: None,
            stale: false,
            refreshing: false,
            account_generation: config.account_generation,
        }
    }
}

/// 返回给设置页的脱敏配置视图：前端只能感知是否已存密钥和脱敏尾号。
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
    pub scale: f64,
    pub poll_interval_secs: u64,
}

impl From<&WhaleBalanceConfig> for WhaleBalanceSettingsView {
    fn from(cfg: &WhaleBalanceConfig) -> Self {
        Self {
            enabled: cfg.enabled,
            account_name: cfg.account_name.clone(),
            url: cfg.url.clone(),
            method: cfg.method.clone(),
            auth_header: cfg.auth_header.clone(),
            has_api_key: !cfg.api_key.is_empty(),
            api_key_hint: mask_api_key(&cfg.api_key),
            remaining_path: cfg.remaining_path.clone(),
            used_path: cfg.used_path.clone(),
            scale: cfg.scale,
            poll_interval_secs: cfg.poll_interval_secs,
        }
    }
}

/// 设置页提交或测试连接时的输入载荷。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWhaleBalanceSettingsInput {
    pub enabled: bool,
    pub account_name: String,
    pub url: String,
    pub method: Option<String>,
    pub auth_header: Option<String>,
    /// None 或空串且 clear_api_key=false 时继续使用后端已存密钥。
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
    pub remaining_path: Option<String>,
    pub used_path: Option<String>,
    pub scale: Option<f64>,
    pub poll_interval_secs: Option<u64>,
}

/// 设置页「测试连接」的即时结果。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WhaleBalanceTestResult {
    pub ok: bool,
    pub balance: Option<f64>,
    pub used: Option<f64>,
    pub error: Option<String>,
}

struct ServiceInner {
    loaded: bool,
    config: WhaleBalanceConfig,
    snapshot: WhaleBalanceSnapshot,
    last_polled_at: Option<Instant>,
}

pub struct WhaleBalanceService {
    db: DatabaseConnection,
    emitter: EventEmitter,
    client: reqwest::Client,
    inner: RwLock<ServiceInner>,
    refresh_lock: Mutex<()>,
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
                last_polled_at: None,
            }),
            refresh_lock: Mutex::new(()),
        }
    }

    /// 首次使用时从数据库恢复配置与上次成功读数快照。
    async fn ensure_loaded(&self) -> Result<(), AppCommandError> {
        {
            let guard = self.inner.read().await;
            if guard.loaded {
                return Ok(());
            }
        }
        let mut guard = self.inner.write().await;
        if guard.loaded {
            return Ok(());
        }

        let cfg_raw = app_metadata_service::get_value(&self.db, CONFIG_KV_KEY)
            .await
            .map_err(AppCommandError::db)?;
        let config = match cfg_raw {
            Some(s) => serde_json::from_str::<WhaleBalanceConfig>(&s).unwrap_or_default(),
            None => WhaleBalanceConfig::default(),
        };

        let snap_raw = app_metadata_service::get_value(&self.db, SNAPSHOT_KV_KEY)
            .await
            .map_err(AppCommandError::db)?;
        let mut snapshot = match snap_raw {
            Some(s) => serde_json::from_str::<WhaleBalanceSnapshot>(&s)
                .unwrap_or_else(|_| WhaleBalanceSnapshot::empty_from_config(&config)),
            None => WhaleBalanceSnapshot::empty_from_config(&config),
        };

        // 如果快照属于旧一代账户，直接丢弃，防止冷启动后残留旧账户数据。
        if snapshot.account_generation != config.account_generation {
            snapshot = WhaleBalanceSnapshot::empty_from_config(&config);
        } else {
            snapshot.configured = config.is_configured();
            snapshot.enabled = config.enabled;
            snapshot.account_name = config.account_name.clone();
            snapshot.refreshing = false;
        }

        guard.config = config;
        guard.snapshot = snapshot;
        guard.loaded = true;
        Ok(())
    }

    pub async fn get_settings(&self) -> Result<WhaleBalanceSettingsView, AppCommandError> {
        self.ensure_loaded().await?;
        let guard = self.inner.read().await;
        Ok(WhaleBalanceSettingsView::from(&guard.config))
    }

    pub async fn get_state(&self) -> Result<WhaleBalanceSnapshot, AppCommandError> {
        self.ensure_loaded().await?;
        let guard = self.inner.read().await;
        Ok(guard.snapshot.clone())
    }

    pub async fn update_settings(
        &self,
        input: UpdateWhaleBalanceSettingsInput,
    ) -> Result<WhaleBalanceSettingsView, AppCommandError> {
        self.ensure_loaded().await?;
        let next_config = {
            let guard = self.inner.read().await;
            normalize_config_input(&guard.config, input, true)?
        };

        let (account_changed, snapshot_to_emit) = {
            let mut guard = self.inner.write().await;
            let account_changed = guard.config.account_signature_differs(&next_config);
            let mut merged = next_config;
            if account_changed {
                merged.account_generation = guard.config.account_generation.saturating_add(1);
                guard.snapshot = WhaleBalanceSnapshot::empty_from_config(&merged);
                guard.last_polled_at = None;
            } else {
                merged.account_generation = guard.config.account_generation;
                guard.snapshot.configured = merged.is_configured();
                guard.snapshot.enabled = merged.enabled;
                guard.snapshot.account_name = merged.account_name.clone();
            }
            guard.config = merged;
            (account_changed, guard.snapshot.clone())
        };

        self.persist_current().await?;
        emit_event(&self.emitter, WHALE_BALANCE_UPDATED_EVENT, &snapshot_to_emit);

        // 账户变更或刚开启且已配置时，立即拉一次新余额，避免用户等待下一轮周期。
        let should_fetch_now =
            snapshot_to_emit.enabled && snapshot_to_emit.configured && (account_changed || snapshot_to_emit.last_success_at.is_none());
        if should_fetch_now {
            let _ = self.refresh_internal(true).await;
        }

        let guard = self.inner.read().await;
        Ok(WhaleBalanceSettingsView::from(&guard.config))
    }

    pub async fn test_settings(
        &self,
        input: UpdateWhaleBalanceSettingsInput,
    ) -> Result<WhaleBalanceTestResult, AppCommandError> {
        self.ensure_loaded().await?;
        let candidate = {
            let guard = self.inner.read().await;
            normalize_config_input(&guard.config, input, false)?
        };

        if !candidate.is_configured() {
            return Ok(WhaleBalanceTestResult {
                ok: false,
                balance: None,
                used: None,
                error: Some("请先填写余额接口地址和余额字段路径".to_string()),
            });
        }

        match fetch_balance_once(&self.client, &candidate).await {
            Ok((balance, used)) => Ok(WhaleBalanceTestResult {
                ok: true,
                balance: Some(balance),
                used,
                error: None,
            }),
            Err(err) => Ok(WhaleBalanceTestResult {
                ok: false,
                balance: None,
                used: None,
                error: Some(err),
            }),
        }
    }

    pub async fn refresh_now(&self) -> Result<WhaleBalanceSnapshot, AppCommandError> {
        self.ensure_loaded().await?;
        self.refresh_internal(false).await
    }

    /// 供后台轮询循环调用：只有启用、配置完整且距上次请求达到周期时才发起请求。
    pub async fn poll_if_due(&self) {
        if self.ensure_loaded().await.is_err() {
            return;
        }
        let due = {
            let guard = self.inner.read().await;
            if !guard.config.enabled || !guard.config.is_configured() {
                false
            } else {
                match guard.last_polled_at {
                    None => true,
                    Some(t) => t.elapsed() >= Duration::from_secs(guard.config.poll_interval_secs),
                }
            }
        };
        if due {
            let _ = self.refresh_internal(false).await;
        }
    }

    async fn refresh_internal(&self, bypass_cooldown: bool) -> Result<WhaleBalanceSnapshot, AppCommandError> {
        let _refresh_guard = self.refresh_lock.lock().await;

        let (config, gen_at_start) = {
            let mut guard = self.inner.write().await;
            if !guard.config.is_configured() {
                return Ok(guard.snapshot.clone());
            }
            if !bypass_cooldown {
                if let Some(last) = guard.last_polled_at {
                    if last.elapsed() < Duration::from_millis(MIN_MANUAL_REFRESH_COOLDOWN_MS) {
                        return Ok(guard.snapshot.clone());
                    }
                }
            }
            guard.snapshot.refreshing = true;
            let snap = guard.snapshot.clone();
            emit_event(&self.emitter, WHALE_BALANCE_UPDATED_EVENT, &snap);
            (guard.config.clone(), guard.config.account_generation)
        };

        let result = fetch_balance_once(&self.client, &config).await;
        let now_iso = Utc::now().to_rfc3339();

        let final_snapshot = {
            let mut guard = self.inner.write().await;
            // 请求期间若切换了账户或改动配置，丢弃过时响应，避免跨账户污染。
            if guard.config.account_generation != gen_at_start {
                guard.snapshot.refreshing = false;
                return Ok(guard.snapshot.clone());
            }

            guard.last_polled_at = Some(Instant::now());
            guard.snapshot.refreshing = false;
            guard.snapshot.last_attempt_at = Some(now_iso.clone());

            match result {
                Ok((balance, used)) => {
                    guard.snapshot.balance = Some(balance);
                    guard.snapshot.used = used;
                    guard.snapshot.last_success_at = Some(now_iso);
                    guard.snapshot.last_error = None;
                    guard.snapshot.stale = false;
                }
                Err(err) => {
                    // 失败时沿用上一次成功读数与更新时间；若此前从无成功读数，保持 None 显示「—」。
                    guard.snapshot.last_error = Some(err);
                    guard.snapshot.stale = guard.snapshot.last_success_at.is_some();
                }
            }
            guard.snapshot.clone()
        };

        self.persist_current().await?;
        emit_event(&self.emitter, WHALE_BALANCE_UPDATED_EVENT, &final_snapshot);
        Ok(final_snapshot)
    }

    async fn persist_current(&self) -> Result<(), AppCommandError> {
        let (cfg_json, snap_json) = {
            let guard = self.inner.read().await;
            let cfg_json = serde_json::to_string(&guard.config).map_err(|e| {
                AppCommandError::io_error(format!("Failed to serialize whale balance config: {e}"))
            })?;
            let snap_json = serde_json::to_string(&guard.snapshot).map_err(|e| {
                AppCommandError::io_error(format!(
                    "Failed to serialize whale balance snapshot: {e}"
                ))
            })?;
            (cfg_json, snap_json)
        };

        app_metadata_service::upsert_value(&self.db, CONFIG_KV_KEY, &cfg_json)
            .await
            .map_err(AppCommandError::db)?;
        app_metadata_service::upsert_value(&self.db, SNAPSHOT_KV_KEY, &snap_json)
            .await
            .map_err(AppCommandError::db)?;
        Ok(())
    }
}

/// 后台独立轮询循环，关闭 DSH 后 Codeg 仍可按周期自主刷新余额。
pub async fn run_whale_balance_poller(service: Arc<WhaleBalanceService>) {
    // 启动后稍等 2 秒再尝试首次拉取，避开建库和首帧初始化高峰。
    tokio::time::sleep(Duration::from_secs(2)).await;
    loop {
        service.poll_if_due().await;
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

/// 在当前 Tokio 运行时上下文中启动后台轮询任务（供 server 模式调用）。
pub fn spawn_whale_balance_poller(service: Arc<WhaleBalanceService>) {
    tokio::spawn(run_whale_balance_poller(service));
}

fn normalize_config_input(
    existing: &WhaleBalanceConfig,
    input: UpdateWhaleBalanceSettingsInput,
    strict_required: bool,
) -> Result<WhaleBalanceConfig, AppCommandError> {
    let url = input.url.trim().to_string();
    if !url.is_empty() {
        assert_safe_balance_url(&url)?;
    } else if strict_required && input.enabled {
        return Err(AppCommandError::invalid_input(
            "启用小鲸鱼余额挂件时必须填写余额接口地址",
        ));
    }

    let method = input
        .method
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_uppercase)
        .unwrap_or_else(|| DEFAULT_METHOD.to_string());
    if method != "GET" && method != "POST" {
        return Err(AppCommandError::invalid_input(
            "请求方法仅支持 GET 或 POST",
        ));
    }

    let auth_header = input
        .auth_header
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_AUTH_HEADER)
        .to_string();

    let api_key = if input.clear_api_key {
        String::new()
    } else if let Some(raw_key) = input.api_key {
        let trimmed = raw_key.trim().to_string();
        if trimmed.is_empty() {
            existing.api_key.clone()
        } else {
            trimmed
        }
    } else {
        existing.api_key.clone()
    };

    let remaining_path = input
        .remaining_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_REMAINING_PATH)
        .to_string();

    let used_path = input
        .used_path
        .as_deref()
        .map(str::trim)
        .unwrap_or(DEFAULT_USED_PATH)
        .to_string();

    let scale = input.scale.unwrap_or(DEFAULT_SCALE);
    if !scale.is_finite() || scale <= 0.0 {
        return Err(AppCommandError::invalid_input("数值倍率必须是大于 0 的有限数"));
    }

    let poll_interval_secs = input
        .poll_interval_secs
        .unwrap_or(DEFAULT_POLL_INTERVAL_SECS)
        .clamp(MIN_POLL_INTERVAL_SECS, MAX_POLL_INTERVAL_SECS);

    Ok(WhaleBalanceConfig {
        enabled: input.enabled,
        account_name: input.account_name.trim().to_string(),
        url,
        method,
        auth_header,
        api_key,
        remaining_path,
        used_path,
        scale,
        poll_interval_secs,
        account_generation: existing.account_generation,
    })
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

async fn fetch_balance_once(
    client: &reqwest::Client,
    config: &WhaleBalanceConfig,
) -> Result<(f64, Option<f64>), String> {
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

    let remaining = pick_json_path(&body, &config.remaining_path)
        .and_then(|v| parse_scaled_number(v, config.scale))
        .ok_or_else(|| {
            format!(
                "返回 JSON 中未找到有效余额字段（路径: {}）",
                config.remaining_path
            )
        })?;

    let used = if config.used_path.trim().is_empty() {
        None
    } else {
        pick_json_path(&body, &config.used_path).and_then(|v| parse_scaled_number(v, config.scale))
    };

    Ok((remaining, used))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
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
}
