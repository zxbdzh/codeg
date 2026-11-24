use std::sync::Arc;

use axum::{routing::get, Json, Router};
use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use serde_json::{json, Value};
use tokio::net::TcpListener;

const TOKEN: &str = "whale-balance-test-token";

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
}
