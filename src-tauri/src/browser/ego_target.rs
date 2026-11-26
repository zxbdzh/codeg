use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};

use super::{
    ego_session::{ImportFailure, SessionCookie, SessionData, SessionTarget},
    surface_child::ChildHandle,
};

type GuardFuture = Pin<Box<dyn Future<Output = Result<(), ImportFailure>> + Send>>;

pub struct NativeSessionTarget {
    handle: ChildHandle,
    generation: u64,
    nav_epoch: u64,
    url: String,
    origin: String,
    guard: Arc<dyn Fn() -> GuardFuture + Send + Sync>,
}

impl NativeSessionTarget {
    pub fn new(
        handle: ChildHandle,
        generation: u64,
        nav_epoch: u64,
        url: String,
        guard: impl Fn() -> GuardFuture + Send + Sync + 'static,
    ) -> Result<Self, ImportFailure> {
        let origin = url::Url::parse(&url)
            .map_err(|_| ImportFailure::Unsupported)?
            .origin()
            .ascii_serialization();
        Ok(Self {
            handle,
            generation,
            nav_epoch,
            url,
            origin,
            guard: Arc::new(guard),
        })
    }

    pub async fn reload(&self) -> Result<(), ImportFailure> {
        (self.guard)().await?;
        self.handle.reload().map_err(|_| ImportFailure::Failed)
    }

    async fn cdp(&self, method: &'static str, params: Value) -> Result<Value, ImportFailure> {
        (self.guard)().await?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.handle
            .session_cdp(
                self.generation,
                self.nav_epoch,
                method,
                params.to_string(),
                move |answer| {
                    let _ = sender.send(answer);
                },
            )
            .map_err(|_| ImportFailure::Changed)?;
        let raw = tokio::time::timeout(Duration::from_secs(8), receiver)
            .await
            .map_err(|_| ImportFailure::Failed)?
            .map_err(|_| ImportFailure::Failed)?
            .map_err(|_| ImportFailure::Failed)?;
        (self.guard)().await?;
        if raw.len() > 2 * 1024 * 1024 {
            return Err(ImportFailure::Unsupported);
        }
        serde_json::from_str(&raw).map_err(|_| ImportFailure::Failed)
    }

    async fn world(&self, expression: String) -> Result<Value, ImportFailure> {
        (self.guard)().await?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = Mutex::new(Some(sender));
        self.handle
            .session_eval(self.generation, self.nav_epoch, expression, move |answer| {
                if let Some(sender) = sender
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
                {
                    let _ = sender.send(answer);
                }
            })
            .map_err(|_| ImportFailure::Changed)?;
        let raw = tokio::time::timeout(Duration::from_secs(8), receiver)
            .await
            .map_err(|_| ImportFailure::Failed)?
            .map_err(|_| ImportFailure::Failed)?
            .map_err(|_| ImportFailure::Failed)?;
        (self.guard)().await?;
        if raw.len() > 2 * 1024 * 1024 {
            return Err(ImportFailure::Unsupported);
        }
        let mut answer: Value = serde_json::from_str(&raw).map_err(|_| ImportFailure::Failed)?;
        if answer["ok"] != true {
            return Err(ImportFailure::Failed);
        }
        Ok(answer["value"].take())
    }

    async fn rollback(&self, changes: &SessionData) {
        if let Ok(mut current) = self
            .cdp("Network.getCookies", json!({"urls":[self.url]}))
            .await
        {
            if let Ok(cookies) =
                serde_json::from_value::<Vec<SessionCookie>>(current["cookies"].take())
            {
                for cookie in cookies {
                    if changes.cookies.iter().any(|added| {
                        added.name == cookie.name
                            && added.domain == cookie.domain
                            && added.path == cookie.path
                            && added.value == cookie.value
                    }) {
                        let _ = self
                            .cdp(
                                "Network.deleteCookies",
                                json!({
                                    "name":cookie.name, "domain":cookie.domain, "path":cookie.path
                                }),
                            )
                            .await;
                    }
                }
            }
        }
        let _ = self.world(format!(
            "(()=>{{if(location.origin!=={})return false;for(const [key,value] of Object.entries({})){{if(localStorage.getItem(key)===value)localStorage.removeItem(key)}}return true}})()",
            json!(self.origin), js_object(&changes.storage),
        )).await;
    }
}

// JSON.parse 避免把 __proto__ 等合法存储键解释为 JavaScript 对象字面量语法。
fn js_object(storage: &BTreeMap<String, String>) -> String {
    format!(
        "JSON.parse({})",
        json!(serde_json::to_string(storage).unwrap_or_default())
    )
}

fn cookie_params(cookie: &SessionCookie, url: &str) -> Value {
    let mut params = json!({
        "name":cookie.name, "value":cookie.value, "path":cookie.path,
        "secure":cookie.secure, "httpOnly":cookie.http_only,
    });
    // Wry 的 Cookie::domain() 会去掉前导点；用 CDP 保留 domain/host-only 的区别。
    if cookie.domain.starts_with('.') {
        params["domain"] = json!(cookie.domain);
    } else {
        params["url"] = json!(url);
    }
    if !cookie.session {
        params["expires"] = json!(cookie.expires);
    }
    if let Some(value) = &cookie.same_site {
        params["sameSite"] = json!(value);
    }
    if let Some(value) = &cookie.priority {
        params["priority"] = json!(value);
    }
    if let Some(value) = &cookie.source_scheme {
        params["sourceScheme"] = json!(value);
    }
    if let Some(value) = cookie.source_port {
        params["sourcePort"] = json!(value);
    }
    params
}

impl SessionTarget for NativeSessionTarget {
    async fn read(&self) -> Result<SessionData, ImportFailure> {
        let mut state = self.world(format!(
            "(()=>{{if(location.origin!=={})return null;const entries=Object.entries(localStorage);if(entries.length>1024||entries.reduce((sum,[key,value])=>sum+key.length+value.length,0)>1048576)return null;return {{origin:location.origin,storage:Object.fromEntries(entries)}}}})()",
            json!(self.origin),
        )).await?;
        let origin = state["origin"]
            .as_str()
            .ok_or(ImportFailure::Changed)?
            .to_string();
        let storage = serde_json::from_value(state["storage"].take())
            .map_err(|_| ImportFailure::Unsupported)?;
        let mut answer = self
            .cdp("Network.getCookies", json!({"urls":[self.url]}))
            .await?;
        let mut cookies: Vec<SessionCookie> = serde_json::from_value(answer["cookies"].take())
            .map_err(|_| ImportFailure::Unsupported)?;
        cookies.sort_by(|left, right| {
            (&left.domain, &left.path, &left.name).cmp(&(&right.domain, &right.path, &right.name))
        });
        Ok(SessionData {
            origin,
            cookies,
            storage,
        })
    }

    async fn apply(
        &self,
        expected: SessionData,
        changes: SessionData,
    ) -> Result<(), ImportFailure> {
        if self.read().await? != expected {
            return Err(ImportFailure::Conflict);
        }
        let storage_applied = self.world(format!(
            "(()=>{{if(location.origin!=={})return false;const expected={};if(localStorage.length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>localStorage.getItem(key)!==value))return false;const added={};try{{for(const [key,value] of Object.entries(added))localStorage.setItem(key,value)}}catch{{for(const [key,value] of Object.entries(added))if(localStorage.getItem(key)===value)localStorage.removeItem(key);return false}}return true}})()",
            json!(self.origin), js_object(&expected.storage), js_object(&changes.storage),
        )).await?;
        if storage_applied != true {
            return Err(ImportFailure::Conflict);
        }
        let cookies: Vec<_> = changes
            .cookies
            .iter()
            .map(|cookie| cookie_params(cookie, &self.url))
            .collect();
        if !cookies.is_empty() {
            if let Err(error) = self
                .cdp("Network.setCookies", json!({"cookies":cookies}))
                .await
            {
                self.rollback(&changes).await;
                return Err(error);
            }
        }
        let written = self.read().await;
        let verified = written.as_ref().is_ok_and(|written| {
            changes
                .storage
                .iter()
                .all(|(key, value)| written.storage.get(key) == Some(value))
                && changes.cookies.iter().all(|wanted| {
                    written.cookies.iter().any(|actual| {
                        wanted.name == actual.name
                            && wanted.domain == actual.domain
                            && wanted.path == actual.path
                            && wanted.value == actual.value
                            && wanted.http_only == actual.http_only
                            && wanted.secure == actual.secure
                            && wanted.same_site == actual.same_site
                            && wanted.session == actual.session
                            && (wanted.session || (wanted.expires - actual.expires).abs() < 1.0)
                    })
                })
        });
        if !verified {
            self.rollback(&changes).await;
            return Err(ImportFailure::Failed);
        }
        // 恢复只执行本次调用，不注入永久脚本，避免刷新时重写已经更新的令牌。
        Ok(())
    }
}
