use std::sync::Arc;

use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::db::service::{agent_setting_service, conversation_service};
use codeg_lib::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use codeg_lib::models::AgentType;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use serde_json::{json, Value};

const TOKEN: &str = "undo-integration-test";
const NATIVE_IMAGE: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

struct Fixture {
    server: TestServer,
    state: Arc<AppState>,
    root: tempfile::TempDir,
    conversation_id: i32,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().expect("isolated undo files");
        let workspace = root.path().join("workspace");
        let home = root.path().join("claude");
        let project = home.join("projects").join("undo-project");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(workspace.join("keep.txt"), "current workspace content").unwrap();
        let records = [
            json!({
                "type": "user", "sessionId": "undo-session", "uuid": "user-1",
                "timestamp": "2026-11-17T01:00:00Z", "cwd": workspace,
                "message": {"role": "user", "content": [{"type": "text", "text": "Keep this question"}]}
            }),
            json!({
                "type": "assistant", "sessionId": "undo-session", "uuid": "reply-1",
                "parentUuid": "user-1", "timestamp": "2026-11-17T01:00:01Z",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "Keep this answer"}]}
            }),
            json!({
                "type": "user", "sessionId": "undo-session", "uuid": "user-2",
                "parentUuid": "reply-1", "timestamp": "2026-11-17T01:01:00Z",
                "message": {"role": "user", "content": [
                    {"type": "text", "text": "Check this original image"},
                    {"type": "image", "source": {
                        "type": "base64", "media_type": "image/png", "data": "b3JpZ2luYWw="
                    }}
                ]}
            }),
            json!({
                "type": "assistant", "sessionId": "undo-session", "uuid": "reply-2",
                "parentUuid": "user-2", "timestamp": "2026-11-17T01:01:01Z",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "Undo this answer"}]}
            }),
        ];
        let history = records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(project.join("undo-session.jsonl"), format!("{history}\n")).unwrap();

        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, &workspace.to_string_lossy()).await;
        let conversation_id = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        conversation_service::bind_external_id(&db.conn, conversation_id, "undo-session", &[])
            .await
            .unwrap();
        agent_setting_service::ensure_defaults(
            &db.conn,
            &[agent_setting_service::AgentDefaultInput {
                agent_type: AgentType::ClaudeCode,
                registry_id: "claude-acp".into(),
                default_sort_order: 0,
            }],
        )
        .await
        .unwrap();
        agent_setting_service::update_preferences(
            &db.conn,
            AgentType::ClaudeCode,
            true,
            Some(json!({"CLAUDE_CONFIG_DIR": home}).to_string()),
        )
        .await
        .unwrap();
        let state = Arc::new(AppState::new_for_test(db, root.path().join("data")));
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
        self.preview_text("Check this original image").await
    }

    async fn preview_text(&self, text: &str) -> Value {
        let history = self.history().await;
        let selected = history["turns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|turn| turn["blocks"][0]["text"] == text)
            .unwrap();
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

    fn reopen(&self) -> TestServer {
        let db = codeg_lib::db::AppDatabase {
            conn: self.state.db.conn.clone(),
        };
        let state = Arc::new(AppState::new_for_test(db, self.root.path().join("data")));
        TestServer::new(build_router(
            state,
            TOKEN.into(),
            self.root.path().join("static"),
            Arc::new(ShutdownSignal::new()),
        ))
        .unwrap()
    }
}

async fn native_codex_turn_ids(home: &std::path::Path, session_id: &str) -> Vec<String> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let runtime = codeg_lib::acp::codex_runtime::current().await;
    let program = runtime.codex_js.expect("installed Codex ACP runtime");
    let mut child = codeg_lib::process::tokio_command("node")
        .arg(program)
        .arg("app-server")
        .env("CODEX_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let requests = [
        json!({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "codeg_native_history_test", "version": "1"},
            "capabilities": {"experimentalApi": true}
        }}),
        json!({"id": 2, "method": "thread/resume", "params": {
            "threadId": session_id, "excludeTurns": true
        }}),
        json!({"id": 3, "method": "thread/turns/list", "params": {
            "threadId": session_id, "limit": 100
        }}),
    ];
    let mut result = Value::Null;
    for request in requests {
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        stdin.flush().await.unwrap();
        result = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                let line = lines
                    .next_line()
                    .await
                    .unwrap()
                    .expect("native history reply");
                let response: Value = serde_json::from_str(&line).unwrap();
                if response["id"] == request["id"] {
                    assert!(response.get("error").is_none(), "{response}");
                    break response["result"].clone();
                }
            }
        })
        .await
        .expect("native history request completed");
        if request["id"] == 1 {
            stdin
                .write_all(b"{\"method\":\"initialized\",\"params\":{}}\n")
                .await
                .unwrap();
        }
    }
    stdin.shutdown().await.unwrap();
    let exited = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
    if exited.is_err() {
        if let Some(pid) = child.id() {
            #[cfg(windows)]
            let _ = codeg_lib::process::tokio_command("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output()
                .await;
            #[cfg(not(windows))]
            let _ = child.kill().await;
        }
    }
    result["data"]
        .as_array()
        .expect("native turns page")
        .iter()
        .map(|turn| turn["id"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
#[ignore = "requires an installed native Codex ACP runtime; run explicitly"]
async fn native_codex_undo_and_redo_keep_identity_and_reload_both_original_turns() {
    let mut fixture = Fixture::new().await;
    let home = fixture.root.path().join("codex");
    let now = chrono::Utc::now() - chrono::Duration::seconds(20);
    let sessions = home
        .join("sessions")
        .join(now.format("%Y/%m/%d").to_string());
    std::fs::create_dir_all(&sessions).unwrap();
    let session_id = "71361130-8b6d-4d8e-a904-4d045bb55a21";
    let first_turn = "11111111-1111-4111-8111-111111111111";
    let second_turn = "22222222-2222-4222-8222-222222222222";
    let workspace = fixture.root.path().join("workspace");
    let mut records = Vec::new();
    let mut record = |kind: &str, payload: Value, offset: i64| {
        records.push(json!({
            "ordinal": records.len(),
            "timestamp": (now + chrono::Duration::milliseconds(offset)).to_rfc3339(),
            "type": kind, "payload": payload
        }));
    };
    record(
        "session_meta",
        json!({
            "id": session_id, "session_id": session_id, "timestamp": now.to_rfc3339(),
            "cwd": workspace, "originator": "codex_cli_rs", "cli_version": "0.166.0",
            "history_mode": "paginated", "model_provider": "openai", "source": "cli"
        }),
        0,
    );
    for (turn, question, answer, offset) in [
        (first_turn, "Keep native prompt", "Keep native answer", 1000),
        (
            second_turn,
            "Undo native prompt",
            "Undo native answer",
            4000,
        ),
    ] {
        record(
            "event_msg",
            json!({"type": "task_started", "turn_id": turn}),
            offset,
        );
        record(
            "event_msg",
            json!({"type": "user_message", "message": question, "images":
                if turn == second_turn { vec![format!("data:image/png;base64,{NATIVE_IMAGE}")] } else { Vec::new() }
            }),
            offset + 10,
        );
        let mut content = vec![json!({"type": "input_text", "text": question})];
        if turn == second_turn {
            content.push(json!({"type": "input_image", "image_url": format!("data:image/png;base64,{NATIVE_IMAGE}")}));
        }
        record(
            "response_item",
            json!({"type": "message", "role": "user",
            "content": content}),
            offset + 10,
        );
        record(
            "response_item",
            json!({"type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": answer}]}),
            offset + 100,
        );
        record(
            "event_msg",
            json!({"type": "agent_message", "message": answer}),
            offset + 100,
        );
        record(
            "event_msg",
            json!({"type": "task_complete", "turn_id": turn}),
            offset + 200,
        );
    }
    let rollout = sessions.join(format!(
        "rollout-{}-{session_id}.jsonl",
        now.with_timezone(&chrono::Local)
            .format("%Y-%m-%dT%H-%M-%S")
    ));
    std::fs::write(
        rollout,
        format!(
            "{}\n",
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .unwrap();
    let original = conversation_service::get_by_id(&fixture.state.db.conn, fixture.conversation_id)
        .await
        .unwrap();
    fixture.conversation_id =
        seed_conversation(&fixture.state.db, original.folder_id, AgentType::Codex).await;
    conversation_service::bind_external_id(
        &fixture.state.db.conn,
        fixture.conversation_id,
        session_id,
        &[],
    )
    .await
    .unwrap();
    agent_setting_service::ensure_defaults(
        &fixture.state.db.conn,
        &[agent_setting_service::AgentDefaultInput {
            agent_type: AgentType::Codex,
            registry_id: "codex-acp".into(),
            default_sort_order: 1,
        }],
    )
    .await
    .unwrap();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::Codex,
        true,
        Some(json!({"CODEX_HOME": home}).to_string()),
    )
    .await
    .unwrap();
    let preview = fixture.preview_text("Undo native prompt").await;
    let images = preview["prompt"]["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|block| block["type"] == "image")
        .collect::<Vec<_>>();
    assert_eq!(images.len(), 1);
    assert_eq!(images[0]["data"], NATIVE_IMAGE);
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"]
        }))
        .await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    assert_eq!(
        committed.json::<Value>()["prompt"]["blocks"],
        preview["prompt"]["blocks"]
    );
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    assert_eq!(
        native_codex_turn_ids(&home, session_id).await,
        vec![first_turn]
    );
    let restored = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(restored.status_code(), 200, "{}", restored.text());
    assert_eq!(restored.json::<Value>()["sessionId"], session_id);
    let mut native_turns = native_codex_turn_ids(&home, session_id).await;
    native_turns.sort();
    assert_eq!(native_turns, vec![first_turn, second_turn]);
    let after = fixture.history().await;
    assert_eq!(after["summary"]["external_id"], session_id);
    assert_eq!(after["turns"].as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn preview_returns_original_image_and_exact_range_without_changing_history_or_files() {
    let fixture = Fixture::new().await;
    let before = fixture.history().await;
    let selected = before["turns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|turn| turn["blocks"][0]["text"] == "Check this original image")
        .expect("saved image prompt is visible through the public history API");
    let response = fixture
        .server
        .post("/api/conversation_undo_preview")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": selected["id"]
        }))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    let preview: Value = response.json();
    assert_eq!(preview["sessionId"], "undo-session");
    assert_eq!(preview["sourceTurnId"], selected["id"]);
    assert_eq!(preview["affectedUserMessages"], 1);
    assert_eq!(preview["affectedTurns"], 2);
    assert_eq!(
        preview["prompt"]["blocks"][0]["text"],
        "Check this original image"
    );
    assert_eq!(preview["prompt"]["blocks"][1]["data"], "b3JpZ2luYWw=");
    assert_eq!(preview["prompt"]["blocks"][1]["mime_type"], "image/png");
    assert!(preview["historyRevision"]
        .as_str()
        .is_some_and(|revision| !revision.is_empty()));
    assert_eq!(fixture.history().await["turns"], before["turns"]);
    assert_eq!(
        std::fs::read_to_string(fixture.root.path().join("workspace/keep.txt")).unwrap(),
        "current workspace content"
    );
}

#[tokio::test]
async fn confirmed_image_prompt_is_undone_in_the_same_session_and_returned_whole() {
    let fixture = Fixture::new().await;
    let preview = fixture.preview().await;
    let response = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"]
        }))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    let result: Value = response.json();
    assert_eq!(result["sessionId"], "undo-session");
    assert_eq!(result["prompt"], preview["prompt"]);
    let after = fixture.history().await;
    assert_eq!(after["summary"]["external_id"], "undo-session");
    assert_eq!(after["turns"].as_array().unwrap().len(), 2);
    assert_eq!(after["turns"][0]["blocks"][0]["text"], "Keep this question");
    assert_eq!(after["turns"][1]["blocks"][0]["text"], "Keep this answer");
    assert_eq!(
        std::fs::read_to_string(fixture.root.path().join("workspace/keep.txt")).unwrap(),
        "current workspace content"
    );
}

#[tokio::test]
async fn redo_restores_the_original_session_after_reopening_the_server() {
    let fixture = Fixture::new().await;
    let original = fixture.history().await;
    let preview = fixture.preview().await;
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"]
        }))
        .await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    let reopened = fixture.reopen();
    let response = reopened
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    assert_eq!(response.json::<Value>()["sessionId"], "undo-session");
    assert_eq!(fixture.history().await["turns"], original["turns"]);
}

#[tokio::test]
async fn undo_preserves_the_current_draft_and_image_in_the_existing_collection() {
    let isolated_home = tempfile::tempdir().unwrap();
    temp_env::async_with_vars(
        [("CODEG_HOME", Some(isolated_home.path().to_str().unwrap()))],
        async {
            let fixture = Fixture::new().await;
            let preview = fixture.preview().await;
            let response = fixture
                .server
                .post("/api/conversation_undo_commit")
                .add_header("authorization", format!("Bearer {TOKEN}"))
                .json(&json!({
                    "conversationId": fixture.conversation_id,
                    "sourceTurnId": preview["sourceTurnId"],
                    "historyRevision": preview["historyRevision"],
                    "currentDraft": {
                        "text": "Keep my unsent draft",
                        "doc": {"type": "doc", "content": [
                            {"type": "paragraph", "content": [
                                {"type": "text", "text": "Keep my unsent draft"}
                            ]}
                        ]},
                        "attachments": [{
                            "id": "draft-image", "type": "image",
                            "data": "ZHJhZnQ=", "name": "draft.png",
                            "mimeType": "image/png", "uri": null
                        }],
                        "embeddedPayloads": {}
                    }
                }))
                .await;
            assert_eq!(response.status_code(), 200, "{}", response.text());
            let scope = format!("conv:{}", fixture.conversation_id);
            let entries = fixture
                .server
                .post("/api/list_prompt_stash")
                .add_header("authorization", format!("Bearer {TOKEN}"))
                .json(&json!({"scopeKey": scope}))
                .await;
            assert_eq!(entries.status_code(), 200, "{}", entries.text());
            let entries: Value = entries.json();
            assert_eq!(entries.as_array().unwrap().len(), 1);
            let restored = fixture
                .server
                .post("/api/restore_prompt_stash")
                .add_header("authorization", format!("Bearer {TOKEN}"))
                .json(&json!({"id": entries[0]["id"], "scopeKey": scope}))
                .await;
            assert_eq!(restored.status_code(), 200, "{}", restored.text());
            let draft: Value = restored.json();
            assert_eq!(draft["text"], "Keep my unsent draft");
            assert_eq!(draft["attachments"][0]["data"], "ZHJhZnQ=");
            assert_eq!(
                fixture.history().await["turns"].as_array().unwrap().len(),
                2
            );
        },
    )
    .await;
}

#[tokio::test]
async fn manually_clearing_redo_keeps_the_current_history() {
    let fixture = Fixture::new().await;
    let preview = fixture.preview().await;
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"]
        }))
        .await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    let before = fixture.history().await;
    let status = fixture
        .server
        .post("/api/conversation_redo_status")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(status.status_code(), 200, "{}", status.text());
    assert_eq!(status.json::<Value>()["available"], true);
    let cleared = fixture
        .server
        .post("/api/conversation_redo_clear")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(cleared.status_code(), 200, "{}", cleared.text());
    let status = fixture
        .server
        .post("/api/conversation_redo_status")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(status.status_code(), 200, "{}", status.text());
    assert_eq!(status.json::<Value>()["available"], false);
    assert_eq!(fixture.history().await["turns"], before["turns"]);
}

#[tokio::test]
async fn matching_text_and_timestamp_never_erase_an_earlier_user_message() {
    let fixture = Fixture::new().await;
    let native = fixture
        .root
        .path()
        .join("claude/projects/undo-project/undo-session.jsonl");
    let mut records: Vec<Value> = std::fs::read_to_string(&native)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    records[0]["timestamp"] = records[2]["timestamp"].clone();
    records[0]["message"]["content"] = records[2]["message"]["content"].clone();
    std::fs::write(
        native,
        format!(
            "{}\n",
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .unwrap();
    let before = fixture.history().await;
    let selected = before["turns"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|turn| turn["role"] == "user")
        .unwrap();
    let preview = fixture
        .server
        .post("/api/conversation_undo_preview")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": selected["id"]
        }))
        .await;
    assert_eq!(preview.status_code(), 200, "{}", preview.text());
    let preview: Value = preview.json();
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"]
        }))
        .await;
    assert!(
        [200, 400].contains(&committed.status_code().as_u16()),
        "{}",
        committed.text()
    );
    let after = fixture.history().await;
    assert!(after["turns"].as_array().unwrap().len() >= 2);
    assert_eq!(after["turns"][0], before["turns"][0]);
    assert_eq!(after["turns"][1], before["turns"][1]);
}

#[tokio::test]
async fn missing_original_image_is_listed_and_pauses_undo_without_changing_history() {
    let fixture = Fixture::new().await;
    let native = fixture
        .root
        .path()
        .join("claude/projects/undo-project/undo-session.jsonl");
    let mut records: Vec<Value> = std::fs::read_to_string(&native)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    records[2]["message"]["content"][1]["name"] = json!("lost.png");
    records[2]["message"]["content"][1]["source"]["data"] = json!("");
    std::fs::write(
        native,
        format!(
            "{}\n",
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        ),
    )
    .unwrap();
    let before = fixture.history().await;
    let preview = fixture.preview().await;
    assert_eq!(preview["issues"][0]["code"], "missing_original_attachment");
    assert_eq!(preview["issues"][0]["label"], "lost.png");
    let result = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"]
        }))
        .await;
    assert_eq!(result.status_code(), 400, "{}", result.text());
    assert_eq!(fixture.history().await["turns"], before["turns"]);
}

#[tokio::test]
async fn expired_redo_is_cleaned_after_seven_days_without_touching_active_history() {
    let fixture = Fixture::new().await;
    let preview = fixture.preview().await;
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"]
        }))
        .await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    let before = fixture.history().await;
    let now = std::time::SystemTime::now();
    let early = codeg_lib::conversation_undo::cleanup_expired(
        &fixture.state.connection_manager,
        &fixture.state.data_dir,
        now + std::time::Duration::from_secs(6 * 86400),
    )
    .await
    .unwrap();
    assert_eq!(early, 0);
    let expired = codeg_lib::conversation_undo::cleanup_expired(
        &fixture.state.connection_manager,
        &fixture.state.data_dir,
        now + std::time::Duration::from_secs(8 * 86400),
    )
    .await
    .unwrap();
    assert_eq!(expired, 1);
    let status = fixture
        .server
        .post("/api/conversation_redo_status")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(status.status_code(), 200, "{}", status.text());
    assert_eq!(status.json::<Value>()["available"], false);
    assert_eq!(fixture.history().await["turns"], before["turns"]);
}

#[tokio::test]
async fn confirmed_undo_stops_the_current_turn_and_leaves_other_sessions_running() {
    use codeg_lib::acp::connection::ConnectionCommand;
    use codeg_lib::acp::types::{AcpEvent, ConnectionStatus};

    let fixture = Fixture::new().await;
    let manager = &fixture.state.connection_manager;
    let workspace = Some(fixture.root.path().join("workspace"));
    let mut current = manager
        .insert_test_connection_live(
            "current-agent",
            AgentType::ClaudeCode,
            workspace.clone(),
            fixture.state.emitter.clone(),
        )
        .await;
    let _other = manager
        .insert_test_connection_live(
            "unrelated-agent",
            AgentType::ClaudeCode,
            workspace,
            fixture.state.emitter.clone(),
        )
        .await;
    let current_state = {
        let current = manager.get_state("current-agent").await.unwrap();
        let other = manager.get_state("unrelated-agent").await.unwrap();
        {
            let mut state = current.write().await;
            state.external_id = Some("undo-session".into());
            state.conversation_id = Some(fixture.conversation_id);
            state.status = ConnectionStatus::Prompting;
            state.turn_in_flight = true;
        }
        {
            let mut state = other.write().await;
            state.external_id = Some("unrelated-session".into());
            state.status = ConnectionStatus::Prompting;
            state.turn_in_flight = true;
        }
        current
    };
    let native_history = fixture
        .root
        .path()
        .join("claude/projects/undo-project/undo-session.jsonl");
    let agent = tokio::spawn(async move {
        while let Some(command) = current.recv().await {
            match command {
                ConnectionCommand::Cancel => {
                    use std::io::Write;
                    let final_output = json!({
                        "type": "assistant", "sessionId": "undo-session", "uuid": "stop-output",
                        "parentUuid": "reply-2", "timestamp": "2026-11-17T01:01:02Z",
                        "message": {"role": "assistant", "content": [
                            {"type": "text", "text": "Final output flushed while stopping"}
                        ]}
                    });
                    writeln!(
                        std::fs::OpenOptions::new()
                            .append(true)
                            .open(&native_history)
                            .unwrap(),
                        "{final_output}"
                    )
                    .unwrap();
                    current_state
                        .write()
                        .await
                        .apply_event(&AcpEvent::TurnComplete {
                            session_id: "undo-session".into(),
                            stop_reason: "cancelled".into(),
                            agent_type: "claude_code".into(),
                        });
                }
                ConnectionCommand::Disconnect => break,
                _ => {}
            }
        }
    });
    let preview = fixture.preview().await;
    let tasks = preview["tasks"]
        .as_array()
        .expect("running work is listed before confirmation");
    assert!(tasks
        .iter()
        .any(|task| task["kind"] == "turn"
            && task["id"].as_str().unwrap().starts_with("current-agent")));
    assert!(!tasks
        .iter()
        .any(|task| task["id"].as_str().unwrap().starts_with("unrelated-agent")));
    let result = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"],
            "stopConfirmed": true
        }))
        .await;
    assert_eq!(result.status_code(), 200, "{}", result.text());
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    let connections = manager.list_connections().await;
    let other = connections
        .iter()
        .find(|connection| connection.id == "unrelated-agent")
        .expect("unrelated session remains connected");
    assert!(matches!(other.status, ConnectionStatus::Prompting));
    agent.await.unwrap();
}

#[tokio::test]
async fn sending_during_undo_is_rejected_without_queuing_and_other_sessions_can_send() {
    use codeg_lib::acp::connection::ConnectionCommand;
    use codeg_lib::acp::types::{AcpEvent, ConnectionStatus, PromptInputBlock};
    let fixture = Fixture::new().await;
    let manager = &fixture.state.connection_manager;
    let mut receiver = manager
        .insert_test_connection_live(
            "undo-owner",
            AgentType::ClaudeCode,
            None,
            fixture.state.emitter.clone(),
        )
        .await;
    let _other = manager
        .insert_test_connection_live(
            "other-owner",
            AgentType::ClaudeCode,
            None,
            fixture.state.emitter.clone(),
        )
        .await;
    let current = manager.get_state("undo-owner").await.unwrap();
    {
        let mut state = current.write().await;
        state.external_id = Some("undo-session".into());
        state.conversation_id = Some(fixture.conversation_id);
        state.status = ConnectionStatus::Prompting;
        state.turn_in_flight = true;
    }
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let stopping = reached.clone();
    let stopped = release.clone();
    let worker = tokio::spawn(async move {
        while let Some(command) = receiver.recv().await {
            match command {
                ConnectionCommand::Cancel => {
                    stopping.notify_one();
                    stopped.notified().await;
                    current.write().await.apply_event(&AcpEvent::TurnComplete {
                        session_id: "undo-session".into(),
                        stop_reason: "cancelled".into(),
                        agent_type: "claude_code".into(),
                    });
                }
                ConnectionCommand::Disconnect => break,
                _ => {}
            }
        }
    });
    let preview = fixture.preview().await;
    let payload = json!({
        "conversationId": fixture.conversation_id,
        "sourceTurnId": preview["sourceTurnId"],
        "historyRevision": preview["historyRevision"],
        "stopConfirmed": true
    });
    let undo = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&payload);
    let competing = async {
        reached.notified().await;
        let rejected = manager
            .send_prompt(
                "undo-owner",
                vec![PromptInputBlock::Text {
                    text: "Keep this unsent".into(),
                }],
            )
            .await;
        let unrelated = manager
            .send_prompt(
                "other-owner",
                vec![PromptInputBlock::Text {
                    text: "Send this independent prompt".into(),
                }],
            )
            .await;
        let clearing = fixture
            .server
            .post("/api/conversation_redo_clear")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({"conversationId": fixture.conversation_id}))
            .await;
        release.notify_one();
        (rejected, unrelated, clearing.status_code())
    };
    let (result, (rejected, unrelated, clearing)) = tokio::join!(undo, competing);
    assert!(
        rejected.unwrap_err().to_string().contains("history"),
        "history mutation has a distinct non-queueing rejection"
    );
    assert!(unrelated.is_ok());
    assert_eq!(clearing, 400, "backup cleanup cannot race an active Undo");
    assert_eq!(result.status_code(), 200, "{}", result.text());
    worker.await.unwrap();
}

#[tokio::test]
async fn history_changed_while_stopping_cancels_undo_and_keeps_the_latest_history() {
    use codeg_lib::acp::connection::ConnectionCommand;
    use codeg_lib::acp::types::{AcpEvent, ConnectionStatus};
    let fixture = Fixture::new().await;
    let manager = &fixture.state.connection_manager;
    let mut receiver = manager
        .insert_test_connection_live(
            "stopping-agent",
            AgentType::ClaudeCode,
            None,
            fixture.state.emitter.clone(),
        )
        .await;
    let state = manager.get_state("stopping-agent").await.unwrap();
    {
        let mut snapshot = state.write().await;
        snapshot.external_id = Some("undo-session".into());
        snapshot.status = ConnectionStatus::Prompting;
        snapshot.turn_in_flight = true;
    }
    let path = fixture
        .root
        .path()
        .join("claude/projects/undo-project/undo-session.jsonl");
    let writer = tokio::spawn(async move {
        while let Some(command) = receiver.recv().await {
            match command {
                ConnectionCommand::Cancel => {
                    let original = std::fs::read_to_string(&path).unwrap();
                    std::fs::write(
                        &path,
                        original.replace("Keep this question", "An external client edited this"),
                    )
                    .unwrap();
                    state.write().await.apply_event(&AcpEvent::TurnComplete {
                        session_id: "undo-session".into(),
                        stop_reason: "cancelled".into(),
                        agent_type: "claude_code".into(),
                    });
                }
                ConnectionCommand::Disconnect => break,
                _ => {}
            }
        }
    });
    let preview = fixture.preview().await;
    let response = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"],
            "stopConfirmed": true
        }))
        .await;
    assert_eq!(response.status_code(), 400, "{}", response.text());
    let history = fixture.history().await;
    assert_eq!(history["turns"].as_array().unwrap().len(), 4);
    assert_eq!(
        history["turns"][0]["blocks"][0]["text"],
        "An external client edited this"
    );
    manager.disconnect("stopping-agent").await.unwrap();
    writer.await.unwrap();
}

#[tokio::test]
async fn gemini_undo_and_redo_preserve_the_original_session_and_image() {
    let mut fixture = Fixture::new().await;
    let home = fixture.root.path().join("gemini-home");
    let chats = home.join(".gemini/tmp/undo-project/chats");
    std::fs::create_dir_all(&chats).unwrap();
    let record = json!({
        "sessionId": "gemini-undo-session",
        "projectHash": "undo-project",
        "startTime": "2026-11-17T01:00:00Z",
        "lastUpdated": "2026-11-17T01:01:01Z",
        "messages": [
            {"id": "u1", "type": "user", "timestamp": "2026-11-17T01:00:00Z",
             "content": [{"text": "Keep this Gemini question"}]},
            {"id": "a1", "type": "gemini", "timestamp": "2026-11-17T01:00:01Z",
             "content": "Keep this Gemini answer"},
            {"id": "u2", "type": "user", "timestamp": "2026-11-17T01:01:00Z",
             "content": [
                 {"text": "Undo this Gemini image"},
                 {"inlineData": {"mimeType": "image/png", "data": "QUJD"}}
             ]},
            {"id": "a2", "type": "gemini", "timestamp": "2026-11-17T01:01:01Z",
             "content": "Remove this Gemini answer"}
        ]
    });
    std::fs::write(
        chats.join("session-2026-11-17T01-00-gemini.jsonl"),
        format!("{}\n", json!({"$set": record})),
    )
    .unwrap();
    let db = &fixture.state.db;
    fixture.conversation_id = seed_conversation(db, 1, AgentType::Gemini).await;
    conversation_service::bind_external_id(
        &db.conn,
        fixture.conversation_id,
        "gemini-undo-session",
        &[],
    )
    .await
    .unwrap();
    agent_setting_service::ensure_defaults(
        &db.conn,
        &[agent_setting_service::AgentDefaultInput {
            agent_type: AgentType::Gemini,
            registry_id: "gemini-acp".into(),
            default_sort_order: 1,
        }],
    )
    .await
    .unwrap();
    agent_setting_service::update_preferences(
        &db.conn,
        AgentType::Gemini,
        true,
        Some(json!({"GEMINI_CLI_HOME": home}).to_string()),
    )
    .await
    .unwrap();
    let original = fixture.history().await;
    let preview = fixture.preview_text("Undo this Gemini image").await;
    let result = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"]
        }))
        .await;
    assert_eq!(result.status_code(), 200, "{}", result.text());
    assert_eq!(result.json::<Value>()["sessionId"], "gemini-undo-session");
    assert_eq!(
        result.json::<Value>()["prompt"]["blocks"][1],
        json!({"type": "image", "data": "QUJD", "mime_type": "image/png"})
    );
    assert_eq!(fixture.history().await["turns"].as_array().unwrap().len(), 2);
    let restored = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(restored.status_code(), 200, "{}", restored.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
}

#[tokio::test]
async fn a_stop_timeout_keeps_history_and_releases_the_undo_operation() {
    use codeg_lib::acp::connection::ConnectionCommand;
    use codeg_lib::acp::types::{AcpEvent, ConnectionStatus};
    let fixture = Fixture::new().await;
    let manager = &fixture.state.connection_manager;
    let mut receiver = manager
        .insert_test_connection_live(
            "slow-agent",
            AgentType::ClaudeCode,
            None,
            fixture.state.emitter.clone(),
        )
        .await;
    let state = manager.get_state("slow-agent").await.unwrap();
    {
        let mut state = state.write().await;
        state.external_id = Some("undo-session".into());
        state.turn_in_flight = true;
        state.status = ConnectionStatus::Prompting;
    }
    let can_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let allowed = can_stop.clone();
    let worker = tokio::spawn(async move {
        while let Some(command) = receiver.recv().await {
            match command {
                ConnectionCommand::Cancel if allowed.load(std::sync::atomic::Ordering::SeqCst) => {
                    state.write().await.apply_event(&AcpEvent::TurnComplete {
                        session_id: "undo-session".into(),
                        stop_reason: "cancelled".into(),
                        agent_type: "claude_code".into(),
                    });
                }
                ConnectionCommand::Disconnect => break,
                _ => {}
            }
        }
    });
    let original = fixture.history().await;
    let preview = fixture.preview().await;
    let payload = json!({
        "conversationId": fixture.conversation_id,
        "sourceTurnId": preview["sourceTurnId"],
        "historyRevision": preview["historyRevision"],
        "stopConfirmed": true
    });
    let rejected = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&payload)
        .await;
    assert_eq!(rejected.status_code(), 409, "{}", rejected.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
    can_stop.store(true, std::sync::atomic::Ordering::SeqCst);
    let retried = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&payload)
        .await;
    assert_eq!(retried.status_code(), 200, "{}", retried.text());
    worker.await.unwrap();
}
