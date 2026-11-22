//! 原生会话的 Axum 适配层。
//!
//! 这里只做 HTTP → core 的参数搬运：来源身份校验、所有权和错误码全部
//! 留在 `commands::native_session`，保证 Tauri 与 Web 返回同一份契约。

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::native_session::{
    native_session_close_main_core, native_session_close_side_core,
    native_session_create_side_core, native_session_list_core, native_session_open_main_core,
    native_session_open_side_core, NativeCreatedSideQuestion, NativeSessionContext,
    NativeRestoredAcp, NativeSideQuestion, NativeTerminalHandle,
};
use crate::models::AgentType;

/// Web 没有窗口概念，沿用 ACP 连接创建时的固定 owner，
/// 这样终端所有权校验在两个运行时语义一致。
const WEB_OWNER: &str = "web";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRequest {
    source_connection_id: String,
    source_conversation_id: Option<i32>,
    source_agent_type: AgentType,
}

/// create 需要额外的稳定请求键和标题；单独一个结构体，避免 list/open_main
/// 也被要求传这些字段。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSideRequest {
    source_connection_id: String,
    source_conversation_id: Option<i32>,
    source_agent_type: AgentType,
    request_id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SideQuestionRequest {
    side_question_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseMainRequest {
    source_connection_id: String,
    terminal_id: String,
}

pub async fn native_session_list(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<SourceRequest>,
) -> Result<Json<Vec<NativeSideQuestion>>, AppCommandError> {
    native_session_list_core(
        &state.db,
        &state.connection_manager,
        &request.source_connection_id,
        request.source_conversation_id,
        request.source_agent_type,
    )
    .await
    .map(Json)
}

pub async fn native_session_create_side(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<CreateSideRequest>,
) -> Result<Json<NativeCreatedSideQuestion>, AppCommandError> {
    native_session_create_side_core(
        &NativeSessionContext {
            db: &state.db,
            manager: &state.connection_manager,
            terminals: &state.terminal_manager,
            emitter: state.emitter.clone(),
            data_dir: &state.data_dir,
            owner_window_label: WEB_OWNER,
        },
        &request.source_connection_id,
        request.source_conversation_id,
        request.source_agent_type,
        &request.request_id,
        &request.title,
    )
    .await
    .map(Json)
}

pub async fn native_session_open_side(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<SideQuestionRequest>,
) -> Result<Json<NativeTerminalHandle>, AppCommandError> {
    native_session_open_side_core(
        &NativeSessionContext {
            db: &state.db,
            manager: &state.connection_manager,
            terminals: &state.terminal_manager,
            emitter: state.emitter.clone(),
            data_dir: &state.data_dir,
            owner_window_label: WEB_OWNER,
        },
        &request.side_question_id,
    )
    .await
    .map(Json)
}

pub async fn native_session_close_side(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<SideQuestionRequest>,
) -> Result<Json<()>, AppCommandError> {
    native_session_close_side_core(
        &NativeSessionContext {
            db: &state.db,
            manager: &state.connection_manager,
            terminals: &state.terminal_manager,
            emitter: state.emitter.clone(),
            data_dir: &state.data_dir,
            owner_window_label: WEB_OWNER,
        },
        &request.side_question_id,
    )
    .await?;
    Ok(Json(()))
}

pub async fn native_session_open_main(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<SourceRequest>,
) -> Result<Json<NativeTerminalHandle>, AppCommandError> {
    native_session_open_main_core(
        &NativeSessionContext {
            db: &state.db,
            manager: &state.connection_manager,
            terminals: &state.terminal_manager,
            emitter: state.emitter.clone(),
            data_dir: &state.data_dir,
            owner_window_label: WEB_OWNER,
        },
        &request.source_connection_id,
        request.source_conversation_id,
        request.source_agent_type,
    )
    .await
    .map(Json)
}

pub async fn native_session_close_main(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<CloseMainRequest>,
) -> Result<Json<NativeRestoredAcp>, AppCommandError> {
    native_session_close_main_core(
        &NativeSessionContext {
            db: &state.db,
            manager: &state.connection_manager,
            terminals: &state.terminal_manager,
            emitter: state.emitter.clone(),
            data_dir: &state.data_dir,
            owner_window_label: WEB_OWNER,
        },
        &request.source_connection_id,
        &request.terminal_id,
    )
    .await
    .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::service::{conversation_service, side_question_service};
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::web::event_bridge::EventEmitter;
    use crate::web::router::build_router;
    use crate::web::shutdown::ShutdownSignal;
    use axum_test::{TestResponse, TestServer};
    use serde_json::{json, Value};
    use uuid::Uuid;

    const TOKEN: &str = "native-session-integration-test";

    struct Fixture {
        server: TestServer,
        state: Arc<AppState>,
        root: tempfile::TempDir,
        conversation_id: i32,
        connection_id: String,
        session_id: String,
    }

    impl Fixture {
        async fn new(connection_id: &str, session_id: &str) -> Self {
            let root = tempfile::tempdir().expect("isolated native session files");
            let workspace = root.path().join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();

            let db = fresh_in_memory_db().await;
            let folder_id = seed_folder(&db, &workspace.to_string_lossy()).await;
            let conversation_id = seed_conversation(&db, folder_id, AgentType::Codex).await;
            conversation_service::bind_external_id(&db.conn, conversation_id, session_id, &[])
                .await
                .expect("bind native session");

            let state = Arc::new(AppState::new_for_test(db, root.path().join("data")));
            state
                .connection_manager
                .insert_test_connection(
                    connection_id,
                    AgentType::Codex,
                    Some(workspace.clone()),
                    EventEmitter::Noop,
                )
                .await;
            {
                let connection = state
                    .connection_manager
                    .get_state(connection_id)
                    .await
                    .expect("connection exists");
                let mut snapshot = connection.write().await;
                snapshot.conversation_id = Some(conversation_id);
                snapshot.external_id = Some(session_id.to_string());
            }

            let router = build_router(
                state.clone(),
                TOKEN.into(),
                root.path().join("static"),
                Arc::new(ShutdownSignal::new()),
            );
            Self {
                server: TestServer::new(router).unwrap(),
                state,
                root,
                conversation_id,
                connection_id: connection_id.to_string(),
                session_id: session_id.to_string(),
            }
        }

        fn source_body(&self) -> Value {
            json!({
                "sourceConnectionId": self.connection_id,
                "sourceConversationId": self.conversation_id,
                "sourceAgentType": "codex",
            })
        }

        async fn post(&self, path: &str, body: Value) -> TestResponse {
            self.server
                .post(path)
                .add_header("authorization", format!("Bearer {TOKEN}"))
                .json(&body)
                .await
        }

        async fn seed_side(&self, id: Uuid, title: &str) {
            self.seed_side_with(id, title, &format!("child-{id}")).await;
        }

        async fn seed_side_with(&self, id: Uuid, title: &str, native_session_id: &str) {
            side_question_service::create(
                &self.state.db.conn,
                side_question_service::NewSideQuestion {
                    id,
                    source_agent: AgentType::Codex,
                    source_session_id: self.session_id.clone(),
                    native_session_id: native_session_id.into(),
                    cwd: self
                        .root
                        .path()
                        .join("workspace")
                        .to_string_lossy()
                        .into_owned(),
                    pi_session_file: None,
                    title: title.into(),
                },
            )
            .await
            .expect("seed side question");
        }
    }

    #[tokio::test]
    async fn native_session_routes_require_a_bearer_token() {
        let fixture = Fixture::new("conn-auth", "session-auth").await;
        let response = fixture
            .server
            .post("/api/native_session_list")
            .json(&fixture.source_body())
            .await;
        assert_eq!(response.status_code(), 401, "{}", response.text());
    }

    #[tokio::test]
    async fn list_returns_camel_case_side_questions() {
        let fixture = Fixture::new("conn-list", "session-list").await;
        let id = Uuid::from_u128(11);
        fixture.seed_side(id, "仍然打开").await;

        let response = fixture
            .post("/api/native_session_list", fixture.source_body())
            .await;
        assert_eq!(response.status_code(), 200, "{}", response.text());
        let rows: Vec<Value> = response.json();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], id.to_string());
        assert_eq!(rows[0]["sourceSessionId"], "session-list");
        assert_eq!(rows[0]["branchSessionId"], format!("child-{id}"));
        assert_eq!(rows[0]["agentType"], "codex");
        assert_eq!(rows[0]["isOpen"], true);
        assert!(rows[0].get("source_session_id").is_none());
    }

    #[tokio::test]
    async fn create_side_requires_a_source_conversation() {
        let fixture = Fixture::new("conn-create", "session-create").await;
        let response = fixture
            .post(
                "/api/native_session_create_side",
                json!({
                    "sourceConnectionId": fixture.connection_id,
                    "sourceConversationId": null,
                    "sourceAgentType": "codex",
                    "requestId": "request-create",
                    "title": "为什么？",
                }),
            )
            .await;
        assert_eq!(response.status_code(), 400, "{}", response.text());
    }

    #[tokio::test]
    async fn create_side_refuses_an_empty_title_before_forking() {
        let fixture = Fixture::new("conn-create-title", "session-create-title").await;
        let response = fixture
            .post(
                "/api/native_session_create_side",
                json!({
                    "sourceConnectionId": fixture.connection_id,
                    "sourceConversationId": fixture.conversation_id,
                    "sourceAgentType": "codex",
                    "requestId": "request-empty-title",
                    "title": "   ",
                }),
            )
            .await;
        assert_eq!(response.status_code(), 400, "{}", response.text());
        assert!(
            side_question_service::list_by_source(
                &fixture.state.db.conn,
                AgentType::Codex,
                &fixture.session_id,
            )
            .await
            .expect("list")
            .is_empty(),
            "an invalid create must not leave a side question behind"
        );
    }

    #[tokio::test]
    async fn open_side_refuses_a_row_that_points_at_the_source_session() {
        let fixture = Fixture::new("conn-open", "session-open").await;
        let id = Uuid::from_u128(12);
        fixture
            .seed_side_with(id, "指向主线", &fixture.session_id)
            .await;

        let response = fixture
            .post(
                "/api/native_session_open_side",
                json!({ "sideQuestionId": id.to_string() }),
            )
            .await;
        assert_eq!(response.status_code(), 400, "{}", response.text());
    }

    #[tokio::test]
    async fn open_side_reports_unknown_ids() {
        let fixture = Fixture::new("conn-open-missing", "session-open-missing").await;
        let response = fixture
            .post(
                "/api/native_session_open_side",
                json!({ "sideQuestionId": Uuid::from_u128(404).to_string() }),
            )
            .await;
        assert_eq!(response.status_code(), 404, "{}", response.text());
    }

    #[tokio::test]
    async fn close_side_closes_the_row() {
        let fixture = Fixture::new("conn-close", "session-close").await;
        let id = Uuid::from_u128(13);
        fixture.seed_side(id, "待关闭").await;

        let response = fixture
            .post(
                "/api/native_session_close_side",
                json!({ "sideQuestionId": id.to_string() }),
            )
            .await;
        assert_eq!(response.status_code(), 200, "{}", response.text());

        let row = side_question_service::get(&fixture.state.db.conn, id)
            .await
            .expect("get")
            .expect("row exists");
        assert!(!row.is_open);
    }

    #[tokio::test]
    async fn close_main_rejects_a_terminal_owned_by_another_connection() {
        let fixture = Fixture::new("conn-main", "session-main").await;
        let response = fixture
            .post(
                "/api/native_session_close_main",
                json!({
                    "sourceConnectionId": fixture.connection_id,
                    "terminalId": "native-main-someone-else",
                }),
            )
            .await;
        assert_eq!(response.status_code(), 403, "{}", response.text());
    }
}
