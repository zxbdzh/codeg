use std::{
    sync::RwLock,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::{
    acp::browser_tools::BrowserToolsRuntimeConfig,
    browser::{
        agent::{self, GrantLevel},
        ego_session::{import_site_session, ImportFailure},
        ego_source,
        policy::BrowserPolicy,
        profile,
        registry::BrowserRegistry,
        session_import::{EgoImportOutcome, EgoImportSettings, EgoSourceProfile},
        types::{BrowserTabState, TabKind},
    },
    db::{service::app_metadata_service, AppDatabase},
};

const SETTINGS_KEY: &str = "browser.ego_import";

#[derive(Default)]
pub struct EgoImportRuntime {
    settings: RwLock<Option<EgoImportSettings>>,
    settings_write: tokio::sync::Mutex<()>,
    imports: tokio::sync::Mutex<()>,
}

impl EgoImportRuntime {
    fn cached(&self) -> Option<EgoImportSettings> {
        self.settings
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

pub async fn settings_core(app: &AppHandle) -> EgoImportSettings {
    let runtime = app.state::<EgoImportRuntime>();
    if let Some(settings) = runtime.cached() {
        return settings;
    }
    let conn = app.state::<AppDatabase>().conn.clone();
    let loaded = app_metadata_service::get_value(&conn, SETTINGS_KEY)
        .await
        .ok()
        .flatten()
        .filter(|raw| raw.len() <= 4096)
        .and_then(|raw| serde_json::from_str::<EgoImportSettings>(&raw).ok())
        .unwrap_or_default();
    let mut settings = runtime
        .settings
        .write()
        .unwrap_or_else(|error| error.into_inner());
    settings.get_or_insert(loaded).clone()
}

#[tauri::command]
pub async fn browser_ego_import_settings(app: AppHandle) -> EgoImportSettings {
    settings_core(&app).await
}

#[tauri::command]
pub async fn browser_ego_import_profiles() -> Result<Vec<EgoSourceProfile>, String> {
    if !cfg!(all(target_os = "windows", feature = "browser-child")) {
        return Err("browser_ego_unsupported".into());
    }
    ego_source::profiles()
        .await
        .map_err(|error| error.outcome("").error.unwrap_or_default())
}

#[tauri::command]
pub async fn browser_set_ego_import_settings(
    app: AppHandle,
    mut settings: EgoImportSettings,
) -> Result<EgoImportSettings, String> {
    if !cfg!(all(target_os = "windows", feature = "browser-child")) {
        return Err("browser_ego_unsupported".into());
    }
    let runtime = app.state::<EgoImportRuntime>();
    let _write = runtime.settings_write.lock().await;
    let before = settings_core(&app).await;
    if settings
        .source_profile_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
    {
        return Err("browser_ego_source_missing".into());
    }
    if settings.source_profile_id != before.source_profile_id {
        if let Some(id) = &settings.source_profile_id {
            let available = ego_source::profiles()
                .await
                .map_err(|error| error.outcome("").error.unwrap_or_default())?;
            let profile = available
                .iter()
                .find(|profile| profile.id == *id)
                .ok_or("browser_ego_source_missing")?;
            settings.source_profile_name = Some(profile.name.clone());
        } else {
            settings.source_profile_name = None;
            settings.allow_agent_import = false;
        }
    } else {
        settings.source_profile_name = before.source_profile_name;
    }
    if settings.allow_agent_import && settings.source_profile_id.is_none() {
        return Err("browser_ego_source_required".into());
    }
    let conn = app.state::<AppDatabase>().conn.clone();
    app_metadata_service::upsert_value(
        &conn,
        SETTINGS_KEY,
        &serde_json::to_string(&settings).map_err(|_| "browser_ego_failed")?,
    )
    .await
    .map_err(|_| "browser_ego_failed")?;
    *runtime
        .settings
        .write()
        .unwrap_or_else(|error| error.into_inner()) = Some(settings.clone());
    Ok(settings)
}

#[derive(Clone)]
enum ImportCaller {
    Person { owner: String },
    Agent,
}

async fn authorize(
    app: &AppHandle,
    state: &BrowserTabState,
    caller: &ImportCaller,
) -> Result<(), &'static str> {
    if state.kind != TabKind::Page
        || profile::is_remote_profile(
            state
                .profile
                .as_deref()
                .unwrap_or(profile::DEFAULT_PROFILE_ID),
        )
    {
        return Err("browser_ego_unsupported");
    }
    let url = tauri::Url::parse(&state.url).map_err(|_| "browser_ego_unsupported")?;
    if !matches!(url.scheme(), "http" | "https") || state.loading || state.error.is_some() {
        return Err("browser_ego_unsupported");
    }
    let policy = app.state::<BrowserPolicy>();
    if !policy.enabled() || policy.blocked(&url) {
        return Err("browser_blocked");
    }
    match caller {
        ImportCaller::Person { owner } if *owner != state.owner_window => {
            Err("browser_no_such_tab")
        }
        ImportCaller::Person { .. } => Ok(()),
        ImportCaller::Agent => {
            if !app.state::<BrowserToolsRuntimeConfig>().is_enabled().await {
                return Err("browser_ego_import_disabled");
            }
            if !settings_core(app).await.allow_agent_import {
                return Err("browser_ego_import_disabled");
            }
            let grant = state
                .agent_grant
                .as_ref()
                .filter(|grant| grant.covers(state.origin.as_deref()));
            if !agent::level_of(grant).allows(GrantLevel::Read) {
                return Err("browser_grant_required");
            }
            if !agent::level_of(grant).allows(GrantLevel::Control) {
                return Err("browser_control_required");
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn browser_import_ego_session(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
) -> EgoImportOutcome {
    import_core(
        &app,
        &tab_id,
        ImportCaller::Person {
            owner: window.label().into(),
        },
    )
    .await
}

pub async fn import_for_agent(app: &AppHandle, tab_id: &str, reason: &str) -> EgoImportOutcome {
    if reason.trim().is_empty() || reason.len() > 1000 {
        return EgoImportOutcome::refused(
            tab_id,
            "browser_ego_failed",
            "Give a short reason for importing this site's sign-in state.",
        );
    }
    let registry = app.state::<BrowserRegistry>();
    super::browser::revoke_if_listener_replaced(app, &registry, tab_id).await;
    import_core(app, tab_id, ImportCaller::Agent).await
}

async fn import_core(app: &AppHandle, tab_id: &str, caller: ImportCaller) -> EgoImportOutcome {
    #[cfg(all(target_os = "windows", feature = "browser-child"))]
    {
        use crate::browser::{ego_target::NativeSessionTarget, surface::BrowserSurface};
        let runtime = app.state::<EgoImportRuntime>();
        let _import = match runtime.imports.try_lock() {
            Ok(lock) => lock,
            Err(_) => {
                return EgoImportOutcome::refused(
                    tab_id,
                    "browser_ego_failed",
                    "Another sign-in import is already running.",
                )
            }
        };
        let registry = app.state::<BrowserRegistry>();
        let Some((state, surface, generation, nav_epoch)) = registry.read(tab_id, |tab| {
            (
                tab.state.clone(),
                tab.surface.clone(),
                tab.generation,
                tab.nav_epoch,
            )
        }) else {
            return EgoImportOutcome::refused(
                tab_id,
                "browser_no_such_tab",
                "The browser tab is no longer open.",
            );
        };
        if let Err(error) = authorize(app, &state, &caller).await {
            return EgoImportOutcome::refused(tab_id, error, "Import is not allowed for this tab.");
        }
        let BrowserSurface::Child(handle) = surface else {
            return ImportFailure::Unsupported.outcome(tab_id);
        };
        let settings = settings_core(app).await;
        let Some(source_id) = settings.source_profile_id else {
            return EgoImportOutcome::refused(
                tab_id,
                "browser_ego_source_required",
                "Choose an Ego source profile in the browser settings first.",
            );
        };
        let source = match ego_source::read(&source_id, &state.url).await {
            Ok(source) => source,
            Err(error) => return error.outcome(tab_id),
        };
        let app_check = app.clone();
        let tab_check = tab_id.to_string();
        let original_profile = state.profile.clone();
        let original_origin = state.origin.clone();
        let target = match NativeSessionTarget::new(
            handle,
            generation,
            nav_epoch,
            state.url.clone(),
            move || {
                let app = app_check.clone();
                let tab_id = tab_check.clone();
                let caller = caller.clone();
                let profile = original_profile.clone();
                let origin = original_origin.clone();
                let source_id = source_id.clone();
                Box::pin(async move {
                    let Some((state, current_generation, current_epoch)) =
                        app.state::<BrowserRegistry>().read(&tab_id, |tab| {
                            (tab.state.clone(), tab.generation, tab.nav_epoch)
                        })
                    else {
                        return Err(ImportFailure::Changed);
                    };
                    if generation != current_generation
                        || nav_epoch != current_epoch
                        || state.profile != profile
                        || state.origin != origin
                        || settings_core(&app).await.source_profile_id.as_deref()
                            != Some(&source_id)
                    {
                        return Err(ImportFailure::Changed);
                    }
                    authorize(&app, &state, &caller)
                        .await
                        .map_err(|_| ImportFailure::Changed)
                })
            },
        ) {
            Ok(target) => target,
            Err(error) => return error.outcome(tab_id),
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let result = import_site_session(tab_id, &state.url, source, &target, now).await;
        if result.status == "imported" {
            if let Err(error) = target.reload().await {
                return error.outcome(tab_id);
            }
        }
        result
    }
    #[cfg(not(all(target_os = "windows", feature = "browser-child")))]
    {
        let _ = (app, caller);
        ImportFailure::Unsupported.outcome(tab_id)
    }
}
