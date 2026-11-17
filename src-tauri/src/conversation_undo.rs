use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};

use crate::acp::manager::ConnectionManager;
use crate::acp::types::ConnectionStatus;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::entities::conversation::ConversationKind;
use crate::db::service::{agent_setting_service, conversation_service};
use crate::db::AppDatabase;
use crate::models::{AgentType, ContentBlock, MessageTurn, TurnRole};
use crate::parsers::AgentParser;
use crate::research_branch::PromptSnapshot;

mod cleanup;
mod codex;
mod deepseek;
mod gemini;
mod hermes;
mod history;
mod input;
mod opencode;
pub(crate) mod operations;
mod pi;
mod stop;
pub use cleanup::{cleanup_expired, cleanup_task};
pub use history::{
    clear_redo, commit, redo, redo_status, CommitRequest, CommitResult, ConversationRequest,
    RedoStatus,
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRequest {
    pub conversation_id: i32,
    pub source_turn_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoIssue {
    pub code: String,
    pub label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoTask {
    pub id: String,
    pub kind: String,
    pub label: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoPreview {
    pub conversation_id: i32,
    pub session_id: String,
    pub source_turn_id: String,
    pub history_revision: String,
    #[serde(skip)]
    pub(crate) history_anchor_revision: String,
    pub affected_turns: usize,
    pub affected_user_messages: usize,
    pub prompt: MessageTurn,
    pub input: Vec<crate::acp::types::PromptInputBlock>,
    pub issues: Vec<UndoIssue>,
    pub tasks: Vec<UndoTask>,
}

pub async fn preview(
    db: &AppDatabase,
    manager: &ConnectionManager,
    request: PreviewRequest,
) -> Result<UndoPreview, AppCommandError> {
    use sha2::{Digest, Sha256};

    let row = conversation_service::get_by_id(&db.conn, request.conversation_id)
        .await
        .map_err(AppCommandError::from)?;
    if !matches!(row.kind, ConversationKind::Regular | ConversationKind::Chat) {
        return Err(AppCommandError::invalid_input(
            "Undo is only available for regular conversations",
        ));
    }
    let session_id = row
        .external_id
        .ok_or_else(|| AppCommandError::invalid_input("The conversation has no saved session"))?;
    let env = agent_setting_service::load_agent_env(&db.conn, row.agent_type).await;
    let tasks = stop::session_tasks(manager, row.agent_type, &session_id).await;
    tokio::task::spawn_blocking(move || {
        let parser = crate::parsers::build_agent_parser(row.agent_type, &env);
        let detail = parser
            .get_conversation(&session_id)
            .map_err(|error| failed(error.to_string()))?;
        if detail.summary.id != session_id {
            return Err(AppCommandError::invalid_input("Session identity changed"));
        }
        let index = detail
            .turns
            .iter()
            .position(|turn| {
                turn.id == request.source_turn_id && matches!(turn.role, TurnRole::User)
            })
            .ok_or_else(|| {
                AppCommandError::invalid_input("The selected user message no longer exists")
            })?;
        // 版本覆盖整段有效历史，不能只核对起点而漏掉其他客户端新增的尾部。
        let history =
            serde_json::to_vec(&detail.turns).map_err(|error| failed(error.to_string()))?;
        // 只允许被确认停止的当前回复继续落盘；所有已保存输入及其之前的历史必须不变。
        let input_end = detail
            .turns
            .iter()
            .rposition(|turn| matches!(turn.role, TurnRole::User))
            .map_or(0, |position| position + 1);
        let anchor = serde_json::to_vec(&detail.turns[..input_end])
            .map_err(|error| failed(error.to_string()))?;
        let issues = match row.agent_type {
            AgentType::ClaudeCode =>
                history::attachment_issues(row.agent_type, &env, &session_id, &detail.turns[index])?,
            AgentType::Gemini => gemini::issues(&env, &session_id, &detail.turns[index])?,
            AgentType::Pi => pi::issues(&env, &session_id, &detail.turns[index])?,
            AgentType::Hermes => hermes::issues(&env, &session_id, &detail.turns[index])?,
            AgentType::OpenCode => opencode::issues(&env, &session_id, &detail.turns[index])?,
            AgentType::DeepSeek => deepseek::issues(&env, &session_id, &detail.turns[index])?,
            AgentType::Codex => Vec::new(),
            _ => vec![UndoIssue {
                code: "unsupported_native_undo".into(),
                label: "This agent has no verified exact native history rewind. Its conversation has been kept.".into(),
            }],
        };
        let input = if row.agent_type == AgentType::ClaudeCode && issues.is_empty() {
            history::claude_input(row.agent_type, &env, &session_id, &detail.turns[index])?
        } else {
            input::from_turn(&detail.turns[index])
        };
        Ok(UndoPreview {
            conversation_id: request.conversation_id,
            session_id,
            source_turn_id: request.source_turn_id,
            history_revision: format!("{:x}", Sha256::digest(history)),
            history_anchor_revision: format!("{:x}", Sha256::digest(anchor)),
            affected_turns: detail.turns.len() - index,
            affected_user_messages: detail.turns[index..]
                .iter()
                .filter(|turn| matches!(turn.role, TurnRole::User))
                .count(),
            prompt: detail.turns[index].clone(),
            input,
            issues,
            tasks,
        })
    })
    .await
    .map_err(|error| failed(error.to_string()))?
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UndoRequest {
    pub conversation_id: i32,
    pub source_turn_id: String,
    pub source_prompt: PromptSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub conversation_id: i32,
    pub session_id: String,
}

fn failed(message: impl Into<String>) -> AppCommandError {
    AppCommandError::task_execution_failed(message)
}

fn selected_prompt<'a>(
    turns: &'a [MessageTurn],
    request: &UndoRequest,
) -> Result<&'a MessageTurn, AppCommandError> {
    let prompt = turns
        .iter()
        .find(|turn| turn.id == request.source_turn_id)
        .ok_or_else(|| AppCommandError::invalid_input("The selected prompt no longer exists"))?;
    let text = prompt
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !matches!(prompt.role, TurnRole::User)
        || prompt.blocks.is_empty()
        || prompt
            .blocks
            .iter()
            .any(|block| !matches!(block, ContentBlock::Text { .. }))
        || text.trim().is_empty()
        || text != request.source_prompt.text
        || prompt.timestamp != request.source_prompt.timestamp
        || prompt.agent_message_id != request.source_prompt.agent_message_id
    {
        return Err(AppCommandError::invalid_input(
            "The selected prompt changed; refresh the conversation and try again",
        ));
    }
    Ok(prompt)
}

pub async fn undo(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &std::path::Path,
    request: UndoRequest,
) -> Result<UndoResult, AppCommandError> {
    let db = AppDatabase {
        conn: db.conn.clone(),
    };
    let manager = manager.clone_ref();
    let data_dir = data_dir.to_path_buf();
    // 请求断线后仍完成已确认的原生回退，避免只关闭连接却留下半途操作。
    tokio::spawn(async move {
        let _spawn_guard = manager.lock_out_new_connections().await;
        let row = conversation_service::get_by_id(&db.conn, request.conversation_id)
            .await
            .map_err(AppCommandError::from)?;
        if row.agent_type != AgentType::Codex {
            return Err(AppCommandError::invalid_input(
                "Undo requires a Codex conversation",
            ));
        }
        if !matches!(row.kind, ConversationKind::Regular | ConversationKind::Chat) {
            return Err(AppCommandError::invalid_input(
                "Undo is only available for regular conversations",
            ));
        }
        let session_id = row.external_id.ok_or_else(|| {
            AppCommandError::invalid_input("The conversation has no saved session")
        })?;
        let entries = {
            let connections = manager.connections.lock().await;
            connections
                .values()
                .map(|connection| {
                    (
                        connection.id.clone(),
                        connection.state.clone(),
                        connection.prompt_lock.clone(),
                        connection.child_pid.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        let mut prompt_guards = Vec::new();
        let mut disconnect = Vec::new();
        for (id, state, prompt_lock, pid) in entries {
            let state = state.read().await;
            if state.agent_type != AgentType::Codex
                || state.external_id.as_deref() != Some(session_id.as_str())
            {
                continue;
            }
            let guard = prompt_lock.try_lock_owned().map_err(|_| {
                AppCommandError::new(
                    AppErrorCode::TurnInProgress,
                    "Wait for the current turn to finish",
                )
            })?;
            if state.turn_in_flight
                || state.agent_initiated_turn
                || state.status != ConnectionStatus::Connected
                || state.live_message.is_some()
                || !state.active_tool_calls.is_empty()
                || state.pending_permission.is_some()
                || state.pending_question.is_some()
                || state.pending_plan_approval.is_some()
                || state.remote_control.is_some()
                || !state.active_delegations.is_empty()
                || state.background_outstanding > 0
                || state
                    .async_tasks
                    .values()
                    .any(|task| !crate::acp::types::async_task_state_is_terminal(&task.state))
            {
                return Err(AppCommandError::new(
                    AppErrorCode::TurnInProgress,
                    "Wait for all session work to finish",
                ));
            }
            prompt_guards.push(guard);
            disconnect.push((id, pid));
        }
        let env = agent_setting_service::load_agent_env(&db.conn, AgentType::Codex).await;
        let source_session_id = session_id.clone();
        let source_request = request.clone();
        let before_turn_id = tokio::task::spawn_blocking(move || {
            let parser = crate::parsers::codex::CodexParser::for_env(&env);
            let detail = parser
                .get_conversation(&source_session_id)
                .map_err(|error| failed(error.to_string()))?;
            if detail.summary.id != source_session_id {
                return Err(AppCommandError::invalid_input("Session identity changed"));
            }
            let prompt = selected_prompt(&detail.turns, &source_request)?;
            parser
                .undo_turn_id(&source_session_id, prompt)
                .map_err(|error| failed(error.to_string()))?
                .ok_or_else(|| {
                    AppCommandError::invalid_input(
                        "This message is not the start of a saved Codex turn",
                    )
                })
        })
        .await
        .map_err(|error| failed(error.to_string()))??;
        let runtime = crate::acp::codex_runtime::current().await;
        let codex_js = runtime
            .codex_js
            .ok_or_else(|| failed("The Codex runtime could not be located"))?;
        let runtime_env = crate::commands::acp::build_session_runtime_env(
            &db,
            AgentType::Codex,
            Some(&session_id),
            &data_dir,
        )
        .await
        .map_err(|error| failed(error.to_string()))?;
        let mut client = HistoryClient::spawn(&codex_js, runtime_env).await?;
        let metadata = client
            .call(
                "thread/read",
                json!({
                    "threadId": session_id, "includeTurns": false,
                }),
            )
            .await?;
        if metadata["thread"]["id"].as_str() != Some(session_id.as_str())
            || metadata["thread"]["historyMode"] != "paginated"
        {
            return Err(AppCommandError::invalid_input(
                "This Codex session does not support native undo",
            ));
        }

        // 撤回前先终止持有旧历史的 ACP 连接，避免代理在回退后继续基于旧上下文写入。
        for (id, pid) in disconnect {
            manager
                .disconnect(&id)
                .await
                .map_err(|error| failed(error.to_string()))?;
            tokio::time::timeout(Duration::from_secs(5), async {
                while pid.load(Ordering::SeqCst) != 0 {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .map_err(|_| failed("The previous session is still shutting down"))?;
        }

        // 连接退出期间可能有另一个客户端写入；紧邻原生回退再次核对精确边界。
        let env = agent_setting_service::load_agent_env(&db.conn, AgentType::Codex).await;
        let source_session_id = session_id.clone();
        let source_request = request.clone();
        let verified_turn_id = tokio::task::spawn_blocking(move || {
            let parser = crate::parsers::codex::CodexParser::for_env(&env);
            let detail = parser
                .get_conversation(&source_session_id)
                .map_err(|error| failed(error.to_string()))?;
            if detail.summary.id != source_session_id {
                return Err(AppCommandError::invalid_input("Session identity changed"));
            }
            let prompt = selected_prompt(&detail.turns, &source_request)?;
            parser
                .undo_turn_id(&source_session_id, prompt)
                .map_err(|error| failed(error.to_string()))?
                .ok_or_else(|| {
                    AppCommandError::invalid_input(
                        "This message is no longer the start of the selected turn",
                    )
                })
        })
        .await
        .map_err(|error| failed(error.to_string()))??;
        if verified_turn_id != before_turn_id {
            return Err(AppCommandError::invalid_input(
                "Conversation history changed; refresh before undoing",
            ));
        }
        client
            .call(
                "thread/resume",
                json!({
                    "threadId": session_id, "excludeTurns": true,
                }),
            )
            .await?;
        let result = client
            .call(
                "thread/revert",
                json!({
                    "threadId": session_id, "beforeTurnId": before_turn_id,
                }),
            )
            .await?;
        if result["thread"]["id"].as_str() != Some(session_id.as_str()) {
            return Err(failed("Codex returned a different session after undo"));
        }
        client.close().await;
        Ok(UndoResult {
            conversation_id: request.conversation_id,
            session_id,
        })
    })
    .await
    .map_err(|error| failed(error.to_string()))?
}

struct HistoryClient {
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    next_id: u64,
    closed: bool,
}

impl HistoryClient {
    async fn spawn(
        codex_js: &std::path::Path,
        env: BTreeMap<String, String>,
    ) -> Result<Self, AppCommandError> {
        let node = which::which("node").map_err(|error| failed(error.to_string()))?;
        let mut command = crate::process::tokio_command(&node);
        command
            .arg(codex_js)
            .arg("app-server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (key, value) in env {
            if value.is_empty() {
                command.env_remove(key);
            } else {
                command.env(key, value);
            }
        }
        let mut child = command.spawn().map_err(AppCommandError::io)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| failed("Codex stdin is unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| failed("Codex stdout is unavailable"))?;
        let mut client = Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 0,
            closed: false,
        };
        client
            .call(
                "initialize",
                json!({
                    "clientInfo": {"name": "codeg_undo", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {"experimentalApi": true},
                }),
            )
            .await?;
        client
            .write(json!({"method": "initialized", "params": {}}))
            .await?;
        Ok(client)
    }

    async fn write(&mut self, value: Value) -> Result<(), AppCommandError> {
        let mut bytes = serde_json::to_vec(&value).map_err(|error| failed(error.to_string()))?;
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(AppCommandError::io)?;
        self.stdin.flush().await.map_err(AppCommandError::io)
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, AppCommandError> {
        self.next_id += 1;
        let id = self.next_id;
        self.write(json!({"id": id, "method": method, "params": params}))
            .await?;
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let line = self
                    .lines
                    .next_line()
                    .await
                    .map_err(AppCommandError::io)?
                    .ok_or_else(|| failed("Codex closed the history connection"))?;
                let response: Value =
                    serde_json::from_str(&line).map_err(|error| failed(error.to_string()))?;
                if response.get("method").is_some() {
                    if let Some(request_id) = response.get("id") {
                        // 历史操作无需工具执行或人工授权；拒绝意外的服务端请求。
                        self.write(json!({
                            "id": request_id,
                            "error": {"code": -32601, "message": "History operation only"},
                        }))
                        .await?;
                    }
                    continue;
                }
                if response["id"].as_u64() != Some(id) {
                    continue;
                }
                if let Some(error) = response.get("error") {
                    return Err(failed(
                        error["message"].as_str().unwrap_or("Codex undo failed"),
                    ));
                }
                return response
                    .get("result")
                    .cloned()
                    .ok_or_else(|| failed("Codex returned no history result"));
            }
        })
        .await
        .map_err(|_| failed("Codex history operation timed out"))?
    }

    async fn close(&mut self) {
        let _ = self.stdin.shutdown().await;
        let exited = matches!(
            tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await,
            Ok(Ok(_))
        );
        if !exited {
            if let Some(pid) = self.child.id() {
                let _ = kill_tree::blocking::kill_tree(pid);
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
        }
        self.closed = true;
    }
}

impl Drop for HistoryClient {
    fn drop(&mut self) {
        if !self.closed {
            // Node 包装器还持有原生子进程，必须清理本次创建的整棵进程树。
            if let Some(pid) = self.child.id() {
                let _ = kill_tree::blocking::kill_tree(pid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use sea_orm::{ActiveModelTrait, EntityTrait, Set};

    fn event_line(ordinal: u64, timestamp: &str, kind: &str, fields: Value) -> String {
        let mut payload = fields.as_object().cloned().unwrap_or_default();
        payload.insert("type".to_string(), Value::String(kind.to_string()));
        json!({
            "ordinal": ordinal,
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": payload,
        })
        .to_string()
    }

    fn response_message_line(ordinal: u64, timestamp: &str, role: &str, text: &str) -> String {
        json!({
            "ordinal": ordinal,
            "timestamp": timestamp,
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": role,
                "content": [{
                    "type": if role == "user" { "input_text" } else { "output_text" },
                    "text": text,
                }],
            },
        })
        .to_string()
    }

    #[tokio::test]
    #[ignore = "requires an installed native Codex runtime; run explicitly for real acceptance"]
    async fn undo_reverts_codex_history_in_place_and_keeps_the_selected_text() {
        let temp = tempfile::tempdir().expect("create isolated undo home");
        let codex_home = temp.path().join("codex-home");
        let now = chrono::Utc::now();
        let base = now
            .date_naive()
            .and_hms_opt(10, 0, 0)
            .expect("valid fixture time")
            .and_utc();
        let timestamp = |millis: i64| {
            (base + chrono::Duration::milliseconds(millis))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let sessions_dir = codex_home
            .join("sessions")
            .join(now.format("%Y/%m/%d").to_string());
        let workspace = temp.path().join("workspace");
        let data_dir = temp.path().join("data");
        std::fs::create_dir_all(&sessions_dir).expect("create sessions directory");
        std::fs::create_dir_all(&workspace).expect("create isolated workspace");
        std::fs::create_dir_all(&data_dir).expect("create isolated app data");

        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let folder_id =
            crate::db::test_helpers::seed_folder(&db, &workspace.to_string_lossy()).await;
        let conversation_id =
            crate::db::test_helpers::seed_conversation(&db, folder_id, AgentType::Codex).await;
        let session_id = uuid::Uuid::new_v4().to_string();
        let mut row: crate::db::entities::conversation::ActiveModel =
            crate::db::entities::conversation::Entity::find_by_id(conversation_id)
                .one(&db.conn)
                .await
                .expect("query seeded conversation")
                .expect("seeded conversation exists")
                .into();
        row.external_id = Set(Some(session_id.clone()));
        row.update(&db.conn)
            .await
            .expect("bind isolated Codex session");
        agent_setting_service::ensure_defaults(
            &db.conn,
            &[agent_setting_service::AgentDefaultInput {
                agent_type: AgentType::Codex,
                registry_id: "codex-acp".to_string(),
                default_sort_order: 0,
            }],
        )
        .await
        .expect("seed Codex settings");
        agent_setting_service::update_preferences(
            &db.conn,
            AgentType::Codex,
            true,
            Some(
                serde_json::json!({
                    "CODEX_HOME": codex_home.to_string_lossy(),
                })
                .to_string(),
            ),
        )
        .await
        .expect("point Codex at isolated home");

        let first_task = uuid::Uuid::new_v4().to_string();
        let second_task = uuid::Uuid::new_v4().to_string();
        let lines = vec![
            json!({
                "ordinal": 0,
                "timestamp": timestamp(0),
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "session_id": session_id,
                    "timestamp": timestamp(0),
                    "cwd": workspace.to_string_lossy(),
                    "originator": "codex_cli_rs",
                    "cli_version": "0.166.0",
                    "history_mode": "paginated",
                    "model_provider": "openai",
                    "source": "cli",
                },
            })
            .to_string(),
            event_line(
                1,
                &timestamp(1_000),
                "task_started",
                json!({"turn_id": first_task}),
            ),
            event_line(
                2,
                &timestamp(1_100),
                "user_message",
                json!({"message": "Keep this prompt"}),
            ),
            response_message_line(3, &timestamp(1_100), "user", "Keep this prompt"),
            response_message_line(4, &timestamp(2_000), "assistant", "Keep this reply"),
            event_line(
                5,
                &timestamp(2_000),
                "agent_message",
                json!({"message": "Keep this reply"}),
            ),
            event_line(
                6,
                &timestamp(3_000),
                "task_complete",
                json!({"turn_id": first_task}),
            ),
            event_line(
                7,
                &timestamp(61_000),
                "task_started",
                json!({"turn_id": second_task}),
            ),
            event_line(
                8,
                &timestamp(61_100),
                "user_message",
                json!({"message": "Undo this prompt"}),
            ),
            response_message_line(9, &timestamp(61_100), "user", "Undo this prompt"),
            response_message_line(10, &timestamp(62_000), "assistant", "Remove this reply"),
            event_line(
                11,
                &timestamp(62_000),
                "agent_message",
                json!({"message": "Remove this reply"}),
            ),
            event_line(
                12,
                &timestamp(63_000),
                "task_complete",
                json!({"turn_id": second_task}),
            ),
        ];
        let rollout = sessions_dir.join(format!(
            "rollout-{}-{session_id}.jsonl",
            now.format("%Y-%m-%dT%H-%M-%S")
        ));
        std::fs::write(&rollout, format!("{}\n", lines.join("\n")))
            .expect("write realistic paginated Codex history");

        let env = agent_setting_service::load_agent_env(&db.conn, AgentType::Codex).await;
        let parser = crate::parsers::codex::CodexParser::for_env(&env);
        let before = parser
            .get_conversation(&session_id)
            .expect("parse isolated Codex history");
        let selected = before
            .turns
            .iter()
            .find(|turn| {
                turn.blocks.iter().any(
                    |block| matches!(block, ContentBlock::Text { text } if text == "Undo this prompt"),
                )
            })
            .expect("find the message to undo");
        let request = UndoRequest {
            conversation_id,
            source_turn_id: selected.id.clone(),
            source_prompt: PromptSnapshot {
                text: "Undo this prompt".to_string(),
                timestamp: selected.timestamp,
                agent_message_id: selected.agent_message_id.clone(),
            },
        };

        let result = undo(&db, &ConnectionManager::new(), &data_dir, request)
            .await
            .expect("run Codeg Undo against the real Codex app-server");
        assert_eq!(result.conversation_id, conversation_id);
        assert_eq!(result.session_id, session_id);

        let after = parser
            .get_conversation(&session_id)
            .expect("parse reverted Codex history");
        let texts: Vec<_> = after
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(texts.contains(&"Keep this prompt"));
        assert!(texts.contains(&"Keep this reply"));
        assert!(!texts.contains(&"Undo this prompt"));
        assert!(!texts.contains(&"Remove this reply"));
    }
}
