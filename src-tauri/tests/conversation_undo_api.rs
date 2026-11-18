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
#[ignore = "requires CODEG_TEST_CLAUDE_SDK matching the installed native Claude runtime"]
async fn native_claude_undo_and_redo_reload_the_original_parent_uuid_chain() {
    let fixture = Fixture::new().await;
    let home = fixture.root.path().join("claude");
    let project = home.join("projects/undo-project");
    let session = "bfcc62fe-ab35-4b73-90ef-4b78a8515bc1";
    let records = std::fs::read_to_string(project.join("undo-session.jsonl")).unwrap();
    let records = records
        .replace("undo-session", session)
        .replace("user-1", "11111111-1111-4111-8111-111111111111")
        .replace("reply-1", "22222222-2222-4222-8222-222222222222")
        .replace("user-2", "33333333-3333-4333-8333-333333333333")
        .replace("reply-2", "44444444-4444-4444-8444-444444444444");
    std::fs::write(project.join(format!("{session}.jsonl")), records).unwrap();
    std::fs::remove_file(project.join("undo-session.jsonl")).unwrap();
    conversation_service::bind_external_id(
        &fixture.state.db.conn,
        fixture.conversation_id,
        session,
        &[],
    )
    .await
    .unwrap();
    async fn native(home: &std::path::Path, session: &str) -> Value {
        let module = std::env::var("CODEG_TEST_CLAUDE_SDK").expect("native Claude SDK path");
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            codeg_lib::process::tokio_command("node")
                .arg("--input-type=module")
                .arg("-e")
                .arg(include_str!("fixtures/conversation_undo/native_claude.mjs"))
                .arg(module)
                .arg(session)
                .env("CLAUDE_CONFIG_DIR", home)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    assert_eq!(
        native(&home, session).await,
        json!({"messages":[
            {"id":"11111111-1111-4111-8111-111111111111","role":"user"},
            {"id":"22222222-2222-4222-8222-222222222222","role":"assistant"},
            {"id":"33333333-3333-4333-8333-333333333333","role":"user"},
            {"id":"44444444-4444-4444-8444-444444444444","role":"assistant"},
        ]})
    );
    let preview = fixture.preview().await;
    let result=fixture.server.post("/api/conversation_undo_commit")
        .add_header("authorization",format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]}))
        .await;
    assert_eq!(result.status_code(), 200, "{}", result.text());
    assert_eq!(
        native(&home, session).await,
        json!({"messages":[
            {"id":"11111111-1111-4111-8111-111111111111","role":"user"},
            {"id":"22222222-2222-4222-8222-222222222222","role":"assistant"},
        ]})
    );
    let restored = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(restored.status_code(), 200, "{}", restored.text());
    assert_eq!(
        native(&home, session).await["messages"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(fixture.history().await["summary"]["external_id"], session);
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
async fn claude_reconnect_metadata_keeps_redo_available_and_preserves_current_runtime_settings() {
    use std::io::Write;
    let fixture = Fixture::new().await;
    let preview = fixture.preview().await;
    let committed=fixture.server.post("/api/conversation_undo_commit")
        .add_header("authorization",format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]})).await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    let path = fixture
        .root
        .path()
        .join("claude/projects/undo-project/undo-session.jsonl");
    let latch =
        json!({"type":"atis-latch","atis":"current-runtime-setting","sessionId":"undo-session"});
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap(),
        "{latch}"
    )
    .unwrap();
    let status = fixture
        .server
        .post("/api/conversation_redo_status")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(status.status_code(), 200, "{}", status.text());
    assert_eq!(status.json::<Value>()["available"], true);
    let redone = fixture
        .server
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(redone.status_code(), 200, "{}", redone.text());
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        4
    );
    let restored_native = std::fs::read_to_string(path).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(restored_native.lines().last().unwrap()).unwrap(),
        latch
    );
}

#[tokio::test]
async fn changing_a_native_document_after_preview_cancels_undo_even_when_display_is_unchanged() {
    let fixture = Fixture::new().await;
    let path = fixture
        .root
        .path()
        .join("claude/projects/undo-project/undo-session.jsonl");
    let mut records = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    records[2]["message"]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "type":"document","title":"original.txt",
            "source":{"type":"text","media_type":"text/plain","data":"Original document"}
        }));
    std::fs::write(
        &path,
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
    records[2]["message"]["content"][2]["source"]["data"] =
        json!("An external client changed the native document");
    std::fs::write(
        &path,
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
    assert_eq!(fixture.history().await["turns"], before["turns"]);
    let response=fixture.server.post("/api/conversation_undo_commit")
        .add_header("authorization",format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]})).await;
    assert_eq!(response.status_code(), 400, "{}", response.text());
    assert_eq!(fixture.history().await["turns"], before["turns"]);
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
async fn an_unbound_delegated_child_is_listed_and_must_stop_before_undo() {
    use codeg_lib::acp::connection::ConnectionCommand;
    use codeg_lib::acp::types::{AcpEvent, ConnectionStatus};
    let fixture = Fixture::new().await;
    let manager = &fixture.state.connection_manager;
    let mut parent_commands = manager
        .insert_test_connection_live(
            "unbound-parent",
            AgentType::ClaudeCode,
            None,
            fixture.state.emitter.clone(),
        )
        .await;
    let child_commands = manager
        .insert_test_connection_live(
            "unbound-child",
            AgentType::Codex,
            None,
            fixture.state.emitter.clone(),
        )
        .await;
    let parent = manager.get_state("unbound-parent").await.unwrap();
    {
        let mut snapshot = parent.write().await;
        snapshot.external_id = Some("undo-session".into());
        snapshot.delegated_children.insert("unbound-child".into());
    }
    {
        let child = manager.get_state("unbound-child").await.unwrap();
        let mut snapshot = child.write().await;
        snapshot.external_id = Some("unbound-child-session".into());
        snapshot.turn_in_flight = true;
        snapshot.status = ConnectionStatus::Prompting;
    }
    let parent_worker = tokio::spawn(async move {
        while let Some(command) = parent_commands.recv().await {
            match command {
                ConnectionCommand::Cancel => {
                    parent.write().await.apply_event(&AcpEvent::TurnComplete {
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
    assert!(
        preview["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["kind"] == "delegation"),
        "{preview}"
    );
    let response=fixture.server.post("/api/conversation_undo_commit")
        .add_header("authorization",format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"],"stopConfirmed":true})).await;
    assert_eq!(response.status_code(), 409, "{}", response.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
    manager.disconnect("unbound-parent").await.unwrap();
    manager.disconnect("unbound-child").await.unwrap();
    drop(child_commands);
    parent_worker.await.unwrap();
}

#[tokio::test]
async fn a_refused_background_task_stop_keeps_the_original_history() {
    use codeg_lib::acp::connection::ConnectionCommand;
    use codeg_lib::acp::types::{AcpEvent, ConnectionStatus};
    let fixture = Fixture::new().await;
    let manager = &fixture.state.connection_manager;
    let mut commands = manager
        .insert_test_connection_live(
            "refusing-task-agent",
            AgentType::ClaudeCode,
            None,
            fixture.state.emitter.clone(),
        )
        .await;
    let state = manager.get_state("refusing-task-agent").await.unwrap();
    {
        let mut snapshot = state.write().await;
        snapshot.external_id = Some("undo-session".into());
        snapshot.status = ConnectionStatus::Prompting;
        snapshot.turn_in_flight = true;
        snapshot.async_tasks.insert(
            "refuses-stop".into(),
            serde_json::from_value(json!({
                "task_id":"refuses-stop","name":"Keep this running","state":"running",
                "task_type":"shell","description":"A running background command",
                "show_in_transcript":true,"can_stop":true,
            }))
            .unwrap(),
        );
    }
    let worker = tokio::spawn(async move {
        while let Some(command) = commands.recv().await {
            match command {
                ConnectionCommand::StopAsyncTask { reply, .. } => {
                    let _ = reply.send(Ok(false));
                }
                ConnectionCommand::Cancel => {
                    let mut snapshot = state.write().await;
                    snapshot.async_tasks.clear();
                    snapshot.apply_event(&AcpEvent::TurnComplete {
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
    assert!(!preview["tasks"].as_array().unwrap().is_empty());
    let response = fixture.server.post("/api/conversation_undo_commit")
        .add_header("authorization",format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"],"stopConfirmed":true}))
        .await;
    assert_eq!(response.status_code(), 409, "{}", response.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
    manager.disconnect("refusing-task-agent").await.unwrap();
    worker.await.unwrap();
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
    check_gemini_undo_and_redo(None, false, false).await;
}

#[tokio::test]
async fn gemini_restores_the_original_pdf_alongside_its_image() {
    check_gemini_undo_and_redo(None, true, false).await;
}

#[tokio::test]
async fn gemini_legacy_json_undo_and_redo_preserve_the_original_session() {
    check_gemini_undo_and_redo(None, false, true).await;
}

#[tokio::test]
async fn legacy_gemini_memory_that_cannot_be_rewound_pauses_undo() {
    let (fixture, path) = check_gemini_undo_and_redo(None, false, true).await;
    let mut original: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    original["memoryScratchpad"] = json!("Memory includes the question selected for Undo");
    let bytes = serde_json::to_vec(&original).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let preview = fixture.preview_text("Undo this Gemini image").await;
    assert!(preview["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|issue| issue["code"] == "unsupported_native_context"));
    let rejected = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"],
        }))
        .await;
    assert_eq!(rejected.status_code(), 400, "{}", rejected.text());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
}

#[tokio::test]
async fn new_gemini_messages_after_legacy_migration_disable_redo_and_remain_untouched() {
    let (fixture, path) = check_gemini_undo_and_redo(None, false, true).await;
    let preview = fixture.preview_text("Undo this Gemini image").await;
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"],
        }))
        .await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    let mut metadata: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let messages = metadata
        .as_object_mut()
        .unwrap()
        .remove("messages")
        .unwrap();
    let mut records = vec![metadata];
    records.extend(messages.as_array().unwrap().iter().cloned());
    records.push(json!({"$set": {"sessionId": "gemini-undo-session"}}));
    records.push(json!({
        "id": "u3", "type": "user", "timestamp": "2026-11-17T01:02:00Z",
        "content": [{"text": "Keep this new instruction after native restart"}],
    }));
    let current = format!(
        "{}\n",
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    );
    let migrated = path.with_extension("jsonl");
    std::fs::write(&migrated, &current).unwrap();
    let before = fixture.history().await;
    assert_eq!(
        before["turns"].as_array().unwrap().last().unwrap()["blocks"][0]["text"],
        "Keep this new instruction after native restart"
    );
    let status = fixture
        .server
        .post("/api/conversation_redo_status")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(status.status_code(), 200, "{}", status.text());
    assert_eq!(status.json::<Value>()["available"], false);
    let rejected = fixture
        .server
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(rejected.status_code(), 400, "{}", rejected.text());
    assert_eq!(std::fs::read_to_string(migrated).unwrap(), current);
    assert_eq!(fixture.history().await["turns"], before["turns"]);
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_GEMINI_READER pointing at the installed Gemini native reader module"]
async fn native_gemini_undo_and_redo_reload_the_same_original_session() {
    let module = std::env::var("CODEG_TEST_GEMINI_READER").expect("native reader module");
    check_gemini_undo_and_redo(Some(std::path::Path::new(&module)), true, false).await;
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_GEMINI_READER pointing at the installed Gemini native reader module"]
async fn native_gemini_legacy_json_undo_and_redo_reload_the_same_session() {
    let module = std::env::var("CODEG_TEST_GEMINI_READER").expect("native reader module");
    check_gemini_undo_and_redo(Some(std::path::Path::new(&module)), false, true).await;
}

async fn read_native_gemini(module: &std::path::Path, path: &std::path::Path) -> Value {
    let script = "const {loadConversationRecord}=await import(process.argv[1]); const record=await loadConversationRecord(process.argv[2]); process.stdout.write(JSON.stringify({id:record.sessionId,messages:record.messages.map(message=>message.id)}));";
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        codeg_lib::process::tokio_command("node")
            .arg("--input-type=module")
            .arg("-e")
            .arg(script)
            .arg(url::Url::from_file_path(module).unwrap().as_str())
            .arg(path)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

async fn resume_native_gemini(module: &std::path::Path, path: &std::path::Path) {
    let script = r#"
        const {ChatRecordingService, loadConversationRecord} = await import(process.argv[1]);
        const filePath = process.argv[2];
        const conversation = await loadConversationRecord(filePath);
        const service = new ChatRecordingService({
            promptId: conversation.sessionId,
            config: {getProjectRoot: () => process.argv[3]},
        });
        await service.initialize({filePath, conversation});
    "#;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        codeg_lib::process::tokio_command("node")
            .arg("--input-type=module")
            .arg("-e")
            .arg(script)
            .arg(url::Url::from_file_path(module).unwrap().as_str())
            .arg(path)
            .arg(path.parent().unwrap())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn check_gemini_undo_and_redo(
    native: Option<&std::path::Path>,
    document: bool,
    legacy_json: bool,
) -> (Fixture, std::path::PathBuf) {
    let mut fixture = Fixture::new().await;
    let home = fixture.root.path().join("gemini-home");
    let chats = home.join(".gemini/tmp/undo-project/chats");
    std::fs::create_dir_all(&chats).unwrap();
    let mut record = json!({
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
    if document {
        record["messages"][2]["content"].as_array_mut().unwrap().push(
            json!({"inlineData":{"mimeType":"application/pdf","data":"JVBERi1vcmlnaW5hbA==","displayName":"original.pdf"}})
        );
    }
    let native_path = if legacy_json {
        chats.join("session-legacy-native-check.json")
    } else {
        chats.join("session-native-check.jsonl")
    };
    let native_contents = if legacy_json {
        record.to_string()
    } else {
        format!("{}\n", json!({"$set": record}))
    };
    std::fs::write(&native_path, native_contents).unwrap();
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
    if let Some(module) = native {
        assert_eq!(
            read_native_gemini(module, &native_path).await,
            json!({"id":"gemini-undo-session","messages":["u1","a1","u2","a2"]})
        );
    }
    let preview = fixture.preview_text("Undo this Gemini image").await;
    if document {
        assert!(
            preview["issues"].as_array().unwrap().is_empty(),
            "{preview}"
        );
        assert!(
            preview["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|block| block["type"] == "resource"
                    && block["blob"] == "JVBERi1vcmlnaW5hbA=="
                    && block["mime_type"] == "application/pdf"),
            "{preview}"
        );
    }
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
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    if let Some(module) = native {
        assert_eq!(
            read_native_gemini(module, &native_path).await,
            json!({"id":"gemini-undo-session","messages":["u1","a1"]})
        );
    }
    let current_path = if let Some(module) = native {
        resume_native_gemini(module, &native_path).await;
        let active = if legacy_json {
            native_path.with_extension("jsonl")
        } else {
            native_path.clone()
        };
        assert_eq!(
            read_native_gemini(module, &active).await,
            json!({"id":"gemini-undo-session","messages":["u1","a1"]})
        );
        let status = fixture
            .reopen()
            .post("/api/conversation_redo_status")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({"conversationId": fixture.conversation_id}))
            .await;
        assert_eq!(status.status_code(), 200, "{}", status.text());
        assert_eq!(
            status.json::<Value>()["available"],
            true,
            "Native restart must retain Redo"
        );
        active
    } else {
        native_path.clone()
    };
    let restored = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(restored.status_code(), 200, "{}", restored.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
    if let Some(module) = native {
        assert_eq!(
            read_native_gemini(module, &current_path).await,
            json!({"id":"gemini-undo-session","messages":["u1","a1","u2","a2"]})
        );
    }
    (fixture, native_path)
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

#[tokio::test]
async fn undo_restores_the_original_non_image_attachment_as_sendable_input() {
    let fixture = Fixture::new().await;
    let path = fixture
        .root
        .path()
        .join("claude/projects/undo-project/undo-session.jsonl");
    let original = std::fs::read_to_string(&path).unwrap();
    let mut records = original
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    records[2]["message"]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "type": "document", "title": "original-guide.pdf",
            "source": {"type": "base64", "media_type": "application/pdf", "data": "QUJD"}
        }));
    std::fs::write(
        &path,
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
    let preview = fixture.preview().await;
    assert!(
        preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    assert!(preview["input"]
        .as_array()
        .unwrap()
        .iter()
        .any(|block| block["type"] == "resource" && block["blob"] == "QUJD"));
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
    let result: Value = result.json();
    let document = result["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["type"] == "resource")
        .unwrap();
    assert_eq!(document["blob"], "");
    assert_eq!(document["mime_type"], "application/pdf");
    assert!(document["uri"].as_str().unwrap().starts_with("file://"));
    let file = url::Url::parse(document["uri"].as_str().unwrap())
        .unwrap()
        .to_file_path()
        .unwrap();
    assert_eq!(std::fs::read(file).unwrap(), b"ABC");
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
}

#[tokio::test]
async fn restored_text_attachment_keeps_original_bytes_when_collected_again() {
    let fixture = Fixture::new().await;
    let path = fixture
        .root
        .path()
        .join("claude/projects/undo-project/undo-session.jsonl");
    let mut records = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    records[2]["message"]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "type":"document", "title":"original-notes.txt",
            "source":{"type":"text","media_type":"text/plain","data":"发送时的附件原文\n第二行"}
        }));
    std::fs::write(
        &path,
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
    let preview = fixture.preview().await;
    let response = fixture.server.post("/api/conversation_undo_commit")
        .add_header("authorization",format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]}))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    let input = response.json::<Value>()["input"]
        .as_array()
        .unwrap()
        .clone();
    let document = input
        .iter()
        .find(|block| block["type"] == "resource")
        .unwrap()
        .clone();
    assert_eq!(document["text"], "");
    let scope = format!("conv:{}", fixture.conversation_id);
    let data = fixture.root.path().join("data");
    temp_env::async_with_vars(
        [
            ("CODEG_HOME", Some(data.to_str().unwrap())),
            ("CODEG_DATA_DIR", Some(data.to_str().unwrap())),
        ],
        async {
            let saved = fixture
                .server
                .post("/api/save_prompt_stash")
                .add_header("authorization", format!("Bearer {TOKEN}"))
                .json(&json!({"scopeKey":scope,"snapshot":{
                    "text":"Keep restored notes","doc":{"type":"doc","content":[]},
                    "attachments":[],"embeddedPayloads":{"original-notes":document}
                }}))
                .await;
            assert_eq!(saved.status_code(), 200, "{}", saved.text());
            let restored = fixture
                .server
                .post("/api/restore_prompt_stash")
                .add_header("authorization", format!("Bearer {TOKEN}"))
                .json(&json!({"scopeKey":scope,"id":saved.json::<Value>()["entry"]["id"]}))
                .await;
            assert_eq!(restored.status_code(), 200, "{}", restored.text());
            let restored = restored.json::<Value>();
            assert_eq!(
                restored["embeddedPayloads"]["original-notes"]["text"],
                "发送时的附件原文\n第二行"
            );
        },
    )
    .await;
}

#[tokio::test]
async fn restored_large_image_and_document_resend_through_a_small_http_request() {
    use codeg_lib::acp::connection::ConnectionCommand;
    use codeg_lib::acp::types::PromptInputBlock;
    let fixture = Fixture::new().await;
    let path = fixture
        .root
        .path()
        .join("claude/projects/undo-project/undo-session.jsonl");
    let original_image = "QUJD".repeat(1_000_000);
    let mut records = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    records[2]["message"]["content"][1]["source"]["data"] = json!(original_image);
    records[2]["message"]["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "type": "document", "title": "guide.pdf",
            "source": {"type": "base64", "media_type": "application/pdf", "data": "QUJD"}
        }));
    std::fs::write(
        &path,
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
    assert_eq!(committed.status_code(), 200);
    let mut input = committed.json::<Value>()["input"]
        .as_array()
        .unwrap()
        .clone();
    for block in &mut input {
        if block["type"] == "image" {
            block["data"] = json!("");
        }
    }
    let payload = json!({
        "connectionId": "resend-agent", "conversationId": fixture.conversation_id,
        "folderId": 1, "blocks": input
    });
    assert!(payload.to_string().len() < 4096);
    let manager = &fixture.state.connection_manager;
    let mut receiver = manager
        .insert_test_connection_live(
            "resend-agent",
            AgentType::ClaudeCode,
            None,
            fixture.state.emitter.clone(),
        )
        .await;
    {
        let state = manager.get_state("resend-agent").await.unwrap();
        let mut state = state.write().await;
        state.external_id = Some("undo-session".into());
        state.conversation_id = Some(fixture.conversation_id);
    }
    let data = fixture
        .root
        .path()
        .join("data")
        .to_string_lossy()
        .to_string();
    temp_env::async_with_vars(
        [("CODEG_HOME", Some(data.as_str())), ("CODEG_DATA_DIR", Some(data.as_str()))],
        async {
            let response = fixture.server.post("/api/acp_prompt")
                .add_header("authorization", format!("Bearer {TOKEN}"))
                .json(&payload).await;
            assert_eq!(response.status_code(), 200, "{}", response.text());
            let command = tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv()).await.unwrap().unwrap();
            match command {
                ConnectionCommand::Prompt { blocks, .. } => {
                    assert!(blocks.iter().any(|block| matches!(block, PromptInputBlock::Image { data, .. } if data == &original_image)));
                    assert!(blocks.iter().any(|block| matches!(block, PromptInputBlock::Resource { blob: Some(blob), .. } if blob == "QUJD")));
                }
                _ => panic!("the actual agent did not receive a prompt"),
            }
        }
    ).await;
}

#[tokio::test]
async fn pi_undo_and_redo_preserve_the_native_session_header_and_context() {
    check_pi_undo_and_redo(None, false).await;
}

#[tokio::test]
async fn a_missing_pi_image_pauses_undo_and_keeps_the_entire_native_history() {
    check_pi_undo_and_redo(None, true).await;
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_PI_SESSION_MANAGER pointing at the installed native Pi module"]
async fn native_pi_undo_and_redo_rebuild_the_original_model_context() {
    let module = std::env::var("CODEG_TEST_PI_SESSION_MANAGER").expect("native Pi SessionManager");
    check_pi_undo_and_redo(Some(std::path::Path::new(&module)), false).await;
}

#[tokio::test]
async fn pi_undo_restores_original_block_order_and_whitespace() {
    let (fixture, path) = check_pi_undo_and_redo(None, false).await;
    let mut records = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    records[3]["message"]["content"] = json!([
        {"type":"text","text":" Left"},
        {"type":"image","mimeType":"image/png","data":NATIVE_IMAGE},
        {"type":"text","text":"Right\n"},
    ]);
    let original = format!(
        "{}\n",
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    );
    std::fs::write(&path, &original).unwrap();
    let history = fixture.history().await;
    let selected = history["turns"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|turn| turn["role"] == "user")
        .unwrap();
    let preview = fixture
        .server
        .post("/api/conversation_undo_preview")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":selected["id"]}))
        .await;
    assert_eq!(preview.status_code(), 200, "{}", preview.text());
    let preview: Value = preview.json();
    assert!(
        preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    assert_eq!(
        preview["input"],
        json!([
            {"type":"text","text":" Left"},
            {"type":"image","mime_type":"image/png","data":NATIVE_IMAGE,"uri":null},
            {"type":"text","text":"Right\n"},
        ])
    );
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId":fixture.conversation_id,
            "sourceTurnId":preview["sourceTurnId"],
            "historyRevision":preview["historyRevision"],
        }))
        .await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    let redone = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(redone.status_code(), 200, "{}", redone.text());
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
}

#[tokio::test]
async fn pi_undo_on_an_active_tree_path_never_revives_an_abandoned_branch() {
    check_pi_tree_undo(None).await;
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_PI_SESSION_MANAGER pointing at the installed native Pi module"]
async fn native_pi_tree_undo_and_redo_follow_the_original_active_parent_chain() {
    let module = std::env::var("CODEG_TEST_PI_SESSION_MANAGER").expect("native Pi SessionManager");
    check_pi_tree_undo(Some(std::path::Path::new(&module))).await;
}

async fn check_pi_tree_undo(native: Option<&std::path::Path>) {
    let (fixture, path) = check_pi_undo_and_redo(None, false).await;
    let mut records = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let mut abandoned_user = records[3].clone();
    abandoned_user["id"] = json!("abandoned-user");
    abandoned_user["message"]["content"] =
        json!([{"type":"text","text":"Never revive this abandoned branch"}]);
    let mut abandoned_answer = records[4].clone();
    abandoned_answer["id"] = json!("abandoned-answer");
    abandoned_answer["parentId"] = json!("abandoned-user");
    abandoned_answer["message"]["content"] = json!([{"type":"text","text":"An abandoned answer"}]);
    records.splice(3..3, [abandoned_user, abandoned_answer]);
    let original = format!(
        "{}\n",
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    );
    std::fs::write(&path, &original).unwrap();
    let before = fixture.history().await;
    assert_eq!(before["turns"].as_array().unwrap().len(), 4);
    let preview = fixture.preview_text("Undo this Pi question").await;
    assert!(
        preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId":fixture.conversation_id,
            "sourceTurnId":preview["sourceTurnId"],
            "historyRevision":preview["historyRevision"],
        }))
        .await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    let after = fixture.history().await;
    assert_eq!(after["turns"].as_array().unwrap().len(), 2);
    assert_eq!(after["turns"][0], before["turns"][0]);
    assert_eq!(after["turns"][1], before["turns"][1]);
    if let Some(module) = native {
        assert_eq!(
            read_native_pi(module, &path).await,
            json!({"id":"842235c9-2910-431e-ac5a-9e67cfa987b0","messages":["user","assistant"]})
        );
    }
    let redone = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(redone.status_code(), 200, "{}", redone.text());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    assert_eq!(fixture.history().await["turns"], before["turns"]);
    if let Some(module) = native {
        assert_eq!(
            read_native_pi(module, &path).await,
            json!({"id":"842235c9-2910-431e-ac5a-9e67cfa987b0","messages":["user","assistant","user","assistant"]})
        );
    }
}

#[tokio::test]
async fn a_corrupt_pi_parent_chain_pauses_undo_and_keeps_the_original_file() {
    let (fixture, path) = check_pi_undo_and_redo(None, false).await;
    let mut records = std::fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    records[2]["parentId"] = json!("a2");
    let original = format!(
        "{}\n",
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    );
    std::fs::write(&path, &original).unwrap();
    let preview = fixture.preview_text("Undo this Pi question").await;
    assert!(
        !preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
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
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
}

async fn read_native_pi(module: &std::path::Path, path: &std::path::Path) -> Value {
    let script = "const {SessionManager}=await import(process.argv[1]); const session=SessionManager.open(process.argv[2]); process.stdout.write(JSON.stringify({id:session.getSessionId(),messages:session.buildSessionContext().messages.map(message=>message.role)}));";
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        codeg_lib::process::tokio_command("node")
            .arg("--input-type=module")
            .arg("-e")
            .arg(script)
            .arg(url::Url::from_file_path(module).unwrap().as_str())
            .arg(path)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

async fn check_pi_undo_and_redo(
    native: Option<&std::path::Path>,
    missing_image: bool,
) -> (Fixture, std::path::PathBuf) {
    let mut fixture = Fixture::new().await;
    let sessions = fixture.root.path().join("pi/sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let session_id = "842235c9-2910-431e-ac5a-9e67cfa987b0";
    let path = sessions.join(format!("2026-11-17_{session_id}.jsonl"));
    let mut records = [
        json!({"type":"session","version":3,"id":session_id,"cwd":fixture.root.path().join("workspace"),"timestamp":"2026-11-17T01:00:00Z"}),
        json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-11-17T01:00:01Z","message":{"role":"user","content":[{"type":"text","text":"Keep this Pi question"}]}}),
        json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-11-17T01:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"Keep this Pi answer"}],"timestamp":1794877202000_i64,"provider":"openai","model":"test-model","api":"openai-responses","stopReason":"stop","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}),
        json!({"type":"message","id":"u2","parentId":"a1","timestamp":"2026-11-17T01:01:00Z","message":{"role":"user","content":[{"type":"text","text":"Undo this Pi question"}]}}),
        json!({"type":"message","id":"a2","parentId":"u2","timestamp":"2026-11-17T01:01:01Z","message":{"role":"assistant","content":[{"type":"text","text":"Undo this Pi answer"}],"timestamp":1794877261000_i64,"provider":"openai","model":"test-model","api":"openai-responses","stopReason":"stop","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}}}),
    ];
    if missing_image {
        records[3]["message"]["content"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"image","mimeType":"image/png"}));
    }
    std::fs::write(
        &path,
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
    fixture.conversation_id = seed_conversation(&fixture.state.db, 1, AgentType::Pi).await;
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
            agent_type: AgentType::Pi,
            registry_id: "pi-acp".into(),
            default_sort_order: 1,
        }],
    )
    .await
    .unwrap();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::Pi,
        true,
        Some(json!({"PI_CODING_AGENT_SESSION_DIR": sessions}).to_string()),
    )
    .await
    .unwrap();
    let original = fixture.history().await;
    let preview = fixture.preview_text("Undo this Pi question").await;
    if missing_image {
        assert!(
            !preview["issues"].as_array().unwrap().is_empty(),
            "{preview}"
        );
        let rejected = fixture
            .server
            .post("/api/conversation_undo_commit")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]}))
            .await;
        assert_eq!(rejected.status_code(), 400, "{}", rejected.text());
        assert_eq!(fixture.history().await["turns"], original["turns"]);
        return (fixture, path);
    }
    let result = fixture.server.post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]})).await;
    assert_eq!(result.status_code(), 200, "{}", result.text());
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    if let Some(module) = native {
        assert_eq!(
            read_native_pi(module, &path).await,
            json!({"id":session_id,"messages":["user","assistant"]})
        );
    }
    let restored = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(restored.status_code(), 200, "{}", restored.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
    if let Some(module) = native {
        assert_eq!(
            read_native_pi(module, &path).await,
            json!({"id":session_id,"messages":["user","assistant","user","assistant"]})
        );
    }
    (fixture, path)
}

#[tokio::test]
async fn qoder_without_verified_native_context_restore_pauses_and_keeps_history() {
    let mut fixture = Fixture::new().await;
    let home = fixture.root.path().join("claude");
    fixture.conversation_id = seed_conversation(&fixture.state.db, 1, AgentType::Qoder).await;
    conversation_service::bind_external_id(
        &fixture.state.db.conn,
        fixture.conversation_id,
        "undo-session",
        &[],
    )
    .await
    .unwrap();
    agent_setting_service::ensure_defaults(
        &fixture.state.db.conn,
        &[agent_setting_service::AgentDefaultInput {
            agent_type: AgentType::Qoder,
            registry_id: "qoder".into(),
            default_sort_order: 1,
        }],
    )
    .await
    .unwrap();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::Qoder,
        true,
        Some(json!({"QODER_CONFIG_DIR":home}).to_string()),
    )
    .await
    .unwrap();
    let original = fixture.history().await;
    let preview = fixture.preview().await;
    let result = fixture.server.post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]})).await;
    assert!(preview["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|issue| issue["code"] == "unsupported_native_undo"));
    assert_eq!(result.status_code(), 400, "{}", result.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
}

#[tokio::test]
async fn hermes_undo_and_redo_leave_other_native_sessions_untouched() {
    check_hermes_undo_and_redo(None).await;
}

#[tokio::test]
async fn hermes_undo_restores_original_multimodal_parts_and_whitespace() {
    check_hermes_multimodal(None).await;
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_HERMES_PYTHON and CODEG_TEST_HERMES_MODULE for installed native Hermes"]
async fn native_hermes_multimodal_undo_and_redo_restore_original_payloads() {
    let runtime = (
        std::env::var("CODEG_TEST_HERMES_PYTHON").unwrap(),
        std::env::var("CODEG_TEST_HERMES_MODULE").unwrap(),
    );
    check_hermes_multimodal(Some(runtime)).await;
}

async fn check_hermes_multimodal(native: Option<(String, String)>) {
    let (fixture, path) = check_hermes_undo_and_redo(native.clone()).await;
    let original_content = json!([
        {"type":"text","text":" Left "},
        {"type":"image_url","image_url":{"url":format!("data:image/png;base64,{NATIVE_IMAGE}")}},
        {"type":"text","text":" Right\n"},
        {"type":"file","file":{"filename":"notes.pdf","file_data":"data:application/pdf;base64,JVBERi1vcmlnaW5hbA=="}},
    ]);
    let encoded = format!("\u{0000}json:{original_content}");
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute(
        "UPDATE messages SET content = ?1 WHERE session_id = 'hermes-undo' AND role = 'user' AND content = 'Undo Hermes question'",
        [&encoded],
    ).unwrap();
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
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":selected["id"]}))
        .await;
    assert_eq!(preview.status_code(), 200, "{}", preview.text());
    let preview: Value = preview.json();
    assert!(
        preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    assert_eq!(
        preview["input"],
        json!([
            {"type":"text","text":" Left "},
            {"type":"image","mime_type":"image/png","data":NATIVE_IMAGE,"uri":null},
            {"type":"text","text":" Right\n"},
            {"type":"resource","uri":"attachment://notes.pdf","mime_type":"application/pdf","blob":"JVBERi1vcmlnaW5hbA==","text":null},
        ])
    );
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId":fixture.conversation_id,
            "sourceTurnId":preview["sourceTurnId"],
            "historyRevision":preview["historyRevision"],
        }))
        .await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    let redone = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(redone.status_code(), 200, "{}", redone.text());
    assert_eq!(fixture.history().await["turns"], before["turns"]);
    let saved: String = database.query_row(
        "SELECT content FROM messages WHERE session_id = 'hermes-undo' AND timestamp = 1794877260",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(saved, encoded);
    if let Some(runtime) = native {
        let actual = run_native_hermes(&runtime, "read_full", &path).await;
        assert_eq!(actual["messages"][2]["content"], original_content);
    }
}

#[tokio::test]
async fn a_hermes_summary_carrier_pauses_undo_instead_of_erasing_retained_context() {
    let (fixture, path) = check_hermes_undo_and_redo(None).await;
    let database = rusqlite::Connection::open(&path).unwrap();
    database
        .execute_batch(
            "
        ALTER TABLE messages ADD COLUMN _compressed_summary INTEGER DEFAULT 0;
        ALTER TABLE messages ADD COLUMN compacted INTEGER DEFAULT 0;
        UPDATE messages SET _compressed_summary = 1
        WHERE session_id = 'hermes-undo' AND role = 'user' AND content = 'Undo Hermes question';
    ",
        )
        .unwrap();
    let before = fixture.history().await;
    let preview = fixture.preview_text("Undo Hermes question").await;
    assert!(
        !preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
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
#[ignore = "requires CODEG_TEST_HERMES_PYTHON and CODEG_TEST_HERMES_MODULE for installed native Hermes"]
async fn native_hermes_undo_and_redo_reload_the_actual_model_conversation() {
    let python = std::env::var("CODEG_TEST_HERMES_PYTHON").unwrap();
    let module = std::env::var("CODEG_TEST_HERMES_MODULE").unwrap();
    check_hermes_undo_and_redo(Some((python, module))).await;
}

async fn run_native_hermes(
    runtime: &(String, String),
    action: &str,
    path: &std::path::Path,
) -> Value {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        codeg_lib::process::tokio_command(&runtime.0)
            .arg("-c")
            .arg(include_str!("fixtures/conversation_undo/native_hermes.py"))
            .arg(&runtime.1)
            .arg(action)
            .arg(path)
            .env("HERMES_HOME", path.parent().unwrap())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    if action.starts_with("read") {
        serde_json::from_str(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .last()
                .unwrap(),
        )
        .unwrap()
    } else {
        Value::Null
    }
}

async fn check_hermes_undo_and_redo(
    native: Option<(String, String)>,
) -> (Fixture, std::path::PathBuf) {
    let mut fixture = Fixture::new().await;
    let home = fixture.root.path().join("hermes");
    std::fs::create_dir_all(&home).unwrap();
    if let Some(runtime) = &native {
        run_native_hermes(runtime, "seed", &home.join("state.db")).await;
    } else {
        let db = rusqlite::Connection::open(home.join("state.db")).unwrap();
        db.execute_batch("
            CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, model_config TEXT,
              parent_session_id TEXT, started_at REAL, ended_at REAL, cwd TEXT, title TEXT,
              archived INTEGER DEFAULT 0, input_tokens INTEGER, output_tokens INTEGER,
              cache_read_tokens INTEGER, cache_write_tokens INTEGER);
            CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT,
              content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, reasoning TEXT,
              reasoning_content TEXT, timestamp REAL, finish_reason TEXT, active INTEGER DEFAULT 1);
            INSERT INTO sessions(id,model,model_config,started_at,title) VALUES('hermes-undo','test-model','{}',1794877200,'Hermes Undo');
            INSERT INTO sessions(id,model,model_config,started_at,title) VALUES('other-hermes','test-model','{}',1794877200,'Other Hermes');
            INSERT INTO messages(session_id,role,content,timestamp) VALUES
              ('hermes-undo','user','Keep Hermes question',1794877201),
              ('hermes-undo','assistant','Keep Hermes answer',1794877202),
              ('hermes-undo','user','Undo Hermes question',1794877260),
              ('hermes-undo','assistant','Undo Hermes answer',1794877261),
              ('other-hermes','user','Keep other Hermes session',1794877261);
        ").unwrap();
    }
    fixture.conversation_id = seed_conversation(&fixture.state.db, 1, AgentType::Hermes).await;
    conversation_service::bind_external_id(
        &fixture.state.db.conn,
        fixture.conversation_id,
        "hermes-undo",
        &[],
    )
    .await
    .unwrap();
    agent_setting_service::ensure_defaults(
        &fixture.state.db.conn,
        &[agent_setting_service::AgentDefaultInput {
            agent_type: AgentType::Hermes,
            registry_id: "hermes".into(),
            default_sort_order: 1,
        }],
    )
    .await
    .unwrap();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::Hermes,
        true,
        Some(json!({"HERMES_HOME":home}).to_string()),
    )
    .await
    .unwrap();
    let original = fixture.history().await;
    let preview = fixture.preview_text("Undo Hermes question").await;
    let result = fixture.server.post("/api/conversation_undo_commit").add_header("authorization",format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]})).await;
    assert_eq!(result.status_code(), 200, "{}", result.text());
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    if let Some(runtime) = &native {
        assert_eq!(
            run_native_hermes(runtime, "read", &home.join("state.db")).await,
            json!({"roles":["user","assistant"]})
        );
    }
    let restored = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(restored.status_code(), 200, "{}", restored.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
    if let Some(runtime) = &native {
        assert_eq!(
            run_native_hermes(runtime, "read", &home.join("state.db")).await,
            json!({"roles":["user","assistant","user","assistant"]})
        );
    }
    let other = seed_conversation(&fixture.state.db, 1, AgentType::Hermes).await;
    conversation_service::bind_external_id(&fixture.state.db.conn, other, "other-hermes", &[])
        .await
        .unwrap();
    let response = fixture
        .server
        .post("/api/get_folder_conversation")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":other}))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    assert_eq!(
        response.json::<Value>()["turns"][0]["blocks"][0]["text"],
        "Keep other Hermes session"
    );
    (fixture, home.join("state.db"))
}

#[tokio::test]
async fn opencode_undo_and_redo_preserve_native_message_ids_and_workspace_files() {
    check_opencode_undo_and_redo(None).await;
}

#[tokio::test]
async fn opencode_v2_undo_and_redo_preserve_sequence_identity_and_other_sessions() {
    check_opencode_v2_undo_and_redo(None).await;
}

fn store_opencode_v2_pdf_blob(path: &std::path::Path, missing: bool) {
    let database = rusqlite::Connection::open(path).unwrap();
    database.execute_batch("
        CREATE TABLE blob(hash TEXT PRIMARY KEY,mime TEXT,bytes INTEGER,width INTEGER,height INTEGER,data BLOB,time_created INTEGER);
        CREATE TABLE blob_ref(session_id TEXT,message_id TEXT,hash TEXT,seq INTEGER,PRIMARY KEY(session_id,message_id,hash));
    ").unwrap();
    let hash = "e2dc7dcc254d1b9d2b42ebf1fb0a7630e49255fd1f7fe3c5e220fb7ff837982b";
    if !missing {
        database
            .execute(
                "INSERT INTO blob VALUES(?1,'application/pdf',13,NULL,NULL,?2,1794877260000)",
                rusqlite::params![hash, b"%PDF-original".as_slice()],
            )
            .unwrap();
    }
    database
        .execute(
            "INSERT INTO blob_ref VALUES('ses_v2','msg_z2',?1,8)",
            [hash],
        )
        .unwrap();
    let raw: String = database
        .query_row(
            "SELECT data FROM session_message WHERE id = 'msg_z2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut data: Value = serde_json::from_str(&raw).unwrap();
    data["files"][1].as_object_mut().unwrap().remove("data");
    data["files"][1]["uri"] = json!(format!("media:{hash}"));
    database
        .execute(
            "UPDATE session_message SET data = ?1 WHERE id = 'msg_z2'",
            [data.to_string()],
        )
        .unwrap();
}

#[tokio::test]
async fn opencode_v2_redo_restores_pdf_bytes_after_native_blob_collection() {
    let (fixture, path) = check_opencode_v2_undo_and_redo(None).await;
    store_opencode_v2_pdf_blob(&path, false);
    let before = fixture.history().await;
    let preview = fixture.preview_text("Undo OpenCode v2 question").await;
    assert!(
        preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    assert!(preview["input"]
        .as_array()
        .unwrap()
        .iter()
        .any(|block| { block["type"] == "resource" && block["blob"] == "JVBERi1vcmlnaW5hbA==" }));
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId":fixture.conversation_id,
            "sourceTurnId":preview["sourceTurnId"],
            "historyRevision":preview["historyRevision"],
        }))
        .await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch("DELETE FROM blob WHERE NOT EXISTS(SELECT 1 FROM blob_ref WHERE blob_ref.hash = blob.hash);").unwrap();
    let redone = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(redone.status_code(), 200, "{}", redone.text());
    assert_eq!(fixture.history().await["turns"], before["turns"]);
    let bytes: Vec<u8> = database
        .query_row("SELECT data FROM blob", [], |row| row.get(0))
        .unwrap();
    assert_eq!(bytes, b"%PDF-original");
}

#[tokio::test]
async fn missing_opencode_v2_media_pauses_undo_and_preserves_all_native_rows() {
    let (fixture, path) = check_opencode_v2_undo_and_redo(None).await;
    store_opencode_v2_pdf_blob(&path, true);
    let before = fixture.history().await;
    let preview = fixture.preview_text("Undo OpenCode v2 question").await;
    assert!(
        !preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    assert!(
        preview["issues"][0]["label"]
            .as_str()
            .unwrap()
            .contains("notes.pdf"),
        "{preview}"
    );
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
async fn opencode_v2_private_uploads_restore_recorded_bytes_not_current_path_contents() {
    let (fixture, path) = check_opencode_v2_undo_and_redo(None).await;
    let upload = fixture.state.data_dir.join("uploads/private/notes.pdf");
    std::fs::create_dir_all(upload.parent().unwrap()).unwrap();
    std::fs::write(&upload, b"Changed after the message was sent").unwrap();
    let database = rusqlite::Connection::open(path).unwrap();
    let raw: String = database
        .query_row(
            "SELECT data FROM session_message WHERE id = 'msg_z2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut data: Value = serde_json::from_str(&raw).unwrap();
    data["files"][1]["source"] = json!({
        "type":"uri","uri":url::Url::from_file_path(&upload).unwrap().to_string(),
    });
    database
        .execute(
            "UPDATE session_message SET data = ?1 WHERE id = 'msg_z2'",
            [data.to_string()],
        )
        .unwrap();
    let home = fixture.state.data_dir.to_string_lossy().to_string();
    temp_env::async_with_vars([("CODEG_HOME", Some(home.as_str()))], async {
        let preview = fixture.preview_text("Undo OpenCode v2 question").await;
        assert!(
            preview["issues"].as_array().unwrap().is_empty(),
            "{preview}"
        );
        assert!(
            preview["input"].as_array().unwrap().iter().any(|block| {
                block["type"] == "resource"
                    && block["uri"] == "attachment://notes.pdf"
                    && block["blob"] == "JVBERi1vcmlnaW5hbA=="
            }),
            "{}",
            preview["input"]
        );
        assert_eq!(
            std::fs::read(upload).unwrap(),
            b"Changed after the message was sent"
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_OPENCODE_V2 pointing at the isolated native 2.x binary"]
async fn native_opencode_v2_undo_and_redo_reload_the_original_session() {
    let binary = std::env::var("CODEG_TEST_OPENCODE_V2").expect("native OpenCode v2 CLI");
    check_opencode_v2_undo_and_redo(Some(std::path::Path::new(&binary))).await;
}

async fn check_opencode_v2_undo_and_redo(
    native_binary: Option<&std::path::Path>,
) -> (Fixture, std::path::PathBuf) {
    let mut fixture = Fixture::new().await;
    let home = fixture.root.path().join("opencode-v2-data");
    std::fs::create_dir_all(home.join("opencode")).unwrap();
    let path = home.join("opencode/opencode.db");
    if let Some(binary) = native_binary {
        opencode_command(binary, &home, &["session", "list"]).await;
    }
    let native = rusqlite::Connection::open(&path).unwrap();
    if native_binary.is_none() {
        native
            .execute_batch(
                "
        CREATE TABLE session_v2(
            id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,title TEXT,
            time_created INTEGER,time_updated INTEGER);
        CREATE TABLE session_message(
            id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,
            time_created INTEGER,time_updated INTEGER,data TEXT,
            UNIQUE(session_id,seq));
        CREATE TABLE session_part(
            message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,call_id TEXT,
            time_created INTEGER,time_updated INTEGER,data TEXT,
            PRIMARY KEY(message_id,ordinal));
        INSERT INTO session_v2 VALUES
            ('ses_v2','F:/workspace',NULL,'OpenCode v2 Undo',1794877200000,1794877261000),
            ('ses_other','F:/workspace',NULL,'Keep other session',1794877200000,1794877261000);
    ",
            )
            .unwrap();
    } else {
        let workspace = fixture
            .root
            .path()
            .join("workspace")
            .to_string_lossy()
            .to_string();
        native.execute(
            "INSERT OR IGNORE INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES('global',?1,1794877200000,1794877261000,'[]')",
            [&workspace],
        ).unwrap();
        for (session, title) in [
            ("ses_v2", "OpenCode v2 Undo"),
            ("ses_other", "Keep other session"),
        ] {
            native.execute(
                "INSERT INTO session_v2(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?1,'global',?1,?2,?3,'2.3.0',1794877200000,1794877261000)",
                rusqlite::params![session, workspace, title],
            ).unwrap();
        }
    }
    for (id, session, kind, seq, text, time) in [
        (
            "msg_z1",
            "ses_v2",
            "user",
            2,
            "Keep OpenCode v2 question",
            1794877201000_i64,
        ),
        (
            "msg_a1",
            "ses_v2",
            "assistant",
            5,
            "Keep OpenCode v2 answer",
            1794877202000,
        ),
        (
            "msg_z2",
            "ses_v2",
            "user",
            8,
            "Undo OpenCode v2 question",
            1794877260000,
        ),
        (
            "msg_a2",
            "ses_v2",
            "assistant",
            11,
            "Undo OpenCode v2 answer",
            1794877261000,
        ),
        (
            "msg_other",
            "ses_other",
            "user",
            2,
            "Do not touch another session",
            1794877201000,
        ),
    ] {
        let data = if kind == "user" {
            let files = if id == "msg_z2" {
                json!([
                    {"data":"QUJD","mime":"image/png","source":{"type":"inline"},"name":"screen.png"},
                    {"data":"JVBERi1vcmlnaW5hbA==","mime":"application/pdf","source":{"type":"inline"},"name":"notes.pdf"},
                    {"data":"b2xk","mime":"text/plain","source":{"type":"uri","uri":"file:///F:/workspace/current.txt"},"name":"current.txt"}
                ])
            } else {
                json!([])
            };
            json!({"text": text, "files": files, "time": {"created": time}})
        } else {
            json!({
                "agent": "build", "model": {"id": "test-model", "providerID": "openai"},
                "time": {"created": time, "completed": time + 100}, "content": [],
            })
        };
        native
            .execute(
                "INSERT INTO session_message VALUES(?1,?2,?3,?4,?5,?5,?6)",
                rusqlite::params![id, session, kind, seq, time, data.to_string()],
            )
            .unwrap();
        if kind == "assistant" {
            native
                .execute(
                    "INSERT INTO session_part VALUES(?1,?2,0,'text',NULL,?3,?3,?4)",
                    rusqlite::params![
                        id,
                        session,
                        time,
                        json!({"type": "text", "text": text}).to_string()
                    ],
                )
                .unwrap();
        }
    }
    fixture.conversation_id = seed_conversation(&fixture.state.db, 1, AgentType::OpenCode).await;
    conversation_service::bind_external_id(
        &fixture.state.db.conn,
        fixture.conversation_id,
        "ses_v2",
        &[],
    )
    .await
    .unwrap();
    agent_setting_service::ensure_defaults(
        &fixture.state.db.conn,
        &[agent_setting_service::AgentDefaultInput {
            agent_type: AgentType::OpenCode,
            registry_id: "opencode".into(),
            default_sort_order: 1,
        }],
    )
    .await
    .unwrap();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::OpenCode,
        true,
        Some(json!({"XDG_DATA_HOME": home}).to_string()),
    )
    .await
    .unwrap();
    let original = fixture.history().await;
    let preview = fixture.preview_text("Undo OpenCode v2 question").await;
    assert!(
        preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    assert!(
        preview["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|block| { block["type"] == "image" && block["data"] == "QUJD" }),
        "{}",
        preview["input"]
    );
    assert!(
        preview["input"].as_array().unwrap().iter().any(|block| {
            block["type"] == "resource"
                && block["uri"] == "attachment://notes.pdf"
                && block["blob"] == "JVBERi1vcmlnaW5hbA=="
        }),
        "{}",
        preview["input"]
    );
    assert!(
        preview["input"].as_array().unwrap().iter().any(|block| {
            block["type"] == "resource_link" && block["uri"] == "file:///F:/workspace/current.txt"
        }),
        "{}",
        preview["input"]
    );
    if let Some(binary) = native_binary {
        let export = opencode_command(binary, &home, &["session", "export", "ses_v2"]).await;
        let export: Value = serde_json::from_str(&export).unwrap();
        assert_eq!(export["messages"].as_array().unwrap().len(), 4, "{export}");
    }
    let committed = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"],
        }))
        .await;
    assert_eq!(committed.status_code(), 200, "{}", committed.text());
    let after = fixture.history().await;
    assert_eq!(after["turns"].as_array().unwrap().len(), 2);
    assert_eq!(after["turns"][0], original["turns"][0]);
    assert_eq!(after["turns"][1], original["turns"][1]);
    assert_eq!(
        native
            .query_row(
                "SELECT count(*) FROM session_message WHERE session_id = 'ses_other'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    if let Some(binary) = native_binary {
        let export = opencode_command(binary, &home, &["session", "export", "ses_v2"]).await;
        let export: Value = serde_json::from_str(&export).unwrap();
        assert_eq!(export["messages"].as_array().unwrap().len(), 2, "{export}");
    }
    let restored = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId": fixture.conversation_id}))
        .await;
    assert_eq!(restored.status_code(), 200, "{}", restored.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
    assert!(fixture.history().await["turns"][2]["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|block| block["text"] == "Undo OpenCode v2 question"));
    let ids = native
        .prepare("SELECT id FROM session_message WHERE session_id = 'ses_v2' ORDER BY seq")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(ids, ["msg_z1", "msg_a1", "msg_z2", "msg_a2"]);
    assert_eq!(
        std::fs::read_to_string(fixture.root.path().join("workspace/keep.txt")).unwrap(),
        "current workspace content"
    );
    if let Some(binary) = native_binary {
        let export = opencode_command(binary, &home, &["session", "export", "ses_v2"]).await;
        let export: Value = serde_json::from_str(&export).unwrap();
        assert_eq!(export["messages"].as_array().unwrap().len(), 4, "{export}");
    }
    (fixture, path)
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_OPENCODE for the installed native CLI"]
async fn native_opencode_undo_and_redo_export_the_original_session_messages() {
    let binary = std::env::var("CODEG_TEST_OPENCODE").expect("native OpenCode CLI");
    check_opencode_undo_and_redo(Some(std::path::Path::new(&binary))).await;
}

async fn opencode_command(
    binary: &std::path::Path,
    home: &std::path::Path,
    args: &[&str],
) -> String {
    let mut command = codeg_lib::process::tokio_command(binary);
    if args.first() == Some(&"session") {
        // 2.x 默认连接常驻服务；验收只使用随命令退出的隔离服务，不占用用户后台端口。
        command.arg("--standalone");
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(40),
        command
            .args(args)
            .current_dir(home)
            .env("XDG_DATA_HOME", home)
            .env("XDG_CONFIG_HOME", home.join("config"))
            .env("XDG_CACHE_HOME", home.join("cache"))
            .env("XDG_STATE_HOME", home.join("state"))
            .env("OPENCODE_DISABLE_MODELS_FETCH", "1")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

async fn check_opencode_undo_and_redo(native: Option<&std::path::Path>) {
    let mut fixture = Fixture::new().await;
    let home = fixture.root.path().join("opencode-data");
    std::fs::create_dir_all(home.join("opencode")).unwrap();
    if let Some(binary) = native {
        let import_path = home.join("original.json");
        let messages = [
            ("u1","user","Keep OpenCode question",1794877201000_i64),
            ("a1","assistant","Keep OpenCode answer",1794877202000_i64),
            ("u2","user","Undo OpenCode question",1794877260000_i64),
            ("a2","assistant","Undo OpenCode answer",1794877261000_i64),
        ].into_iter().map(|(id,role,text,time)| {
            let id = format!("msg_{id}");
            let mut info = json!({"id":id,"sessionID":"ses_undo","role":role,"agent":"build","model":{"providerID":"openai","modelID":"test-model"},"time":{"created":time}});
            if role == "assistant" {
                info["parentID"] = json!(if id == "msg_a1" {"msg_u1"} else {"msg_u2"});
                info["modelID"] = json!("test-model");
                info["providerID"] = json!("openai");
                info["mode"] = json!("build");
                info["agent"] = json!("build");
                info["path"] = json!({"cwd":"F:/workspace","root":"F:/workspace"});
                info["cost"] = json!(0);
                info["tokens"] = json!({"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}});
            }
            json!({"info":info,"parts":[{"id":format!("prt_{id}"),"sessionID":"ses_undo","messageID":id,"type":"text","text":text}]})
        }).collect::<Vec<_>>();
        std::fs::write(&import_path,json!({"info":{"id":"ses_undo","slug":"undo-acceptance","projectID":"global","directory":"F:/workspace","title":"OpenCode Undo","version":"1.18.15","time":{"created":1794877200000_i64,"updated":1794877261000_i64}},"messages":messages}).to_string()).unwrap();
        opencode_command(
            binary,
            &home,
            &["import", import_path.to_str().unwrap(), "--pure"],
        )
        .await;
    } else {
        let db = rusqlite::Connection::open(home.join("opencode/opencode.db")).unwrap();
        db.execute_batch("
          CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER);
          CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
          CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,time_created INTEGER,data TEXT);
          INSERT INTO session VALUES('ses_undo','F:/workspace',NULL,'OpenCode Undo',1794877200000,1794877261000);
        ").unwrap();
        for (id, role, text, time) in [
            ("u1", "user", "Keep OpenCode question", 1794877201000_i64),
            ("a1", "assistant", "Keep OpenCode answer", 1794877202000_i64),
            ("u2", "user", "Undo OpenCode question", 1794877260000_i64),
            ("a2", "assistant", "Undo OpenCode answer", 1794877261000_i64),
        ] {
            db.execute(
                "INSERT INTO message VALUES(?1,'ses_undo',?2,?3)",
                rusqlite::params![
                    id,
                    time,
                    json!({"role":role,"time":{"created":time}}).to_string()
                ],
            )
            .unwrap();
            db.execute(
                "INSERT INTO part VALUES(?1,?2,?3,?4)",
                rusqlite::params![
                    format!("p-{id}"),
                    id,
                    time,
                    json!({"type":"text","text":text}).to_string()
                ],
            )
            .unwrap();
        }
    }
    fixture.conversation_id = seed_conversation(&fixture.state.db, 1, AgentType::OpenCode).await;
    conversation_service::bind_external_id(
        &fixture.state.db.conn,
        fixture.conversation_id,
        "ses_undo",
        &[],
    )
    .await
    .unwrap();
    agent_setting_service::ensure_defaults(
        &fixture.state.db.conn,
        &[agent_setting_service::AgentDefaultInput {
            agent_type: AgentType::OpenCode,
            registry_id: "opencode".into(),
            default_sort_order: 1,
        }],
    )
    .await
    .unwrap();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::OpenCode,
        true,
        Some(json!({"XDG_DATA_HOME":home}).to_string()),
    )
    .await
    .unwrap();
    let original = fixture.history().await;
    let preview = fixture.preview_text("Undo OpenCode question").await;
    let result = fixture.server.post("/api/conversation_undo_commit").add_header("authorization",format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]})).await;
    assert_eq!(result.status_code(), 200, "{}", result.text());
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    if let Some(binary) = native {
        let export = opencode_command(binary, &home, &["export", "ses_undo", "--pure"]).await;
        let export: Value = serde_json::from_str(&export).unwrap();
        assert_eq!(export["messages"].as_array().unwrap().len(), 2);
    }
    let redo = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(redo.status_code(), 200, "{}", redo.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
    if let Some(binary) = native {
        let export = opencode_command(binary, &home, &["export", "ses_undo", "--pure"]).await;
        let export: Value = serde_json::from_str(&export).unwrap();
        assert_eq!(export["messages"].as_array().unwrap().len(), 4);
    }
    assert_eq!(
        std::fs::read_to_string(fixture.root.path().join("workspace/keep.txt")).unwrap(),
        "current workspace content"
    );
}

#[tokio::test]
async fn deepseek_undo_and_redo_keep_the_native_compressed_event_log() {
    check_deepseek_undo_and_redo(None).await;
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_DEEPSEEK_MODULES pointing to the installed native packages"]
async fn native_deepseek_undo_and_redo_reopen_the_compressed_log_and_restore_session() {
    let modules = std::env::var("CODEG_TEST_DEEPSEEK_MODULES").expect("native DeepSeek modules");
    check_deepseek_undo_and_redo(Some(std::path::Path::new(&modules))).await;
}

async fn read_native_deepseek(
    modules: &std::path::Path,
    root: &std::path::Path,
    session: &str,
) -> Value {
    run_native_deepseek_action(modules, root, session, "read").await
}

async fn run_native_deepseek_action(
    modules: &std::path::Path,
    root: &std::path::Path,
    session: &str,
    action: &str,
) -> Value {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        codeg_lib::process::tokio_command("node")
            .arg("--input-type=module")
            .arg("-e")
            .arg(include_str!(
                "fixtures/conversation_undo/native_deepseek.mjs"
            ))
            .arg(modules)
            .arg(root)
            .arg(session)
            .arg(action)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_str(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .last()
            .unwrap(),
    )
    .unwrap()
}

async fn check_deepseek_undo_and_redo(
    native: Option<&std::path::Path>,
) -> (Fixture, std::path::PathBuf) {
    let mut fixture = Fixture::new().await;
    let sessions = fixture.root.path().join("dsh/sessions");
    let session_id = "b2d45fa2-048b-41bf-bcd1-e482a2a10c59";
    let cwd = fixture
        .root
        .path()
        .join("workspace")
        .to_string_lossy()
        .to_string();
    let mut project = String::new();
    let mut separator = false;
    for character in cwd.chars() {
        if matches!(character, '/' | '\\' | ':') {
            if !separator {
                project.push('-');
            }
            separator = true;
        } else {
            project.push(character);
            separator = false;
        }
    }
    let directory = sessions
        .join(format!("--{}--", project.trim_start_matches('-')))
        .join(session_id);
    std::fs::create_dir_all(&directory).unwrap();
    let mut lines = vec![json!({"type":"session","version":3,"id":session_id,"cwd":fixture.root.path().join("workspace"),"createdAt":1794877200000_i64,"isSeeded":false,"delegationDepth":0}).to_string()];
    let events = [
        ("turn/start", json!({"turn":1}), 1794877201000_i64),
        (
            "user/message",
            json!({"id":"u1","role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"Keep DeepSeek question"}]}),
            1794877201010_i64,
        ),
        (
            "assistant/message",
            json!({"turn":1,"step":1,"stream":[],"message":{"id":"a1","role":"assistant","source":{"kind":"model","provider":"deepseek","model":"test-model"},"content":[{"type":"text","text":"Keep DeepSeek answer"}]}}),
            1794877201100_i64,
        ),
        (
            "turn/end",
            json!({"turn":1,"reason":"completed"}),
            1794877201200_i64,
        ),
        ("turn/start", json!({"turn":2}), 1794877260000_i64),
        (
            "user/message",
            json!({"id":"u2","role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"Undo DeepSeek question"}]}),
            1794877260010_i64,
        ),
        (
            "assistant/message",
            json!({"turn":2,"step":1,"stream":[],"message":{"id":"a2","role":"assistant","source":{"kind":"model","provider":"deepseek","model":"test-model"},"content":[{"type":"text","text":"Undo DeepSeek answer"}]}}),
            1794877260100_i64,
        ),
        (
            "turn/end",
            json!({"turn":2,"reason":"completed"}),
            1794877260200_i64,
        ),
    ];
    for (seq, (kind, data, time)) in events.into_iter().enumerate() {
        let mut event = json!({"type":kind,"seq":seq,"time":time,"data":data});
        if matches!(kind, "user/message" | "assistant/message") {
            event["surfaceOp"] = json!("append");
        }
        lines.push(event.to_string());
    }
    let mut frames = zstd::stream::encode_all(format!("{}\n", lines[0]).as_bytes(), 3).unwrap();
    frames.extend(
        zstd::stream::encode_all(format!("{}\n", lines[1..].join("\n")).as_bytes(), 3).unwrap(),
    );
    std::fs::write(directory.join("session.v3.jsonl.zstd"), frames).unwrap();
    fixture.conversation_id = seed_conversation(&fixture.state.db, 1, AgentType::DeepSeek).await;
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
            agent_type: AgentType::DeepSeek,
            registry_id: "deepseek-acp".into(),
            default_sort_order: 1,
        }],
    )
    .await
    .unwrap();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::DeepSeek,
        true,
        Some(json!({"DEEPSEEK_ACP_SESSIONS_ROOT":sessions}).to_string()),
    )
    .await
    .unwrap();
    let original = fixture.history().await;
    let preview = fixture.preview_text("Undo DeepSeek question").await;
    let result = fixture.server.post("/api/conversation_undo_commit").add_header("authorization",format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]})).await;
    assert_eq!(result.status_code(), 200, "{}", result.text());
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    if let Some(modules) = native {
        assert_eq!(
            read_native_deepseek(modules, &sessions, session_id).await,
            json!({"id":session_id,"users":["u1"]})
        );
    }
    let restored = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(restored.status_code(), 200, "{}", restored.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
    if let Some(modules) = native {
        assert_eq!(
            read_native_deepseek(modules, &sessions, session_id).await,
            json!({"id":session_id,"users":["u1","u2"]})
        );
    }
    (fixture, directory)
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_DEEPSEEK_MODULES for native write ownership"]
async fn native_deepseek_active_writer_blocks_undo_until_the_original_owner_releases() {
    check_native_deepseek_writer(false).await;
}

#[tokio::test]
async fn deepseek_redo_survives_the_native_resume_boundary_without_new_messages() {
    let (fixture, directory) = check_deepseek_undo_and_redo(None).await;
    let original = fixture.history().await;
    let preview = fixture.preview_text("Undo DeepSeek question").await;
    let response = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId": fixture.conversation_id,
            "sourceTurnId": preview["sourceTurnId"],
            "historyRevision": preview["historyRevision"],
        }))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    let path = directory.join("session.v3.jsonl.zstd");
    let mut log = zstd::stream::decode_all(std::fs::read(&path).unwrap().as_slice()).unwrap();
    // 原生 Session.fromRestore 在恢复后的种子末尾追加此边界，但没有增加任何用户输入。
    log.extend_from_slice(
        format!(
            "{}\n",
            json!({"type":"session/end-seed","seq":4,"time":1794877300000_i64,"data":{}})
        )
        .as_bytes(),
    );
    let header_end = log.iter().position(|byte| *byte == b'\n').unwrap() + 1;
    let mut frames = zstd::stream::encode_all(&log[..header_end], 3).unwrap();
    frames.extend(zstd::stream::encode_all(&log[header_end..], 3).unwrap());
    std::fs::write(&path, frames).unwrap();
    let status = fixture
        .server
        .post("/api/conversation_redo_status")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(status.status_code(), 200, "{}", status.text());
    assert_eq!(status.json::<Value>()["available"], true);
    let changed = String::from_utf8(log.clone())
        .unwrap()
        .replace("Keep DeepSeek question", "Changed by another client");
    let mut changed_frames =
        zstd::stream::encode_all(&changed.as_bytes()[..header_end], 3).unwrap();
    changed_frames.extend(zstd::stream::encode_all(&changed.as_bytes()[header_end..], 3).unwrap());
    std::fs::write(&path, &changed_frames).unwrap();
    let status = fixture
        .server
        .post("/api/conversation_redo_status")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(status.status_code(), 200, "{}", status.text());
    assert_eq!(status.json::<Value>()["available"], false);
    let rejected = fixture
        .server
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(rejected.status_code(), 400, "{}", rejected.text());
    assert_eq!(std::fs::read(&path).unwrap(), changed_frames);
    let mut frames = zstd::stream::encode_all(&log[..header_end], 3).unwrap();
    frames.extend(zstd::stream::encode_all(&log[header_end..], 3).unwrap());
    std::fs::write(&path, frames).unwrap();
    let restored = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(restored.status_code(), 200, "{}", restored.text());
    assert_eq!(fixture.history().await["turns"], original["turns"]);
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "requires CODEG_TEST_DEEPSEEK_MODULES for native ownership through a directory link"]
async fn native_deepseek_writer_under_a_directory_link_still_blocks_undo() {
    check_native_deepseek_writer(true).await;
}

async fn check_native_deepseek_writer(linked: bool) {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let modules = std::env::var("CODEG_TEST_DEEPSEEK_MODULES").unwrap();
    let (fixture, directory) = check_deepseek_undo_and_redo(None).await;
    let session_id = directory.file_name().unwrap().to_str().unwrap();
    let root = if linked {
        let link = fixture.root.path().join("linked-dsh");
        #[cfg(windows)]
        {
            let status = codeg_lib::process::std_command("node")
                .args([
                    "-e",
                    "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                ])
                .arg(fixture.root.path().join("dsh"))
                .arg(&link)
                .status()
                .unwrap();
            assert!(status.success());
        }
        agent_setting_service::update_preferences(
            &fixture.state.db.conn,
            AgentType::DeepSeek,
            true,
            Some(
                json!({"DSH_HOME":link,"DEEPSEEK_ACP_SESSIONS_ROOT":link.join("sessions")})
                    .to_string(),
            ),
        )
        .await
        .unwrap();
        link.join("sessions")
    } else {
        fixture.root.path().join("dsh/sessions")
    };
    let mut child = codeg_lib::process::tokio_command("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(include_str!(
            "fixtures/conversation_undo/native_deepseek.mjs"
        ))
        .arg(modules)
        .arg(root)
        .arg(session_id)
        .arg("hold-writer")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
    let ready = tokio::time::timeout(std::time::Duration::from_secs(15), output.next_line()).await;
    let line = match ready {
        Ok(Ok(Some(line))) => line,
        _ => {
            use tokio::io::AsyncReadExt;
            let _ = child.kill().await;
            let mut diagnostic = String::new();
            child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut diagnostic)
                .await
                .unwrap();
            panic!("native DSH writer failed to start: {diagnostic}");
        }
    };
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["writer"], true, "{ready}");
    let preview = fixture.preview_text("Undo DeepSeek question").await;
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
    // 只结束本用例持有写锁的隔离子进程，避免 stdin 句柄阻止 Node 退出而重复等待。
    child.start_kill().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rejected.status_code(), 409, "{}", rejected.text());
    assert_eq!(fixture.history().await["turns"], before["turns"]);
    let preview = fixture.preview_text("Undo DeepSeek question").await;
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
    assert_eq!(response.status_code(), 200, "{}", response.text());
}

#[tokio::test]
async fn deepseek_image_undo_refills_raw_order_and_redo_recovers_the_original_object() {
    check_deepseek_image(None).await;
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_DEEPSEEK_MODULES for native image integrity verification"]
async fn native_deepseek_image_undo_and_redo_reopen_original_content_and_attachment_bytes() {
    let modules = std::env::var("CODEG_TEST_DEEPSEEK_MODULES").unwrap();
    check_deepseek_image(Some(std::path::Path::new(&modules))).await;
}

async fn check_deepseek_image(
    native: Option<&std::path::Path>,
) -> (Fixture, std::path::PathBuf, std::path::PathBuf) {
    let (fixture, directory) = check_deepseek_undo_and_redo(None).await;
    let image_hex = "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082";
    let image_bytes = (0..image_hex.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&image_hex[offset..offset + 2], 16).unwrap())
        .collect::<Vec<_>>();
    let hash = "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";
    let home = fixture.root.path().join("dsh");
    let object = home.join("attachments/v1/objects/43").join(hash);
    std::fs::create_dir_all(object.parent().unwrap()).unwrap();
    std::fs::write(&object, &image_bytes).unwrap();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::DeepSeek,
        true,
        Some(
            json!({"DSH_HOME":home,"DEEPSEEK_ACP_SESSIONS_ROOT":home.join("sessions")}).to_string(),
        ),
    )
    .await
    .unwrap();
    let path = directory.join("session.v3.jsonl.zstd");
    let original = zstd::stream::decode_all(std::fs::read(&path).unwrap().as_slice()).unwrap();
    let mut events = String::from_utf8(original)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let user = events
        .iter_mut()
        .find(|event| event["type"] == "user/message" && event["data"]["id"] == "u2")
        .unwrap();
    user["data"]["content"] = json!([
        {"type":"text","text":"  Undo DSH image\n "},
        {"type":"image","attachment":{
            "attachmentId":format!("sha256:{hash}"),"mediaType":"image/png",
            "bytes":68,"width":1,"height":1,"name":"original.png",
        }},
        {"type":"text","text":" tail  "},
    ]);
    let records = events.iter().map(Value::to_string).collect::<Vec<_>>();
    let mut encoded = zstd::stream::encode_all(format!("{}\n", records[0]).as_bytes(), 3).unwrap();
    encoded.extend(
        zstd::stream::encode_all(format!("{}\n", records[1..].join("\n")).as_bytes(), 3).unwrap(),
    );
    std::fs::write(&path, encoded).unwrap();

    let session_id = directory.file_name().unwrap().to_str().unwrap();
    let original_native = if let Some(modules) = native {
        let original =
            run_native_deepseek_action(modules, &home.join("sessions"), session_id, "read-media")
                .await;
        assert_eq!(
            original["inputs"][1]["parts"][1],
            json!({"type":"image","data":NATIVE_IMAGE})
        );
        Some(original)
    } else {
        None
    };
    let preview = fixture.preview_text("  Undo DSH image\n \n tail  ").await;
    assert!(
        preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    assert_eq!(
        preview["input"],
        json!([
            {"type":"text","text":"  Undo DSH image\n "},
            {"type":"image","data":NATIVE_IMAGE,"mime_type":"image/png","uri":null},
            {"type":"text","text":" tail  "},
        ])
    );
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
    assert_eq!(response.status_code(), 200, "{}", response.text());
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        2
    );
    if let Some(modules) = native {
        let undone =
            run_native_deepseek_action(modules, &home.join("sessions"), session_id, "read-media")
                .await;
        assert_eq!(undone["users"], json!(["u1"]));
    }
    std::fs::remove_file(&object).unwrap();
    let response = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    assert_eq!(std::fs::read(&object).unwrap(), image_bytes);
    assert_eq!(
        fixture.history().await["turns"].as_array().unwrap().len(),
        4
    );
    if let Some(modules) = native {
        assert_eq!(
            run_native_deepseek_action(modules, &home.join("sessions"), session_id, "read-media")
                .await,
            original_native.unwrap()
        );
    }
    (fixture, object, path)
}

#[tokio::test]
async fn deepseek_missing_or_corrupt_image_lists_the_attachment_and_preserves_history() {
    for corrupt in [false, true] {
        let (fixture, object, _) = check_deepseek_image(None).await;
        if corrupt {
            std::fs::write(&object, b"damaged original object").unwrap();
        } else {
            std::fs::remove_file(&object).unwrap();
        }
        let before = fixture.history().await;
        let preview = fixture.preview_text("  Undo DSH image\n \n tail  ").await;
        assert!(
            preview["issues"]
                .as_array()
                .unwrap()
                .iter()
                .any(|issue| issue["label"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("original.png")),
            "{preview}"
        );
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
}

#[tokio::test]
async fn deepseek_image_metadata_must_match_the_original_encoded_dimensions() {
    let (fixture, _, path) = check_deepseek_image(None).await;
    let original = zstd::stream::decode_all(std::fs::read(&path).unwrap().as_slice()).unwrap();
    let mut events = String::from_utf8(original)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let user = events
        .iter_mut()
        .find(|event| event["type"] == "user/message" && event["data"]["id"] == "u2")
        .unwrap();
    user["data"]["content"][1]["attachment"]["width"] = json!(2);
    let records = events.iter().map(Value::to_string).collect::<Vec<_>>();
    let mut encoded = zstd::stream::encode_all(format!("{}\n", records[0]).as_bytes(), 3).unwrap();
    encoded.extend(
        zstd::stream::encode_all(format!("{}\n", records[1..].join("\n")).as_bytes(), 3).unwrap(),
    );
    std::fs::write(&path, encoded).unwrap();
    let preview = fixture.preview_text("  Undo DSH image\n \n tail  ").await;
    assert!(
        !preview["issues"].as_array().unwrap().is_empty(),
        "a ref rejected by native readImage must not authorize Undo: {preview}"
    );
}

#[tokio::test]
async fn deepseek_image_only_saved_input_remains_selectable_and_new_native_content_blocks_redo() {
    let (fixture, _, path) = check_deepseek_image(None).await;
    let original = zstd::stream::decode_all(std::fs::read(&path).unwrap().as_slice()).unwrap();
    let mut events = String::from_utf8(original)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let user = events
        .iter_mut()
        .find(|event| event["type"] == "user/message" && event["data"]["id"] == "u2")
        .unwrap();
    user["data"]["content"] = json!([user["data"]["content"][1].clone()]);
    let records = events.iter().map(Value::to_string).collect::<Vec<_>>();
    let mut encoded = zstd::stream::encode_all(format!("{}\n", records[0]).as_bytes(), 3).unwrap();
    encoded.extend(
        zstd::stream::encode_all(format!("{}\n", records[1..].join("\n")).as_bytes(), 3).unwrap(),
    );
    std::fs::write(&path, encoded).unwrap();
    let history = fixture.history().await;
    let user = history["turns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|turn| turn["role"] == "user" && turn["blocks"][0]["type"] == "image")
        .unwrap();
    let response = fixture
        .server
        .post("/api/conversation_undo_preview")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":user["id"]}))
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
            "type":"image","data":NATIVE_IMAGE,"mime_type":"image/png","uri":null,
        }])
    );
    let response = fixture
        .server
        .post("/api/conversation_undo_commit")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({
            "conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],
            "historyRevision":preview["historyRevision"],
        }))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    let original = zstd::stream::decode_all(std::fs::read(&path).unwrap().as_slice()).unwrap();
    let mut events = String::from_utf8(original)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let user = events
        .iter_mut()
        .find(|event| event["type"] == "user/message")
        .unwrap();
    user["data"]["content"][0]["text"] = json!("New native content must never be overwritten");
    let records = events.iter().map(Value::to_string).collect::<Vec<_>>();
    let mut encoded = zstd::stream::encode_all(format!("{}\n", records[0]).as_bytes(), 3).unwrap();
    encoded.extend(
        zstd::stream::encode_all(format!("{}\n", records[1..].join("\n")).as_bytes(), 3).unwrap(),
    );
    std::fs::write(&path, &encoded).unwrap();
    let response = fixture
        .server
        .post("/api/conversation_redo_status")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    assert_eq!(response.json::<Value>()["available"], false);
    let response = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(response.status_code(), 400, "{}", response.text());
    assert_eq!(std::fs::read(&path).unwrap(), encoded);
}

#[tokio::test]
async fn deepseek_file_only_input_refills_original_pdf_and_redo_restores_the_native_file() {
    check_deepseek_file(None).await;
}

#[tokio::test]
#[ignore = "requires CODEG_TEST_DEEPSEEK_MODULES for native file verification"]
async fn native_deepseek_file_only_undo_and_redo_restore_original_file_bytes() {
    let modules = std::env::var("CODEG_TEST_DEEPSEEK_MODULES").unwrap();
    check_deepseek_file(Some(std::path::Path::new(&modules))).await;
}

async fn check_deepseek_file(native: Option<&std::path::Path>) {
    let (fixture, directory) = check_deepseek_undo_and_redo(None).await;
    let home = fixture.root.path().join("dsh");
    let hash = "514ebf849d05b11d7a0a887bd7716a3e72d07c335c612f3c6abac1dc1683b036";
    let object = home
        .join("attachments/v1/files/51")
        .join(hash)
        .join("notes.pdf");
    std::fs::create_dir_all(object.parent().unwrap()).unwrap();
    std::fs::write(&object, b"original-pdf").unwrap();
    agent_setting_service::update_preferences(
        &fixture.state.db.conn,
        AgentType::DeepSeek,
        true,
        Some(
            json!({"DSH_HOME":home,"DEEPSEEK_ACP_SESSIONS_ROOT":home.join("sessions")}).to_string(),
        ),
    )
    .await
    .unwrap();
    let path = directory.join("session.v3.jsonl.zstd");
    let original = zstd::stream::decode_all(std::fs::read(&path).unwrap().as_slice()).unwrap();
    let mut events = String::from_utf8(original)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let user = events
        .iter_mut()
        .find(|event| event["type"] == "user/message" && event["data"]["id"] == "u2")
        .unwrap();
    user["data"]["content"] = json!([{"type":"file","attachment":{
        "attachmentId":format!("sha256:{hash}"),"bytes":12,"name":"notes.pdf",
    }}]);
    let records = events.iter().map(Value::to_string).collect::<Vec<_>>();
    let mut encoded = zstd::stream::encode_all(format!("{}\n", records[0]).as_bytes(), 3).unwrap();
    encoded.extend(
        zstd::stream::encode_all(format!("{}\n", records[1..].join("\n")).as_bytes(), 3).unwrap(),
    );
    std::fs::write(&path, encoded).unwrap();
    let session_id = directory.file_name().unwrap().to_str().unwrap();
    let original_native = if let Some(modules) = native {
        let original =
            run_native_deepseek_action(modules, &home.join("sessions"), session_id, "read-media")
                .await;
        assert_eq!(
            original["inputs"][1]["parts"][0],
            json!({"type":"file","name":"notes.pdf","data":"b3JpZ2luYWwtcGRm"})
        );
        Some(original)
    } else {
        None
    };
    let history = fixture.history().await;
    assert!(
        history["turns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|turn| turn["role"] == "user"
                && turn["blocks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|block| block["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("notes.pdf")))),
        "file-only user input must remain selectable: {history}"
    );
    let preview = fixture.preview_text("@notes.pdf").await;
    assert!(
        preview["issues"].as_array().unwrap().is_empty(),
        "{preview}"
    );
    assert_eq!(
        preview["input"],
        json!([{
            "type":"resource","uri":"attachment://notes.pdf","mime_type":"application/pdf",
            "text":null,"blob":"b3JpZ2luYWwtcGRm",
        }])
    );
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
    assert_eq!(response.status_code(), 200, "{}", response.text());
    std::fs::remove_file(&object).unwrap();
    let response = fixture
        .reopen()
        .post("/api/conversation_redo")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"conversationId":fixture.conversation_id}))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    assert_eq!(std::fs::read(&object).unwrap(), b"original-pdf");
    assert_eq!(fixture.history().await["turns"], history["turns"]);
    if let Some(modules) = native {
        assert_eq!(
            run_native_deepseek_action(modules, &home.join("sessions"), session_id, "read-media")
                .await,
            original_native.unwrap()
        );
    }
}

#[tokio::test]
async fn a_custom_agents_display_transcript_alone_never_authorizes_native_history_deletion() {
    let mut fixture = Fixture::new().await;
    let agent = AgentType::Custom("undo-native-unknown");
    fixture.conversation_id = seed_conversation(&fixture.state.db, 1, agent).await;
    conversation_service::bind_external_id(
        &fixture.state.db.conn,
        fixture.conversation_id,
        "custom-session",
        &[],
    )
    .await
    .unwrap();
    let data = fixture.root.path().join("data");
    let directory = data.join("acp-transcripts/undo-native-unknown");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("custom-session.jsonl"), [
        json!({"v":1,"kind":"header","agent":"custom:undo-native-unknown","session_id":"custom-session","cwd":fixture.root.path().join("workspace"),"started_at_ms":1794877200000_i64}).to_string(),
        json!({"t":1794877201000_i64,"k":"prompt","p":[{"type":"text","text":"Do not pretend this is the native agent context"}]}).to_string(),
        json!({"t":1794877202000_i64,"k":"turn_end","p":{"stopReason":"end_turn"}}).to_string(),
    ].join("\n")).unwrap();
    let data = data.to_string_lossy().to_string();
    temp_env::async_with_vars([("CODEG_HOME",Some(data.as_str()))],async {
        let original = fixture.history().await;
        let preview = fixture.preview_text("Do not pretend this is the native agent context").await;
        assert!(preview["issues"].as_array().unwrap().iter().any(|issue|issue["code"]=="unsupported_native_undo"),"{preview}");
        let result = fixture.server.post("/api/conversation_undo_commit").add_header("authorization",format!("Bearer {TOKEN}"))
            .json(&json!({"conversationId":fixture.conversation_id,"sourceTurnId":preview["sourceTurnId"],"historyRevision":preview["historyRevision"]})).await;
        assert_eq!(result.status_code(),400,"{}",result.text());
        assert_eq!(fixture.history().await["turns"],original["turns"]);
    }).await;
}
