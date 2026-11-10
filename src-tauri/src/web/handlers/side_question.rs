use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::side_question::{
    get_side_question_settings_core, set_side_question_settings_core, side_question_ask_core,
    side_question_cancel_core,
};
use crate::side_question::{AskRequest, SideQuestionAnswer, SideQuestionSettings};

pub async fn get_side_question_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<SideQuestionSettings>, AppCommandError> {
    Ok(Json(get_side_question_settings_core(&state.db).await?))
}

#[derive(Deserialize)]
pub struct SettingsRequest {
    settings: SideQuestionSettings,
}

pub async fn set_side_question_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<SettingsRequest>,
) -> Result<Json<SideQuestionSettings>, AppCommandError> {
    Ok(Json(
        set_side_question_settings_core(&state.db, request.settings).await?,
    ))
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
