use crate::app_state::AppState;
use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use crate::models::agent::AgentType;
use std::sync::Arc;

#[tokio::test]
async fn tag_suggestion_status_is_readable_without_a_model_provider() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/tag-http-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new_for_test(db, directory.path().into()));
    let router = super::build_router(
        state.clone(),
        "test-token".into(),
        directory.path().into(),
        state.web_server_state.shutdown_signal(),
    );
    let server = axum_test::TestServer::new(router).unwrap();
    let response = server
        .post("/api/get_tag_suggestion_status")
        .authorization_bearer("test-token")
        .json(&serde_json::json!({ "conversationId": conversation }))
        .await;
    response.assert_status_ok();
    let status: serde_json::Value = response.json();
    assert_eq!(status["batch"], serde_json::Value::Null);
    assert_eq!(status["ignored"], serde_json::json!([]));
    assert_eq!(status["running"], false);
}

#[tokio::test]
async fn user_can_review_ignore_restore_skip_and_confirm_only_the_displayed_batch() {
    use crate::ai::tag_store::{save_batch, TagCandidate};
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/tag-http-review").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let first = save_batch(
        &db.conn,
        conversation,
        "one",
        "v1",
        vec![TagCandidate::new_tag("MCP", None, "topic")],
        1000,
    )
    .await
    .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new_for_test(db, directory.path().into()));
    let router = super::build_router(
        state.clone(),
        "test-token".into(),
        directory.path().into(),
        state.web_server_state.shutdown_signal(),
    );
    let server = axum_test::TestServer::new(router).unwrap();
    let opened = server
        .post("/api/open_tag_suggestion_batch")
        .authorization_bearer("test-token")
        .json(&serde_json::json!({ "conversationId": conversation, "batchId": first.id }))
        .await;
    opened.assert_status_ok();
    assert_eq!(opened.json::<serde_json::Value>()["id"], first.id);
    server
        .post("/api/ignore_tag_suggestion")
        .authorization_bearer("test-token")
        .json(
            &serde_json::json!({ "conversationId": conversation, "batchId": first.id, "index": 0 }),
        )
        .await
        .assert_status_ok();
    let status = server
        .post("/api/get_tag_suggestion_status")
        .authorization_bearer("test-token")
        .json(&serde_json::json!({ "conversationId": conversation }))
        .await
        .json::<serde_json::Value>();
    assert_eq!(status["batch"], serde_json::Value::Null);
    let key = status["ignored"][0]["key"].as_str().unwrap();
    server
        .post("/api/restore_ignored_tag")
        .authorization_bearer("test-token")
        .json(&serde_json::json!({ "conversationId": conversation, "key": key }))
        .await
        .assert_status_ok();
    server
        .post("/api/skip_tag_suggestion_batch")
        .authorization_bearer("test-token")
        .json(&serde_json::json!({ "conversationId": conversation, "batchId": first.id }))
        .await
        .assert_status_ok();
    let old = save_batch(
        &state.db.conn,
        conversation,
        "two",
        "v1",
        vec![TagCandidate::new_tag("Approved", None, "topic")],
        2000,
    )
    .await
    .unwrap();
    let latest = save_batch(
        &state.db.conn,
        conversation,
        "three",
        "v1",
        vec![TagCandidate::new_tag("Latest", None, "topic")],
        3000,
    )
    .await
    .unwrap();
    let confirmed = server.post("/api/confirm_tag_suggestion_batch").authorization_bearer("test-token").json(&serde_json::json!({ "conversationId": conversation, "batchId": old.id, "choices": [{ "index": 0 }] })).await;
    confirmed.assert_status_ok();
    assert_eq!(
        confirmed.json::<serde_json::Value>()["tag_ids"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let status = server
        .post("/api/get_tag_suggestion_status")
        .authorization_bearer("test-token")
        .json(&serde_json::json!({ "conversationId": conversation }))
        .await
        .json::<serde_json::Value>();
    assert_eq!(status["batch"]["id"], latest.id);
}

#[tokio::test]
async fn manually_requesting_generation_without_configuration_returns_a_configuration_error() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/tag-http-unconfigured").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new_for_test(db, directory.path().into()));
    let server = axum_test::TestServer::new(super::build_router(
        state.clone(),
        "token".into(),
        directory.path().into(),
        state.web_server_state.shutdown_signal(),
    ))
    .unwrap();
    let response = server
        .post("/api/generate_tag_suggestion_batch")
        .authorization_bearer("token")
        .json(&serde_json::json!({ "conversationId": conversation, "force": false }))
        .await;
    assert!(response.status_code().is_client_error());
    assert_eq!(
        response.json::<serde_json::Value>()["code"],
        "configuration_missing"
    );
}
