use std::{collections::BTreeMap, future::Future};

use serde::{Deserialize, Serialize};

use super::session_import::EgoImportOutcome;

// 登录数据只在本机适配器之间传递，不提供 Debug，避免错误日志意外打印凭据。
#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub expires: f64,
    pub session: bool,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub source_scheme: Option<String>,
    #[serde(default)]
    pub source_port: Option<i64>,
    #[serde(default)]
    pub partition_key: Option<serde_json::Value>,
    #[serde(default)]
    pub partition_key_opaque: bool,
    #[serde(default)]
    pub same_party: bool,
}

#[derive(Clone, PartialEq, Deserialize, Serialize)]
pub struct SessionData {
    pub origin: String,
    pub cookies: Vec<SessionCookie>,
    pub storage: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFailure {
    Conflict,
    Unsupported,
    Unavailable,
    SourceMissing,
    Changed,
    Failed,
}

impl ImportFailure {
    pub fn outcome(self, tab_id: &str) -> EgoImportOutcome {
        let (slug, note) = match self {
            Self::Conflict => (
                "browser_ego_conflict",
                "Existing site data differs; nothing was replaced.",
            ),
            Self::Unsupported => (
                "browser_ego_unsupported",
                "This site data cannot be imported without changing its scope.",
            ),
            Self::Unavailable => (
                "browser_ego_unavailable",
                "Ego is not available. Open Ego and try again.",
            ),
            Self::SourceMissing => (
                "browser_ego_source_missing",
                "The bound Ego profile is no longer available.",
            ),
            Self::Changed => (
                "browser_ego_failed",
                "The page or its permissions changed. Nothing else was imported.",
            ),
            Self::Failed => (
                "browser_ego_failed",
                "The import could not be completed. Check the site's sign-in page.",
            ),
        };
        EgoImportOutcome::refused(tab_id, slug, note)
    }
}

pub trait SessionTarget: Sync {
    fn read(&self) -> impl Future<Output = Result<SessionData, ImportFailure>> + Send;
    fn apply(
        &self,
        expected: SessionData,
        changes: SessionData,
    ) -> impl Future<Output = Result<(), ImportFailure>> + Send;
}

pub fn validate_site_data(url: &url::Url, data: &SessionData) -> Result<(), ImportFailure> {
    let host = url.host_str().ok_or(ImportFailure::Unsupported)?;
    let too_large = data.cookies.len() > 256
        || data.storage.len() > 1024
        || data
            .storage
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>()
            > 1024 * 1024;
    if too_large || data.origin != url.origin().ascii_serialization() {
        return Err(ImportFailure::Unsupported);
    }
    for cookie in &data.cookies {
        let domain_matches = match cookie.domain.strip_prefix('.') {
            Some(domain) => {
                !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
            }
            None => cookie.domain == host,
        };
        let bad_text = cookie.name.is_empty()
            || cookie
                .name
                .bytes()
                .any(|byte| byte <= 32 || byte >= 127 || b"()<>@,;:\\\"/[]?={}".contains(&byte))
            || cookie.value.chars().any(char::is_control)
            || cookie.name.len() + cookie.value.len() > 8192;
        if !domain_matches
            || bad_text
            || !cookie.path.starts_with('/')
            || cookie.path.chars().any(char::is_control)
            || !cookie.expires.is_finite()
            || cookie.partition_key.is_some()
            || cookie.partition_key_opaque
            || cookie.same_party
            || !matches!(
                cookie.same_site.as_deref(),
                None | Some("Strict" | "Lax" | "None")
            )
            || (cookie.same_site.as_deref() == Some("None") && !cookie.secure)
            || !matches!(
                cookie.priority.as_deref(),
                None | Some("Low" | "Medium" | "High")
            )
            || !matches!(
                cookie.source_scheme.as_deref(),
                None | Some("Unset" | "NonSecure" | "Secure")
            )
            || cookie
                .source_port
                .is_some_and(|port| !(-1..=65535).contains(&port))
        {
            return Err(ImportFailure::Unsupported);
        }
    }
    Ok(())
}

fn baidu_visitor_cookie(url: &url::Url, cookie: &SessionCookie) -> bool {
    // 仅放行百度首页实测的访客字段；不能用「不像 token」推断任意站点数据安全。
    url.origin().ascii_serialization() == "https://www.baidu.com"
        && matches!(cookie.domain.as_str(), ".baidu.com" | "www.baidu.com")
        && cookie.path == "/"
        && !cookie.http_only
        && matches!(
            cookie.name.as_str(),
            "BAIDUID"
                | "BAIDUID_BFESS"
                | "__bid_n"
                | "BIDUPSID"
                | "PSTM"
                | "BD_UPN"
                | "ZFY"
                | "H_PS_PSSID"
                | "BD_HOME"
                | "BA_HECTOR"
        )
}

fn baidu_visitor_storage(url: &url::Url, key: &str) -> bool {
    url.origin().ascii_serialization() == "https://www.baidu.com"
        && matches!(
            key,
            "BIDUPSID"
                | "CVObj"
                | "SpyLocalCache"
                | "ba_hector_fp"
                | "safeIconHis"
                | "CVStringTimestamp"
                | "BDSUGSTORED"
        )
}

pub async fn import_site_session(
    tab_id: &str,
    url: &str,
    mut source: SessionData,
    target: &impl SessionTarget,
    now: f64,
) -> EgoImportOutcome {
    let Ok(url) = url::Url::parse(url) else {
        return ImportFailure::Unsupported.outcome(tab_id);
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || source.origin != url.origin().ascii_serialization()
    {
        return ImportFailure::Unsupported.outcome(tab_id);
    }
    if let Err(error) = validate_site_data(&url, &source) {
        return error.outcome(tab_id);
    }
    let original_count = source.cookies.len();
    source
        .cookies
        .retain(|cookie| cookie.session || cookie.expires > now);
    let skipped_expired = original_count - source.cookies.len();
    let before = match target.read().await {
        Ok(state) => state,
        Err(error) => return error.outcome(tab_id),
    };
    if before.origin != source.origin {
        return ImportFailure::Changed.outcome(tab_id);
    }
    if let Err(error) = validate_site_data(&url, &before) {
        return error.outcome(tab_id);
    }
    // 只跳过已确认的访客数据；未知数据、账号数据及其安全属性有差异仍整次拒绝。
    if before.cookies.iter().any(|current| {
        let same_cookie = source.cookies.iter().any(|cookie| {
            cookie.name == current.name
                && cookie.domain == current.domain
                && cookie.path == current.path
                && cookie.value == current.value
                && cookie.http_only == current.http_only
                && cookie.secure == current.secure
                && cookie.same_site == current.same_site
        });
        if same_cookie {
            return false;
        }
        !baidu_visitor_cookie(&url, current)
    }) || before.storage.iter().any(|(key, value)| {
        source.storage.get(key) != Some(value) && !baidu_visitor_storage(&url, key)
    }) {
        return ImportFailure::Conflict.outcome(tab_id);
    }
    source.cookies.retain(|wanted| {
        !before.cookies.iter().any(|current| {
            current.name == wanted.name
                && current.domain == wanted.domain
                && current.path == wanted.path
        })
    });
    source
        .storage
        .retain(|key, _| !before.storage.contains_key(key));
    let cookies_imported = source.cookies.len();
    let storage_imported = source.storage.len();
    let unchanged = cookies_imported == 0 && storage_imported == 0;
    if !unchanged {
        if let Err(error) = target.apply(before, source).await {
            return error.outcome(tab_id);
        }
    }
    EgoImportOutcome {
        tab_id: tab_id.into(),
        status: if unchanged { "unchanged" } else { "imported" }.into(),
        cookies_imported,
        storage_imported,
        skipped_expired,
        error: None,
        note: Some(
            "Site data imported. Reload the page and check whether sign-in is complete.".into(),
        ),
    }
}

#[cfg(test)]
#[path = "ego_session_tests.rs"]
mod tests;
