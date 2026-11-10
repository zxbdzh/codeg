use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::file_checkpoint::{Request, Response};
use axum::{extract::Extension, Json};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    request: Request,
}

pub async fn file_checkpoint(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<Params>,
) -> Result<Json<Response>, AppCommandError> {
    crate::file_checkpoint::run(
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        params.request,
    )
    .await
    .map(Json)
}
