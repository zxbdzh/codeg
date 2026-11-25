use std::sync::Arc;

use axum::{routing::get, Json, Router};
use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::db::entities::agent_setting;
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use sea_orm::{ActiveModelTrait, Set};
use serde_json::{json, Value};
use tokio::net::TcpListener;

const TOKEN: &str = "whale-balance-test-token";

#[tokio::test]
async fn whale_widget_options_are_authenticated_and_independent() {
    let root = tempfile::tempdir().unwrap();
    let db = fresh_in_memory_db().await;
    // 用量接口会按 CODEX_HOME 扫描会话；测试固定到空目录，避免读真实历史。
    let codex_home = tempfile::tempdir().unwrap();
    let now = chrono::Utc::now();
    agent_setting::ActiveModel {
        id: sea_orm::NotSet,
        agent_type: Set(serde_json::to_string(&codeg_lib::models::AgentType::Codex).unwrap()),
        registry_id: Set("codex".to_string()),
        enabled: Set(true),
        sort_order: Set(0),
        installed_version: Set(None),
        env_json: Set(Some(
            json!({ "CODEX_HOME": codex_home.path() }).to_string(),
        )),
        model_provider_id: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(&db.conn)
    .await
    .expect("insert codex agent setting");
    let state = Arc::new(AppState::new_for_test(db, root.path().to_path_buf()));
    let server = TestServer::new(build_router(
        state,
        TOKEN.to_string(),
        root.path().to_path_buf(),
        Arc::new(ShutdownSignal::new()),
    ))
    .unwrap();
    let auth = format!("Bearer {TOKEN}");
    let get = "/api/whale_widget_get_options";
    let save = "/api/whale_widget_save_options";
    assert_eq!(server.post(get).await.status_code(), 401);
    assert_eq!(server.post(save).json(&json!({"input": {}})).await.status_code(), 401);
    let initial: Value = server.post(get).add_header("authorization", &auth).await.json();
    assert_eq!(initial, json!({}));
    let options = json!({"hideMenu": true, "alerts": {"default": {"budget": 5}}});
    let saved: Value = server.post(save).add_header("authorization", &auth)
        .json(&json!({"input": options})).await.json();
    assert_eq!(saved, options);
    let loaded: Value = server.post(get).add_header("authorization", &auth).await.json();
    assert_eq!(loaded, options);
    let presentation: Value = server.post("/api/whale_balance_get_presentation")
        .add_header("authorization", &auth).await.json();
    assert_eq!(presentation["widgetSize"], 44);
    let invalid = server.post(save).add_header("authorization", &auth)
        .json(&json!({"input": []})).await;
    assert_eq!(invalid.status_code(), 400);

    let usage = server.post("/api/whale_widget_codex_usage")
        .add_header("authorization", &auth)
        .json(&json!({"input": {"models": []}})).await;
    assert_eq!(usage.status_code(), 200);
    let usage: Value = usage.json();
    assert_eq!(usage["tokens"], 0);
    assert_eq!(usage["windows"], json!([]));
}

#[tokio::test]
async fn whale_balance_web_routes_require_auth_and_hide_api_key() {
    let root = tempfile::tempdir().unwrap();
    let db = fresh_in_memory_db().await;
    let state = Arc::new(AppState::new_for_test(db, root.path().to_path_buf()));
    let router = build_router(
        state,
        TOKEN.to_string(),
        root.path().to_path_buf(),
        Arc::new(ShutdownSignal::new()),
    );
    let server = TestServer::new(router).unwrap();

    // 1. 未认证请求必须被拒绝，不能被远程浏览器匿名读取。
    let unauth = server.post("/api/whale_balance_get_state").await;
    assert_eq!(unauth.status_code(), 401);

    let unauth_settings = server.post("/api/whale_balance_get_settings").await;
    assert_eq!(unauth_settings.status_code(), 401);

    // 2. 启动一个本地 mock 余额服务，验证配置保存、密钥脱敏、读数返回与刷新。
    let mock_app = Router::new().route(
        "/v1/skills/balance",
        get(|| async {
            Json(json!({
                "balance": 1234.5,
                "api_key_quota": { "used": 67.89 }
            }))
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, mock_app).await.unwrap();
    });

    let auth_header = format!("Bearer {TOKEN}");
    let secret_value = ["demo", "secret", "9988"].join("-");

    let update_resp = server
        .post("/api/whale_balance_update_settings")
        .add_header("authorization", &auth_header)
        .json(&json!({
            "settings": {
                "enabled": true,
                "accountName": "lk888",
                "url": format!("http://{addr}/v1/skills/balance"),
                "method": "GET",
                "authHeader": "Bearer {key}",
                "apiKey": secret_value,
                "remainingPath": "balance",
                "usedPath": "api_key_quota.used",
                "scale": 1.0,
                "pollIntervalSecs": 60
            }
        }))
        .await;
    assert_eq!(update_resp.status_code(), 200);
    let update_text = update_resp.text();
    assert!(!update_text.contains(&secret_value));
    let view: Value = serde_json::from_str(&update_text).unwrap();
    assert_eq!(view["hasApiKey"], true);
    assert_eq!(view["apiKeyHint"], "demo****9988");

    let state_resp = server
        .post("/api/whale_balance_get_state")
        .add_header("authorization", &auth_header)
        .await;
    assert_eq!(state_resp.status_code(), 200);
    let snap: Value = state_resp.json();
    assert_eq!(snap["accountName"], "lk888");
    assert_eq!(snap["balance"], 1234.5);
    assert_eq!(snap["used"], 67.89);
    assert_eq!(snap["stale"], false);
    assert_eq!(snap["accounts"][0]["balance"], 1234.5);

    let presentation_resp = server
        .post("/api/whale_balance_save_presentation")
        .add_header("authorization", &auth_header)
        .json(&json!({
            "input": {
                "showBalance": true,
                "showApiUsed": false,
                "showObservedToday": true,
                "showTokenCost": false,
                "widgetSize": 64
            }
        }))
        .await;
    assert_eq!(presentation_resp.status_code(), 200);
    let presentation: Value = presentation_resp.json();
    assert_eq!(presentation["showApiUsed"], false);
    assert_eq!(presentation["widgetSize"], 64);

    let ledger_resp = server
        .post("/api/whale_balance_get_ledger")
        .add_header("authorization", &auth_header)
        .await;
    assert_eq!(ledger_resp.status_code(), 200);
    let ledger: Value = ledger_resp.json();
    assert!(ledger["entries"].is_array());
}
