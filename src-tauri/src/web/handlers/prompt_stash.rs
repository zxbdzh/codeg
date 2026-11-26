//! 输入收藏的 HTTP 适配层：与桌面端共用 `commands::prompt_stash` 的业务实现。

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::prompt_stash::{
    self as stash_commands, SavedStash, StashEntry, StashSnapshot,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveStashParams {
    pub snapshot: StashSnapshot,
    pub scope_key: String,
    pub draft_scope_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListStashParams {
    pub scope_key: Option<String>,
    pub draft_scope_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreStashParams {
    pub id: i32,
    pub scope_key: String,
    pub draft_scope_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveStashParams {
    pub id: i32,
    pub scope_key: Option<String>,
    pub draft_scope_key: Option<String>,
}

pub async fn save_prompt_stash(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SaveStashParams>,
) -> Result<Json<SavedStash>, AppCommandError> {
    Ok(Json(
        stash_commands::save_core(
            &state.db,
            &stash_commands::stash_root(),
            params.snapshot,
            false,
            params.scope_key,
            params.draft_scope_key,
        )
        .await?,
    ))
}

pub async fn list_prompt_stash(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ListStashParams>,
) -> Result<Json<Vec<StashEntry>>, AppCommandError> {
    Ok(Json(
        stash_commands::list_core(&state.db, params.scope_key, params.draft_scope_key).await?,
    ))
}

pub async fn restore_prompt_stash(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RestoreStashParams>,
) -> Result<Json<StashSnapshot>, AppCommandError> {
    Ok(Json(
        stash_commands::restore_core(
            &state.db,
            &stash_commands::stash_root(),
            &crate::paths::codeg_uploads_root(),
            params.id,
            params.scope_key,
            params.draft_scope_key,
        )
        .await?,
    ))
}

pub async fn remove_prompt_stash(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RemoveStashParams>,
) -> Result<Json<()>, AppCommandError> {
    stash_commands::remove_core(
        &state.db,
        &stash_commands::stash_root(),
        params.id,
        params.scope_key,
        params.draft_scope_key,
    )
    .await?;
    Ok(Json(()))
}
