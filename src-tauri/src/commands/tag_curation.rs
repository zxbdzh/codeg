use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::ai::tag_curation::{self, Choice, Job, Outcome};
use crate::app_error::AppCommandError;
use crate::db::error::DbError;
use crate::db::service::conversation_service;
use crate::db::AppDatabase;
use crate::web::event_bridge::{
    emit_event, ConversationChange, ConversationTagChange, EventEmitter,
    CONVERSATION_CHANGED_EVENT, CONVERSATION_TAG_CHANGED_EVENT,
};

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Request {
    Status,
    Start,
    Retry { id: String },
    Discard { id: String },
    Apply { id: String, choices: Vec<Choice> },
    History,
    Undo { id: String },
    Purge { id: String },
    SetProtection { tag_ids: Vec<i32>, protected: bool },
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum Response {
    Job(Option<Job>),
    History(Vec<Job>),
    Outcome(Outcome),
    Done(()),
}

async fn publish_changes(
    emitter: &EventEmitter,
    db: &AppDatabase,
    tag_ids: &BTreeSet<i32>,
    conversations: &BTreeSet<i32>,
) {
    if !tag_ids.is_empty() {
        // 撤销可恢复被删除的 ID，普通 Upsert 无法越过客户端的删除记录。
        emit_event(
            emitter,
            CONVERSATION_TAG_CHANGED_EVENT,
            ConversationTagChange::Resync,
        );
    }
    for &id in conversations {
        if let Ok(summary) = conversation_service::get_by_id(&db.conn, id).await {
            emit_event(
                emitter,
                CONVERSATION_CHANGED_EVENT,
                ConversationChange::Upsert {
                    summary: Box::new(summary),
                },
            );
            crate::commands::tag_suggestions::emit_changed(emitter, id);
        }
    }
}

pub async fn tag_curation_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    request: Request,
) -> Result<Response, AppCommandError> {
    let result = execute(emitter, db, request).await;
    result.map_err(|error| match error {
        DbError::Conflict(message) => AppCommandError::already_exists(message),
        DbError::Validation(message) => AppCommandError::invalid_input(message),
        DbError::NotFound(message) => AppCommandError::not_found(message),
        other => other.into(),
    })
}

async fn execute(
    emitter: &EventEmitter,
    db: &AppDatabase,
    request: Request,
) -> Result<Response, DbError> {
    let conn = &db.conn;
    Ok(match request {
        Request::Status => Response::Job(tag_curation::status(conn).await?),
        Request::Start => Response::Job(Some(tag_curation::start(conn).await?)),
        Request::Retry { id } => Response::Job(Some(tag_curation::retry(conn, &id).await?)),
        Request::Discard { id } => {
            tag_curation::discard(conn, &id).await?;
            Response::Done(())
        }
        Request::Apply { id, choices } => {
            let outcome = tag_curation::apply(conn, &id, choices).await?;
            publish_changes(emitter, db, &outcome.tag_ids, &outcome.conversation_ids).await;
            Response::Outcome(outcome)
        }
        Request::History => Response::History(tag_curation::history(conn).await?),
        Request::Undo { id } => {
            let outcome = tag_curation::undo(conn, &id).await?;
            publish_changes(emitter, db, &outcome.tag_ids, &outcome.conversation_ids).await;
            Response::Outcome(outcome)
        }
        Request::Purge { id } => {
            tag_curation::purge(conn, &id).await?;
            Response::Done(())
        }
        Request::SetProtection { tag_ids, protected } => {
            tag_curation::set_protection(conn, tag_ids.clone(), protected).await?;
            publish_changes(
                emitter,
                db,
                &tag_ids.into_iter().collect(),
                &BTreeSet::new(),
            )
            .await;
            Response::Done(())
        }
    })
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn tag_curation(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    request: Request,
) -> Result<Response, AppCommandError> {
    tag_curation_core(&EventEmitter::from_app(&app), &db, request).await
}
