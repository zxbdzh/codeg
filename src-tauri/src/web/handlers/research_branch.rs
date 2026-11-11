use std::sync::Arc;

use axum::{extract::Extension, Json};

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
