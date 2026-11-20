use std::sync::Arc;

use axum::{Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::tag_curation::{tag_curation_core, Request, Response};

#[derive(Deserialize)]
pub struct Params {
    request: Request,
}

pub async fn tag_curation(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<Params>,
) -> Result<Json<Response>, AppCommandError> {
    Ok(Json(
        tag_curation_core(&state.emitter, &state.db, params.request).await?,
    ))
}
