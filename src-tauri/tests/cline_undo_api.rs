use std::sync::Arc;

use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::db::service::{agent_setting_service, conversation_service};
use codeg_lib::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use codeg_lib::models::AgentType;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use serde_json::{json, Value};

const TOKEN: &str = "cline-undo-integration-test";
const SESSION_ID: &str = "cline-undo-session";
const IMAGE_BYTES: &str = "b3JpZ2luYWw=";

struct Fixture {
    server: TestServer,
    state: Arc<AppState>,
    root: tempfile::TempDir,
    conversation_id: i32,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("cline-undo-api-")
            .tempdir()
            .expect("isolated Cline fixture root");
        let workspace = root.path().join("workspace");
        let data_dir = root.path().join("cline-data");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(workspace.join("keep.txt"), "current workspace content").unwrap();

        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, &workspace.to_string_lossy()).await;
        let conversation_id = seed_conversation(&db, folder_id, AgentType::Cline).await;
        conversation_service::bind_external_id(&db.conn, conversation_id, SESSION_ID, &[])
            .await
            .unwrap();
        agent_setting_service::ensure_defaults(
            &db.conn,
            &[agent_setting_service::AgentDefaultInput {
                agent_type: AgentType::Cline,
                registry_id: "cline".into(),
                default_sort_order: 0,
            }],
        )
        .await
        .unwrap();
        agent_setting_service::update_preferences(
            &db.conn,
            AgentType::Cline,
            true,
            Some(json!({"CLINE_DATA_DIR": data_dir}).to_string()),
        )
        .await
        .unwrap();

        let state = Arc::new(AppState::new_for_test(db, root.path().join("codeg-data")));
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
        }
    }

    fn data_dir(&self) -> std::path::PathBuf {
        self.root.path().join("cline-data")
    }

    fn workspace(&self) -> std::path::PathBuf {
        self.root.path().join("workspace")
    }

    fn write_native_fixture(&self) {
        use rusqlite::params;

        let session_dir = self.data_dir().join("sessions").join(SESSION_ID);
        let db_dir = self.data_dir().join("db");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::create_dir_all(&db_dir).unwrap();
        let messages_path = session_dir.join(format!("{SESSION_ID}.messages.json"));
        let manifest_path = session_dir.join(format!("{SESSION_ID}.json"));
        let base_ts = 1_792_315_200_000_i64;
        let original_prompt = "  Keep  exact input\n ";
        let messages = json!({
            "updated_at": "2026-11-18T00:00:03.000Z",
            "messages": [
                {
                    "id": "user-1", "role": "user", "ts": base_ts,
                    "content": [{"type": "text", "text": "<user_input mode=\"act\">Keep this prompt</user_input>"}],
                    "metadata": {}
                },
                {
                    "id": "assistant-1", "role": "assistant", "ts": base_ts + 1,
                    "content": [{"type": "text", "text": "Kept answer"}],
                    "metadata": {}
                },
                {
                    "id": "user-2", "role": "user", "ts": base_ts + 2,
                    "content": [
                        {"type": "text", "text": format!("<user_input mode=\"act\">{original_prompt}</user_input>")},
                        {"type": "image", "source": {
                            "type": "base64", "media_type": "image/png", "data": IMAGE_BYTES
                        }}
                    ],
                    "metadata": {}
                },
                {
                    "id": "assistant-2", "role": "assistant", "ts": base_ts + 3,
                    "content": [{"type": "text", "text": "Undo this answer"}],
                    "metadata": {}
                }
            ]
        });
        std::fs::write(&messages_path, serde_json::to_vec(&messages).unwrap()).unwrap();
        std::fs::write(
            &manifest_path,
            serde_json::to_vec(&json!({
                "version": 1,
                "session_id": SESSION_ID,
                "source": "cli",
                "started_at": "2026-11-18T00:00:00.000Z",
                "status": "completed",
                "interactive": true,
                "provider": "test",
                "model": "synthetic",
                "cwd": self.workspace(),
                "workspace_root": self.workspace(),
                "enable_tools": false,
                "enable_spawn": false,
                "enable_teams": false,
                "prompt": "Keep this prompt",
                "metadata": {"title": "Cline Undo fixture"},
                "messages_path": messages_path
            }))
            .unwrap(),
        )
        .unwrap();

        let index = rusqlite::Connection::open(db_dir.join("sessions.db")).unwrap();
        index
            .execute_batch(
                "CREATE TABLE sessions (
                    session_id TEXT PRIMARY KEY,
                    parent_session_id TEXT,
                    is_subagent INTEGER NOT NULL DEFAULT 0,
                    messages_path TEXT NOT NULL,
                    status TEXT NOT NULL,
                    status_lock INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );",
            )
            .unwrap();
        index
            .execute(
                "INSERT INTO sessions (session_id, parent_session_id, is_subagent, messages_path, status, status_lock, updated_at)
                 VALUES (?1, NULL, 0, ?2, 'completed', 0, '2026-11-18T00:00:03.000Z')",
                params![SESSION_ID, messages_path.to_string_lossy()],
            )
            .unwrap();
    }

    async fn history(&self) -> Value {
        let response = self
            .server
            .post("/api/get_folder_conversation")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({"conversationId": self.conversation_id}))
            .await;
        assert_eq!(response.status_code(), 200, "{}", response.text());
        response.json()
    }

    async fn preview(&self) -> Value {
        let history = self.history().await;
        let selected = history["turns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|turn| turn["blocks"][0]["text"] == "Keep  exact input")
            .expect("selected Cline prompt is visible through public history");
        let response = self
            .server
            .post("/api/conversation_undo_preview")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({
                "conversationId": self.conversation_id,
                "sourceTurnId": selected["id"]
            }))
            .await;
        assert_eq!(response.status_code(), 200, "{}", response.text());
        response.json()
    }

    async fn commit(&self, preview: &Value) -> Value {
        let response = self
            .server
            .post("/api/conversation_undo_commit")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({
                "conversationId": self.conversation_id,
                "sourceTurnId": preview["sourceTurnId"],
                "historyRevision": preview["historyRevision"]
            }))
            .await;
        assert_eq!(response.status_code(), 200, "{}", response.text());
        response.json()
    }

    async fn redo(&self) -> Value {
        let db = codeg_lib::db::AppDatabase {
            conn: self.state.db.conn.clone(),
        };
        let state = Arc::new(AppState::new_for_test(
            db,
            self.root.path().join("codeg-data"),
        ));
        let server = TestServer::new(build_router(
            state,
            TOKEN.into(),
            self.root.path().join("static"),
            Arc::new(ShutdownSignal::new()),
        ))
        .unwrap();
        let response = server
            .post("/api/conversation_redo")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({"conversationId": self.conversation_id}))
            .await;
        assert_eq!(response.status_code(), 200, "{}", response.text());
        response.json()
    }
}

#[tokio::test]
async fn cline_undo_redo_preserves_native_identity_prompt_bytes_and_image() {
    let fixture = Fixture::new().await;
    fixture.write_native_fixture();
    let session_dir = fixture.data_dir().join("sessions").join(SESSION_ID);
    let messages_path = session_dir.join(format!("{SESSION_ID}.messages.json"));
    let original_file = std::fs::read(&messages_path).unwrap();
    let original: Value = serde_json::from_slice(&original_file).unwrap();

    let preview = fixture.preview().await;
    assert_eq!(preview["sessionId"], SESSION_ID);
    assert!(preview["issues"].as_array().unwrap().is_empty());
    assert_eq!(preview["input"][0]["text"], "  Keep  exact input\n ");
    assert_eq!(preview["input"][1]["type"], "image");
    assert_eq!(preview["input"][1]["data"], IMAGE_BYTES);
    assert_eq!(std::fs::read(&messages_path).unwrap(), original_file);

    let committed = fixture.commit(&preview).await;
    assert_eq!(committed["sessionId"], SESSION_ID);
    let after_undo: Value =
        serde_json::from_slice(&std::fs::read(&messages_path).unwrap()).unwrap();
    assert_eq!(after_undo["messages"].as_array().unwrap().len(), 2);
    assert_eq!(
        after_undo["messages"][0], original["messages"][0],
        "the earlier native message remains byte-for-byte intact"
    );
    assert_eq!(
        fixture.history().await["summary"]["external_id"],
        SESSION_ID
    );

    let redone = fixture.redo().await;
    assert_eq!(redone["sessionId"], SESSION_ID);
    assert_eq!(std::fs::read(&messages_path).unwrap(), original_file);
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        4
    );
    assert_eq!(
        std::fs::read_to_string(fixture.workspace().join("keep.txt")).unwrap(),
        "current workspace content"
    );
}

#[tokio::test]
async fn cline_preview_blocks_compaction_and_child_session_context() {
    let compacted = Fixture::new().await;
    compacted.write_native_fixture();
    std::fs::write(
        compacted
            .data_dir()
            .join("sessions")
            .join(SESSION_ID)
            .join(format!("{SESSION_ID}.compaction.json")),
        br#"{"version":1}"#,
    )
    .unwrap();
    let preview = compacted.preview().await;
    assert!(!preview["issues"].as_array().unwrap().is_empty());

    let child_session = Fixture::new().await;
    child_session.write_native_fixture();
    let index = rusqlite::Connection::open(child_session.data_dir().join("db").join("sessions.db"))
        .unwrap();
    index
        .execute(
            "INSERT INTO sessions (session_id, parent_session_id, is_subagent, messages_path, status, status_lock, updated_at)
             VALUES ('cline-child', ?1, 1, 'synthetic-child.messages.json', 'completed', 0, '2026-11-18T00:00:03.000Z')",
            [SESSION_ID],
        )
        .unwrap();
    let preview = child_session.preview().await;
    assert!(!preview["issues"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn cline_unclaimed_native_spawn_or_redirected_compaction_pauses_undo() {
    let fixture = Fixture::new().await;
    fixture.write_native_fixture();
    let index = rusqlite::Connection::open(fixture.data_dir().join("db/sessions.db")).unwrap();
    index
        .execute_batch(
            "CREATE TABLE subagent_spawn_queue (
            id INTEGER PRIMARY KEY, root_session_id TEXT, parent_agent_id TEXT,
            task TEXT, system_prompt TEXT, created_at TEXT, consumed_at TEXT
         );",
        )
        .unwrap();
    index
        .execute(
            "INSERT INTO subagent_spawn_queue (root_session_id, parent_agent_id, task, consumed_at)
         VALUES (?1, 'main', 'still queued', NULL)",
            [SESSION_ID],
        )
        .unwrap();
    let original = fixture.history().await;
    assert!(
        !fixture.preview().await["issues"]
            .as_array()
            .unwrap()
            .is_empty(),
        "an unclaimed native task can still return work into this conversation"
    );
    index
        .execute(
            "DELETE FROM subagent_spawn_queue WHERE root_session_id = ?1",
            [SESSION_ID],
        )
        .unwrap();

    let manifest_path = fixture
        .data_dir()
        .join("sessions")
        .join(SESSION_ID)
        .join(format!("{SESSION_ID}.json"));
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["compaction_path"] = json!(fixture.root.path().join("custom.compaction.json"));
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(
        !fixture.preview().await["issues"]
            .as_array()
            .unwrap()
            .is_empty(),
        "an unverified compaction path cannot be treated as absent compaction"
    );
    assert_eq!(fixture.history().await["turns"], original["turns"]);
}

#[tokio::test]
async fn cline_image_only_message_is_a_saved_undo_start_and_refills_original_image() {
    let fixture = Fixture::new().await;
    fixture.write_native_fixture();
    let path = fixture
        .data_dir()
        .join("sessions")
        .join(SESSION_ID)
        .join(format!("{SESSION_ID}.messages.json"));
    let mut messages: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let image = messages["messages"][2]["content"][1].clone();
    messages["messages"][2]["content"] = json!([image]);
    std::fs::write(&path, serde_json::to_vec(&messages).unwrap()).unwrap();
    let history = fixture.history().await;
    let selected = history["turns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|turn| {
            turn["role"] == "user"
                && turn["blocks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|block| block["type"] == "image")
        })
        .expect("the saved image-only user message remains visible and selectable");
    let response = fixture
        .server
        .post("/api/conversation_undo_preview")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":selected["id"]}))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    let preview: Value = response.json();
    assert!(
        preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    assert_eq!(
        preview["input"],
        json!([{
            "type":"image","data":IMAGE_BYTES,"mime_type":"image/png","uri":null,
        }])
    );
    fixture.commit(&preview).await;
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    fixture.redo().await;
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        4
    );
}

#[tokio::test]
async fn cline_hub_override_pauses_undo_until_native_cache_rewind_is_verified() {
    let fixture = Fixture::new().await;
    fixture.write_native_fixture();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::Cline,
        true,
        Some(
            json!({
                "CLINE_DATA_DIR":fixture.data_dir(),
                "CLINE_SESSION_BACKEND_MODE":"hub",
            })
            .to_string(),
        ),
    )
    .await
    .unwrap();
    let preview = fixture.preview().await;
    assert!(
        !preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    let before = fixture.history().await;
    let rejected = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId":fixture.conversation_id,
            "sourceTurnId":preview["sourceTurnId"],
            "historyRevision":preview["historyRevision"],
        }))
        .await;
    assert_eq!(rejected.status_code(), 400, "{}", rejected.text());
    assert_eq!(fixture.history().await["turns"], before["turns"]);
}

#[tokio::test]
async fn cline_removing_the_local_backend_default_does_not_authorize_auto_undo() {
    let fixture = Fixture::new().await;
    fixture.write_native_fixture();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::Cline,
        true,
        Some(
            json!({
                "CLINE_DATA_DIR":fixture.data_dir(),
                "CLINE_SESSION_BACKEND_MODE":"",
            })
            .to_string(),
        ),
    )
    .await
    .unwrap();
    let preview = fixture.preview().await;
    assert!(
        !preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
}

#[tokio::test]
async fn cline_a_live_external_native_owner_keeps_the_original_history() {
    let fixture = Fixture::new().await;
    fixture.write_native_fixture();
    let session_dir = fixture.data_dir().join("sessions").join(SESSION_ID);
    let manifest_path = session_dir.join(format!("{SESSION_ID}.json"));
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["pid"] = json!(std::process::id());
    manifest["status"] = json!("idle");
    std::fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let index = rusqlite::Connection::open(fixture.data_dir().join("db/sessions.db")).unwrap();
    index
        .execute(
            "UPDATE sessions SET status = 'idle' WHERE session_id = ?1",
            [SESSION_ID],
        )
        .unwrap();
    let preview = fixture.preview().await;
    let before = fixture.history().await;
    let rejected = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId":fixture.conversation_id,
            "sourceTurnId":preview["sourceTurnId"],
            "historyRevision":preview["historyRevision"],
        }))
        .await;
    assert_eq!(rejected.status_code(), 409, "{}", rejected.text());
    assert_eq!(fixture.history().await["turns"], before["turns"]);
}

#[tokio::test]
async fn cline_unknown_active_owner_or_live_completed_owner_never_allows_file_rewind() {
    for (status, pid) in [
        ("idle", Value::Null),
        ("completed", json!(std::process::id())),
    ] {
        let fixture = Fixture::new().await;
        fixture.write_native_fixture();
        let manifest_path = fixture
            .data_dir()
            .join("sessions")
            .join(SESSION_ID)
            .join(format!("{SESSION_ID}.json"));
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["status"] = json!(status);
        manifest["pid"] = pid;
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let preview = fixture.preview().await;
        let before = fixture.history().await;
        let response = fixture
            .server
            .post("/api/conversation_undo_commit")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({
                "conversationId":fixture.conversation_id,
                "sourceTurnId":preview["sourceTurnId"],
                "historyRevision":preview["historyRevision"],
            }))
            .await;
        assert_eq!(response.status_code(), 409, "{status}: {}", response.text());
        assert_eq!(fixture.history().await["turns"], before["turns"]);
    }
}

#[tokio::test]
async fn cline_redo_survives_native_runtime_metadata_changes_without_restoring_old_owner() {
    let fixture = Fixture::new().await;
    fixture.write_native_fixture();
    let preview = fixture.preview().await;
    fixture.commit(&preview).await;

    let session_dir = fixture.data_dir().join("sessions").join(SESSION_ID);
    let manifest_path = session_dir.join(format!("{SESSION_ID}.json"));
    let messages_path = session_dir.join(format!("{SESSION_ID}.messages.json"));
    let mut manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["pid"] = json!(0);
    manifest["ended_at"] = json!("2026-11-18T01:00:00.000Z");
    manifest["status"] = json!("cancelled");
    manifest["exit_code"] = json!(130);
    let updated_manifest = serde_json::to_vec(&manifest).unwrap();
    std::fs::write(&manifest_path, &updated_manifest).unwrap();
    let mut messages: Value =
        serde_json::from_slice(&std::fs::read(&messages_path).unwrap()).unwrap();
    messages["updated_at"] = json!("2026-11-18T01:00:00.000Z");
    std::fs::write(&messages_path, serde_json::to_vec(&messages).unwrap()).unwrap();
    let index = rusqlite::Connection::open(fixture.data_dir().join("db/sessions.db")).unwrap();
    index
        .execute(
            "UPDATE sessions SET status = 'cancelled', status_lock = status_lock + 1,
         updated_at = '2026-11-18T01:00:00.000Z' WHERE session_id = ?1",
            [SESSION_ID],
        )
        .unwrap();

    let response = fixture
        .server
        .post("/api/conversation_redo_status")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    let status: Value = response.json();
    assert_eq!(status["available"], true, "{status}");
    fixture.redo().await;
    assert_eq!(std::fs::read(&manifest_path).unwrap(), updated_manifest);
    let restored: Value = serde_json::from_slice(&std::fs::read(&messages_path).unwrap()).unwrap();
    assert_eq!(restored["messages"].as_array().unwrap().len(), 4);
    assert_eq!(restored["updated_at"], "2026-11-18T01:00:00.000Z");
    let status: String = index
        .query_row(
            "SELECT status FROM sessions WHERE session_id = ?1",
            [SESSION_ID],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "cancelled");
}

#[tokio::test]
async fn cline_redo_never_overwrites_changed_native_input_or_model_context() {
    for changed_field in ["text", "image", "system_prompt"] {
        let fixture = Fixture::new().await;
        fixture.write_native_fixture();
        let preview = fixture.preview().await;
        fixture.commit(&preview).await;
        let path = fixture
            .data_dir()
            .join("sessions")
            .join(SESSION_ID)
            .join(format!("{SESSION_ID}.messages.json"));
        let mut messages: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        match changed_field {
            "text" => messages["messages"][0]["content"][0]["text"] = json!("New native input"),
            "image" => {
                messages["messages"][0]["content"] = json!([{
                    "type":"image","source":{"type":"base64","media_type":"image/png","data":IMAGE_BYTES}
                }])
            }
            _ => messages["system_prompt"] = json!("New native model context"),
        }
        let changed = serde_json::to_vec(&messages).unwrap();
        std::fs::write(&path, &changed).unwrap();
        let response = fixture
            .server
            .post("/api/conversation_redo_status")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({"conversationId":fixture.conversation_id}))
            .await;
        assert_eq!(response.status_code(), 200, "{}", response.text());
        let status: Value = response.json();
        assert_eq!(status["available"], false, "{changed_field}: {status}");
        let response = fixture
            .server
            .post("/api/conversation_redo")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({"conversationId":fixture.conversation_id}))
            .await;
        assert_eq!(response.status_code(), 400, "{}", response.text());
        assert_eq!(std::fs::read(&path).unwrap(), changed);
    }
}

#[tokio::test]
async fn cline_confirmed_undo_stops_only_its_current_task_before_replacing_history() {
    use codeg_lib::acp::connection::ConnectionCommand;
    use codeg_lib::acp::types::{AcpEvent, ConnectionStatus};

    let fixture = Fixture::new().await;
    fixture.write_native_fixture();
    let manager = &fixture.state.connection_manager;
    let mut commands = manager
        .insert_test_connection_live(
            "cline-running",
            AgentType::Cline,
            Some(fixture.workspace()),
            fixture.state.emitter.clone(),
        )
        .await;
    let current = manager.get_state("cline-running").await.unwrap();
    {
        let mut state = current.write().await;
        state.external_id = Some(SESSION_ID.into());
        state.conversation_id = Some(fixture.conversation_id);
        state.status = ConnectionStatus::Prompting;
        state.turn_in_flight = true;
    }
    let _other = manager
        .insert_test_connection_live(
            "cline-other",
            AgentType::Cline,
            Some(fixture.workspace()),
            fixture.state.emitter.clone(),
        )
        .await;
    let other_state = manager.get_state("cline-other").await.unwrap();
    {
        let mut state = other_state.write().await;
        state.external_id = Some("unrelated-native-session".into());
        state.status = ConnectionStatus::Prompting;
        state.turn_in_flight = true;
    }
    let worker = tokio::spawn(async move {
        while let Some(command) = commands.recv().await {
            match command {
                ConnectionCommand::Cancel => {
                    current.write().await.apply_event(&AcpEvent::TurnComplete {
                        session_id: SESSION_ID.into(),
                        stop_reason: "cancelled".into(),
                        agent_type: "cline".into(),
                    })
                }
                ConnectionCommand::Disconnect => break,
                _ => {}
            }
        }
    });
    let preview = fixture.preview().await;
    assert_eq!(preview["tasks"].as_array().unwrap().len(), 1);
    let response = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId":fixture.conversation_id,
            "sourceTurnId":preview["sourceTurnId"],
            "historyRevision":preview["historyRevision"],
            "stopConfirmed":true,
        }))
        .await;
    let status = response.status_code();
    let body = response.text();
    let _ = manager.disconnect("cline-running").await;
    manager.disconnect("cline-other").await.unwrap();
    worker.await.unwrap();
    assert_eq!(status, 200, "{body}");
    assert!(other_state.read().await.turn_in_flight);
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_CLINE_SDK pointing to @cline/core/dist/index.js"]
async fn cline_sdk_cold_reads_undo_and_redo_from_the_same_session_id() {
    let sdk = std::env::var("CODEG_TEST_CLINE_SDK").expect("native Cline SDK module path");
    let fixture = Fixture::new().await;
    native_cline(&sdk, "seed", &fixture).await;
    let original = native_cline(&sdk, "read", &fixture).await;
    assert_eq!(original["sessionId"], SESSION_ID);
    assert_eq!(original["messages"].as_array().unwrap().len(), 4);

    let preview = fixture.preview().await;
    assert!(
        preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    fixture.commit(&preview).await;
    let undone = native_cline(&sdk, "read", &fixture).await;
    assert_eq!(undone["sessionId"], SESSION_ID);
    assert_eq!(undone["messages"].as_array().unwrap().len(), 2);
    assert_eq!(
        native_cline(&sdk, "resave", &fixture).await,
        undone,
        "a native persistence cycle must not invalidate Redo without new context"
    );

    fixture.redo().await;
    let redone = native_cline(&sdk, "read", &fixture).await;
    assert_eq!(redone, original);
}

async fn native_cline(sdk: &str, action: &str, fixture: &Fixture) -> Value {
    use std::process::Stdio;

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        codeg_lib::process::tokio_command("node")
            .arg("--input-type=module")
            .arg("-e")
            .arg(include_str!("fixtures/conversation_undo/native_cline.mjs"))
            .arg(sdk)
            .arg(action)
            .arg(fixture.data_dir())
            .arg(fixture.workspace())
            .arg(SESSION_ID)
            .env("CLINE_DATA_DIR", fixture.data_dir())
            .env("CLINE_TELEMETRY_DISABLED", "1")
            .env("DO_NOT_TRACK", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("native SDK process timeout")
    .expect("native SDK process starts");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("native SDK JSON output")
}
