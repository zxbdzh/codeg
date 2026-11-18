use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::side_question::{
    side_question_ask_core, side_question_cancel_core, side_question_capability_core,
};
use crate::side_question::{AskRequest, SideQuestionAnswer};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityRequest {
    source_connection_id: String,
    source_conversation_id: Option<i32>,
    source_agent_type: crate::models::AgentType,
}

pub async fn side_question_capability(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<CapabilityRequest>,
) -> Result<Json<crate::side_question::NativeCapability>, AppCommandError> {
    side_question_capability_core(
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        request.source_connection_id,
        request.source_conversation_id,
        request.source_agent_type,
    )
    .await
    .map(Json)
}

pub async fn side_question_ask(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<AskRequest>,
) -> Result<Json<SideQuestionAnswer>, AppCommandError> {
    let answer = side_question_ask_core(
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        request,
    )
    .await?;
    Ok(Json(answer))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    request_id: String,
}

pub async fn side_question_cancel(
    Json(request): Json<CancelRequest>,
) -> Result<Json<()>, AppCommandError> {
    side_question_cancel_core(&request.request_id)?;
    Ok(Json(()))
}
