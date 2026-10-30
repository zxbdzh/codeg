//! HTTP 适配层不持有业务状态，所有行为与桌面端共用命令层。
use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::ai::output::TagSuggestion;
use crate::ai::settings::{AiAssistantSettings, AiAvailability};
use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::ai_assistant::{self as commands, NewTagRequest};
use crate::models::DbConversationSummary;

pub async fn get_ai_assistant_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<AiAssistantSettings>, AppCommandError> {
    Ok(Json(
        commands::get_ai_assistant_settings_core(&state.db).await?,
    ))
}

#[derive(Deserialize)]
pub struct UpdateSettingsParams {
    pub settings: AiAssistantSettings,
}

pub async fn update_ai_assistant_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateSettingsParams>,
) -> Result<Json<AiAssistantSettings>, AppCommandError> {
    Ok(Json(
        commands::update_ai_assistant_settings_core(&state.db, params.settings).await?,
    ))
}

pub async fn get_ai_assistant_availability(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<AiAvailability>, AppCommandError> {
    Ok(Json(
        commands::get_ai_assistant_availability_core(&state.db).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationParams {
    pub conversation_id: i32,
}

pub async fn suggest_conversation_tags(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationParams>,
) -> Result<Json<TagSuggestion>, AppCommandError> {
    Ok(Json(
        commands::suggest_conversation_tags_core(&state.db, params.conversation_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyTagsParams {
    pub conversation_id: i32,
    #[serde(default)]
    pub existing_tag_ids: Vec<i32>,
    #[serde(default)]
    pub new_tags: Vec<NewTagRequest>,
}

pub async fn apply_suggested_tags(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ApplyTagsParams>,
) -> Result<Json<DbConversationSummary>, AppCommandError> {
    Ok(Json(
        commands::apply_suggested_tags_core(
            &state.emitter,
            &state.db,
            params.conversation_id,
            params.existing_tag_ids,
            params.new_tags,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateTitleParams {
    pub conversation_id: i32,
    #[serde(default)]
    pub force: bool,
}

pub async fn generate_conversation_title(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GenerateTitleParams>,
) -> Result<Json<Option<String>>, AppCommandError> {
    Ok(Json(
        commands::generate_conversation_title_core(
            &state.emitter,
            &state.db,
            params.conversation_id,
            params.force,
        )
        .await?,
    ))
}

pub async fn test_ai_assistant_connection(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<()>, AppCommandError> {
    commands::test_saved_ai_assistant_connection_core(&state.db).await?;
    Ok(Json(()))
}
