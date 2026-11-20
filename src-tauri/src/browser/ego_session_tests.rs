use std::sync::Mutex;

use super::*;

struct BrowserStore(Mutex<SessionData>);

impl SessionTarget for BrowserStore {
    async fn read(&self) -> Result<SessionData, ImportFailure> {
        Ok(self.0.lock().unwrap().clone())
    }

    async fn apply(
        &self,
        expected: SessionData,
        changes: SessionData,
    ) -> Result<(), ImportFailure> {
        let mut state = self.0.lock().unwrap();
        if *state != expected {
            return Err(ImportFailure::Conflict);
        }
        state.cookies.extend(changes.cookies);
        state.storage.extend(changes.storage);
        Ok(())
    }
}

fn site_data(value: &str) -> SessionData {
    serde_json::from_value(serde_json::json!({
        "origin": "https://example.com",
        "cookies": [{
            "name": "session", "value": value, "domain": "example.com", "path": "/",
            "expires": -1.0, "session": true, "httpOnly": true,
            "secure": true, "sameSite": "Lax"
        }],
        "storage": { "token": value }
    }))
    .unwrap()
}

#[test]
fn imports_the_current_sites_login_without_exposing_credentials() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        let target = BrowserStore(Mutex::new(SessionData {
            origin: "https://example.com".into(),
            cookies: Vec::new(),
            storage: Default::default(),
        }));
        let result = import_site_session(
            "t1",
            "https://example.com/account",
            site_data("synthetic-secret"),
            &target,
            1000.0,
        )
        .await;
        assert_eq!(result.status, "imported");
        assert_eq!((result.cookies_imported, result.storage_imported), (1, 1));
        assert!(target.read().await.unwrap() == site_data("synthetic-secret"));
        let public_result = serde_json::to_string(&result).unwrap();
        assert!(!public_result.contains("synthetic-secret"));
        assert!(!public_result.contains("\"token\""));
    });
}

#[test]
fn keeps_an_existing_account_instead_of_switching_it_to_ego() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        let target = BrowserStore(Mutex::new(site_data("existing-account")));
        let result = import_site_session(
            "t1",
            "https://example.com/account",
            site_data("other-account"),
            &target,
            1000.0,
        )
        .await;
        assert_eq!(result.error.as_deref(), Some("browser_ego_conflict"));
        assert!(target.read().await.unwrap() == site_data("existing-account"));
    });
}

#[test]
fn ignores_different_visitor_data_without_overwriting_it() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut target_data = SessionData {
            origin: "https://www.baidu.com".into(),
            cookies: Vec::new(),
            storage: Default::default(),
        };
        target_data.cookies.push(
            serde_json::from_value(serde_json::json!({
                "name": "BIDUPSID", "value": "codeg-visitor", "domain": ".baidu.com", "path": "/",
                "expires": -1.0, "session": true, "httpOnly": false,
                "secure": true, "sameSite": "Lax"
            }))
            .unwrap(),
        );
        target_data
            .storage
            .insert("SpyLocalCache".into(), "codeg-cache".into());
        let target = BrowserStore(Mutex::new(target_data.clone()));

        let mut source = site_data("ego-account");
        source.origin = "https://www.baidu.com".into();
        source.cookies[0].domain = ".baidu.com".into();
        source.cookies.push(
            serde_json::from_value(serde_json::json!({
                "name": "BIDUPSID", "value": "ego-visitor", "domain": ".baidu.com", "path": "/",
                "expires": -1.0, "session": true, "httpOnly": false,
                "secure": true, "sameSite": "Lax"
            }))
            .unwrap(),
        );
        source
            .storage
            .insert("SpyLocalCache".into(), "ego-cache".into());

        let result =
            import_site_session("t1", "https://www.baidu.com/", source, &target, 1000.0).await;

        assert_eq!(result.status, "imported");
        assert_eq!((result.cookies_imported, result.storage_imported), (1, 1));
        let after = target.read().await.unwrap();
        assert!(after
            .cookies
            .iter()
            .any(|cookie| { cookie.name == "BIDUPSID" && cookie.value == "codeg-visitor" }));
        assert_eq!(
            after.storage.get("SpyLocalCache"),
            Some(&"codeg-cache".to_string())
        );
        assert!(after
            .cookies
            .iter()
            .any(|cookie| { cookie.name == "session" && cookie.value == "ego-account" }));
        assert_eq!(after.storage.get("token"), Some(&"ego-account".to_string()));
    });
}

#[test]
fn unknown_account_data_is_never_treated_as_a_visitor_identifier() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        for case in 0..4 {
            let mut existing = site_data("existing-account");
            existing.cookies[0].name = "identity".into();
            existing.cookies[0].http_only = false;
            existing.storage.clear();
            let mut source = existing.clone();
            match case {
                0 => source.cookies[0].value = "other-account".into(),
                1 => {
                    existing.cookies.clear();
                    source.cookies.clear();
                    existing
                        .storage
                        .insert("accountState".into(), "existing".into());
                    source.storage.insert("accountState".into(), "other".into());
                }
                2 => {
                    existing.cookies[0].name = "BIDUPSID".into();
                    source.cookies[0].name = "BIDUPSID".into();
                    source.cookies[0].value = "other-visitor-on-another-site".into();
                }
                _ => source.cookies[0].secure = false,
            }
            let target = BrowserStore(Mutex::new(existing.clone()));
            let result =
                import_site_session("t1", "https://example.com/", source, &target, 1000.0).await;
            assert_eq!(
                result.error.as_deref(),
                Some("browser_ego_conflict"),
                "case {case}"
            );
            assert!(target.read().await.unwrap() == existing);
        }
    });
}

#[test]
fn rejects_data_from_another_origin_without_changing_the_target() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        let empty = SessionData {
            origin: "https://example.com".into(),
            cookies: Vec::new(),
            storage: Default::default(),
        };
        let target = BrowserStore(Mutex::new(empty.clone()));
        let mut source = site_data("synthetic-secret");
        source.origin = "https://other.example.com".into();
        let result =
            import_site_session("t1", "https://example.com/account", source, &target, 1000.0).await;
        assert_eq!(result.status, "refused");
        assert!(target.read().await.unwrap() == empty);
    });
}

#[test]
fn refuses_unsafe_cookie_scopes_and_attributes_before_any_write() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        for case in 0..6 {
            let empty = SessionData {
                origin: "https://example.com".into(),
                cookies: Vec::new(),
                storage: Default::default(),
            };
            let target = BrowserStore(Mutex::new(empty.clone()));
            let mut source = site_data("synthetic-secret");
            let cookie = &mut source.cookies[0];
            match case {
                0 => cookie.domain = "unrelated.test".into(),
                1 => {
                    cookie.partition_key =
                        Some(serde_json::json!({"topLevelSite":"https://example.com"}))
                }
                2 => cookie.path = "without-leading-slash".into(),
                3 => cookie.value.push('\0'),
                4 => cookie.same_site = Some("Unknown".into()),
                _ => cookie.partition_key_opaque = true,
            }
            let result =
                import_site_session("t1", "https://example.com/account", source, &target, 1000.0)
                    .await;
            assert_eq!(
                result.error.as_deref(),
                Some("browser_ego_unsupported"),
                "case {case}"
            );
            assert!(target.read().await.unwrap() == empty);
        }
    });
}

#[test]
fn importing_the_same_login_again_leaves_existing_data_unchanged() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        let target = BrowserStore(Mutex::new(site_data("same-account")));
        let result = import_site_session(
            "t1",
            "https://example.com/account",
            site_data("same-account"),
            &target,
            1000.0,
        )
        .await;
        assert_eq!(result.status, "unchanged");
        assert_eq!((result.cookies_imported, result.storage_imported), (0, 0));
        assert!(target.read().await.unwrap() == site_data("same-account"));
    });
}

#[test]
fn skips_expired_cookies_but_keeps_session_cookies() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        let target = BrowserStore(Mutex::new(SessionData {
            origin: "https://example.com".into(),
            cookies: Vec::new(),
            storage: Default::default(),
        }));
        let mut source = site_data("synthetic-secret");
        let mut expired = source.cookies[0].clone();
        expired.name = "expired".into();
        expired.expires = 900.0;
        expired.session = false;
        source.cookies.push(expired);
        let result =
            import_site_session("t1", "https://example.com/account", source, &target, 1000.0).await;
        assert_eq!((result.cookies_imported, result.skipped_expired), (1, 1));
        assert!(target.read().await.unwrap() == site_data("synthetic-secret"));
    });
}

#[test]
fn does_not_merge_an_existing_partitioned_session_as_an_ordinary_cookie() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut existing = site_data("same-account");
        existing.cookies[0].partition_key =
            Some(serde_json::json!({"topLevelSite":"https://example.com"}));
        let target = BrowserStore(Mutex::new(existing.clone()));
        let result = import_site_session(
            "t1",
            "https://example.com/account",
            site_data("same-account"),
            &target,
            1000.0,
        )
        .await;
        assert_eq!(result.error.as_deref(), Some("browser_ego_unsupported"));
        assert!(target.read().await.unwrap() == existing);
    });
}
