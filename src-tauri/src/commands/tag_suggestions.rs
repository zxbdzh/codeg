#[cfg(feature = "tauri-runtime")]
use crate::ai::tag_store::TagBatch;
use crate::ai::tag_store::{self, TagChoice, TagStatus};
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::web::event_bridge::{
    emit_event, ConversationChange, EventEmitter, CONVERSATION_CHANGED_EVENT,
};

pub fn emit_changed(emitter: &EventEmitter, conversation_id: i32) {
    emit_event(
        emitter,
        "ai-tags://changed",
        serde_json::json!({ "conversationId": conversation_id }),
    );
}

pub async fn get_tag_suggestion_status_core(
    db: &AppDatabase,
    conversation_id: i32,
) -> Result<TagStatus, AppCommandError> {
    crate::db::service::conversation_service::get_by_id(&db.conn, conversation_id)
        .await
        .map_err(|_| AppCommandError::not_found(format!("conversation {conversation_id} not found")))?;
    Ok(tag_store::read_status(&db.conn, conversation_id).await?)
}

pub async fn generate_tag_suggestion_batch_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    manager: &crate::acp::manager::ConnectionManager,
    conversation_id: i32,
    force: bool,
) -> Result<TagStatus, AppCommandError> {
    let status =
        load_or_generate_tag_suggestion_batch_core(db, manager, conversation_id, force).await?;
    emit_changed(emitter, conversation_id);
    Ok(status)
}

pub async fn load_or_generate_tag_suggestion_batch_core(
    db: &AppDatabase,
    manager: &crate::acp::manager::ConnectionManager,
    conversation_id: i32,
    force: bool,
) -> Result<TagStatus, AppCommandError> {
    let status = get_tag_suggestion_status_core(db, conversation_id).await?;
    let settings = crate::ai::settings::load(&db.conn).await?;
    let availability = crate::ai::settings::availability(&db.conn, &settings).await?;
    if !availability.is_ready() {
        if !force && status.batch.is_some() {
            return Ok(status);
        }
        return Err(crate::commands::ai_assistant::to_app_error(
            crate::ai::suggest::AiFlowError::NotConfigured(availability),
        ));
    }
    let client = crate::commands::ai_assistant::client()
        .map_err(crate::commands::ai_assistant::to_app_error)?;
    let source = crate::ai::tag_jobs::TranscriptSource {
        conn: db.conn.clone(),
        manager: manager.clone_ref(),
    };
    let status = crate::ai::tag_jobs::generate_manual(
        &db.conn,
        client,
        &source,
        conversation_id,
        force,
        chrono::Utc::now().timestamp(),
    )
    .await?;
    Ok(status)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn generate_tag_suggestion_batch(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    conversation_id: i32,
    force: Option<bool>,
) -> Result<TagStatus, AppCommandError> {
    generate_tag_suggestion_batch_core(
        &EventEmitter::Tauri(app),
        &db,
        &manager,
        conversation_id,
        force.unwrap_or(false),
    )
    .await
}

pub async fn confirm_tag_suggestion_batch_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    conversation_id: i32,
    batch_id: &str,
    choices: Vec<TagChoice>,
) -> Result<crate::models::DbConversationSummary, AppCommandError> {
    if choices.is_empty() {
        return Err(AppCommandError::invalid_input(
            "select a tag or skip the batch",
        ));
    }
    tag_store::confirm_batch(&db.conn, conversation_id, batch_id, choices).await?;
    let summary =
        crate::db::service::conversation_service::get_by_id(&db.conn, conversation_id).await?;
    emit_event(
        emitter,
        CONVERSATION_CHANGED_EVENT,
        ConversationChange::Upsert {
            summary: Box::new(summary.clone()),
        },
    );
    // 新建标签定义只在事务提交后发布，所有窗口回读同一份定义池。
    let tags = crate::db::service::conversation_tag_service::list_tags(&db.conn).await?;
    for tag in tags {
        emit_event(
            emitter,
            crate::web::event_bridge::CONVERSATION_TAG_CHANGED_EVENT,
            crate::web::event_bridge::ConversationTagChange::Upsert { tag },
        );
    }
    emit_changed(emitter, conversation_id);
    Ok(summary)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn open_tag_suggestion_batch(
    db: tauri::State<'_, AppDatabase>,
    conversation_id: i32,
    batch_id: String,
    lease_token: Option<String>,
) -> Result<TagBatch, AppCommandError> {
    Ok(tag_store::open_batch(
        &db.conn,
        conversation_id,
        &batch_id,
        chrono::Utc::now().timestamp(),
        lease_token.as_deref(),
    )
    .await?)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn close_tag_suggestion_batch(
    db: tauri::State<'_, AppDatabase>,
    conversation_id: i32,
    batch_id: String,
    lease_token: Option<String>,
) -> Result<(), AppCommandError> {
    Ok(tag_store::close_batch(
        &db.conn,
        conversation_id,
        &batch_id,
        chrono::Utc::now().timestamp(),
        lease_token.as_deref(),
    )
    .await?)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn confirm_tag_suggestion_batch(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    conversation_id: i32,
    batch_id: String,
    choices: Vec<TagChoice>,
) -> Result<crate::models::DbConversationSummary, AppCommandError> {
    confirm_tag_suggestion_batch_core(
        &EventEmitter::Tauri(app),
        &db,
        conversation_id,
        &batch_id,
        choices,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn skip_tag_suggestion_batch(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    conversation_id: i32,
    batch_id: String,
) -> Result<(), AppCommandError> {
    tag_store::skip_batch(&db.conn, conversation_id, &batch_id).await?;
    emit_changed(&EventEmitter::Tauri(app), conversation_id);
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn ignore_tag_suggestion(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    conversation_id: i32,
    batch_id: String,
    index: usize,
    tag_id: Option<i32>,
) -> Result<(), AppCommandError> {
    tag_store::ignore_candidate(&db.conn, conversation_id, &batch_id, index, tag_id).await?;
    emit_changed(&EventEmitter::Tauri(app), conversation_id);
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn restore_ignored_tag(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    conversation_id: i32,
    key: String,
) -> Result<(), AppCommandError> {
    tag_store::restore_ignored(&db.conn, conversation_id, &key).await?;
    emit_changed(&EventEmitter::Tauri(app), conversation_id);
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn get_tag_suggestion_status(
    db: tauri::State<'_, AppDatabase>,
    conversation_id: i32,
) -> Result<TagStatus, AppCommandError> {
    get_tag_suggestion_status_core(&db, conversation_id).await
}
