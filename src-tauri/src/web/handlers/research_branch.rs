use std::sync::Arc;

use axum::{extract::Extension, Json};

pub async fn conversation_redo_status(
    Extension(state): Extension<Arc<crate::app_state::AppState>>,
    Json(request): Json<crate::conversation_undo::ConversationRequest>,
) -> Result<Json<crate::conversation_undo::RedoStatus>, crate::app_error::AppCommandError> {
    crate::conversation_undo::redo_status(
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        request,
    )
    .await
    .map(Json)
}

pub async fn conversation_redo_clear(
    Extension(state): Extension<Arc<crate::app_state::AppState>>,
    Json(request): Json<crate::conversation_undo::ConversationRequest>,
) -> Result<Json<()>, crate::app_error::AppCommandError> {
    crate::conversation_undo::clear_redo(
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        request,
    )
    .await
    .map(Json)
}

pub async fn conversation_redo(
    Extension(state): Extension<Arc<crate::app_state::AppState>>,
    Json(request): Json<crate::conversation_undo::ConversationRequest>,
) -> Result<Json<crate::conversation_undo::UndoResult>, crate::app_error::AppCommandError> {
    crate::conversation_undo::redo(
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        request,
    )
    .await
    .map(Json)
}

pub async fn conversation_undo_commit(
    Extension(state): Extension<Arc<crate::app_state::AppState>>,
    Json(request): Json<crate::conversation_undo::CommitRequest>,
) -> Result<Json<crate::conversation_undo::CommitResult>, crate::app_error::AppCommandError> {
    crate::conversation_undo::commit(
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        request,
        false,
    )
    .await
    .map(Json)
}

pub async fn conversation_undo_preview(
    Extension(state): Extension<Arc<crate::app_state::AppState>>,
    Json(request): Json<crate::conversation_undo::PreviewRequest>,
) -> Result<Json<crate::conversation_undo::UndoPreview>, crate::app_error::AppCommandError> {
    crate::conversation_undo::preview(&state.db, &state.connection_manager, request)
        .await
        .map(Json)
}

pub async fn conversation_undo(
    Extension(state): Extension<Arc<crate::app_state::AppState>>,
    Json(request): Json<crate::conversation_undo::UndoRequest>,
) -> Result<Json<crate::conversation_undo::UndoResult>, crate::app_error::AppCommandError> {
    crate::conversation_undo::undo(
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        request,
    )
    .await
    .map(Json)
}

pub async fn conversation_fork(
    Extension(state): Extension<Arc<crate::app_state::AppState>>,
    Json(request): Json<crate::research_branch::CreateRequest>,
) -> Result<Json<crate::research_branch::ResearchBranchInfo>, crate::app_error::AppCommandError> {
    crate::research_branch::create(
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        &state.emitter,
        request,
    )
    .await
    .map(Json)
}
