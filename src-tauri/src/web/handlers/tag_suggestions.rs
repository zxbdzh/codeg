use crate::ai::tag_store::{self, TagBatch, TagChoice, TagStatus};
use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use axum::{Extension, Json};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationParams {
    pub conversation_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateParams {
    pub conversation_id: i32,
    #[serde(default)]
    pub force: bool,
}

pub async fn generate_tag_suggestion_batch(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GenerateParams>,
) -> Result<Json<TagStatus>, AppCommandError> {
    Ok(Json(
        crate::commands::tag_suggestions::generate_tag_suggestion_batch_core(
            &state.emitter,
            &state.db,
            &state.connection_manager,
            params.conversation_id,
            params.force,
        )
        .await?,
    ))
}

pub async fn get_tag_suggestion_status(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationParams>,
) -> Result<Json<TagStatus>, AppCommandError> {
    Ok(Json(
        crate::commands::tag_suggestions::get_tag_suggestion_status_core(
            &state.db,
            params.conversation_id,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchParams {
    pub conversation_id: i32,
    pub batch_id: String,
    pub lease_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmParams {
    pub conversation_id: i32,
    pub batch_id: String,
    pub choices: Vec<TagChoice>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreParams {
    pub conversation_id: i32,
    pub batch_id: String,
    pub index: usize,
    pub tag_id: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreParams {
    pub conversation_id: i32,
    pub key: String,
}

pub async fn open_tag_suggestion_batch(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BatchParams>,
) -> Result<Json<TagBatch>, AppCommandError> {
    Ok(Json(
        tag_store::open_batch(
            &state.db.conn,
            params.conversation_id,
            &params.batch_id,
            chrono::Utc::now().timestamp(),
            params.lease_token.as_deref(),
        )
        .await?,
    ))
}
pub async fn close_tag_suggestion_batch(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BatchParams>,
) -> Result<Json<()>, AppCommandError> {
    tag_store::close_batch(
        &state.db.conn,
        params.conversation_id,
        &params.batch_id,
        chrono::Utc::now().timestamp(),
        params.lease_token.as_deref(),
    )
    .await?;
    Ok(Json(()))
}
pub async fn confirm_tag_suggestion_batch(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConfirmParams>,
) -> Result<Json<crate::models::DbConversationSummary>, AppCommandError> {
    Ok(Json(
        crate::commands::tag_suggestions::confirm_tag_suggestion_batch_core(
            &state.emitter,
            &state.db,
            params.conversation_id,
            &params.batch_id,
            params.choices,
        )
        .await?,
    ))
}
pub async fn skip_tag_suggestion_batch(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BatchParams>,
) -> Result<Json<()>, AppCommandError> {
    tag_store::skip_batch(&state.db.conn, params.conversation_id, &params.batch_id).await?;
    crate::commands::tag_suggestions::emit_changed(&state.emitter, params.conversation_id);
    Ok(Json(()))
}
pub async fn ignore_tag_suggestion(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<IgnoreParams>,
) -> Result<Json<()>, AppCommandError> {
    tag_store::ignore_candidate(
        &state.db.conn,
        params.conversation_id,
        &params.batch_id,
        params.index,
        params.tag_id,
    )
    .await?;
    crate::commands::tag_suggestions::emit_changed(&state.emitter, params.conversation_id);
    Ok(Json(()))
}
pub async fn restore_ignored_tag(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RestoreParams>,
) -> Result<Json<()>, AppCommandError> {
    tag_store::restore_ignored(&state.db.conn, params.conversation_id, &params.key).await?;
    crate::commands::tag_suggestions::emit_changed(&state.emitter, params.conversation_id);
    Ok(Json(()))
}
