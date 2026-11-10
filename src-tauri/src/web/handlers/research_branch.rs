use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::research_branch::{
    research_branch_create_core, research_branch_generate_summary_core, research_branch_list_core,
    research_branch_save_summary_core,
};
use crate::research_branch::{CreateRequest, ResearchBranchInfo, SummaryAnswer};

pub async fn research_branch_create(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<CreateRequest>,
) -> Result<Json<ResearchBranchInfo>, AppCommandError> {
    Ok(Json(
        research_branch_create_core(
            &state.db,
            &state.connection_manager,
            &state.data_dir,
            &state.emitter,
            request,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListRequest {
    conversation_id: i32,
}

pub async fn research_branch_list(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<ListRequest>,
) -> Result<Json<Vec<ResearchBranchInfo>>, AppCommandError> {
    Ok(Json(
        research_branch_list_core(&state.db, request.conversation_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRequest {
    branch_conversation_id: i32,
    summary: String,
}

pub async fn research_branch_save_summary(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<SaveRequest>,
) -> Result<Json<ResearchBranchInfo>, AppCommandError> {
    Ok(Json(
        research_branch_save_summary_core(
            &state.db,
            request.branch_conversation_id,
            request.summary,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateRequest {
    branch_conversation_id: i32,
    request_id: String,
}

pub async fn research_branch_generate_summary(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<GenerateRequest>,
) -> Result<Json<SummaryAnswer>, AppCommandError> {
    Ok(Json(
        research_branch_generate_summary_core(
            &state.db,
            &state.connection_manager,
            &state.data_dir,
            request.branch_conversation_id,
            request.request_id,
        )
        .await?,
    ))
}
