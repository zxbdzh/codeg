//! Axum handlers mirroring `commands::pet`. The window management commands
//! (open/close) are not exposed here — they are pure Tauri operations and
//! have no equivalent in standalone-server mode.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::pet as pet_commands;
use crate::commands::pet::{
    PetCodexImportAvailability, PetIdParams, PetReplaceSpriteParams, PetSetActiveParams,
    PetUpdateMetaParams,
};
use crate::db::entities::conversation;
use crate::models::pet::{
    ImportCodexPetsRequest, ImportCodexPetsResult, ImportablePet, NewPetInput, PetCelebrationKind,
    PetDetail, PetSessionsPayload, PetSpriteAsset, PetState, PetSummary, PetWindowConfig,
    PetWindowStatePatch,
};
use crate::pets::marketplace::{
    MarketplaceInstallRequest, MarketplaceInstallResponse, MarketplaceListParams,
    MarketplaceListResponse,
};

pub async fn pet_list() -> Result<Json<Vec<PetSummary>>, AppCommandError> {
    pet_commands::pet_list_core().await.map(Json)
}

pub async fn pet_get(Json(params): Json<PetIdParams>) -> Result<Json<PetDetail>, AppCommandError> {
    pet_commands::pet_get_core(params.id).await.map(Json)
}

pub async fn pet_read_spritesheet(
    Json(params): Json<PetIdParams>,
) -> Result<Json<PetSpriteAsset>, AppCommandError> {
    pet_commands::pet_read_spritesheet_core(params.id)
        .await
        .map(Json)
}

pub async fn pet_add(Json(input): Json<NewPetInput>) -> Result<Json<PetSummary>, AppCommandError> {
    pet_commands::pet_add_core(input).await.map(Json)
}

pub async fn pet_update_meta(
    Json(params): Json<PetUpdateMetaParams>,
) -> Result<Json<PetSummary>, AppCommandError> {
    pet_commands::pet_update_meta_core(params.id, params.patch)
        .await
        .map(Json)
}

pub async fn pet_replace_sprite(
    Json(params): Json<PetReplaceSpriteParams>,
) -> Result<Json<()>, AppCommandError> {
    pet_commands::pet_replace_sprite_core(params.id, params.spritesheet_base64)
        .await
        .map(Json)
}

pub async fn pet_delete(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PetIdParams>,
) -> Result<Json<()>, AppCommandError> {
    pet_commands::pet_delete_core(&state.db.conn, params.id)
        .await
        .map(Json)
}

pub async fn pet_list_importable_codex() -> Result<Json<Vec<ImportablePet>>, AppCommandError> {
    pet_commands::pet_list_importable_codex_core()
        .await
        .map(Json)
}

pub async fn pet_import_codex(
    Json(request): Json<ImportCodexPetsRequest>,
) -> Result<Json<ImportCodexPetsResult>, AppCommandError> {
    pet_commands::pet_import_codex_core(request).await.map(Json)
}

pub async fn pet_codex_import_available(
) -> Result<Json<PetCodexImportAvailability>, AppCommandError> {
    pet_commands::pet_codex_import_available_core()
        .await
        .map(Json)
}

pub async fn pet_get_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<PetWindowConfig>, AppCommandError> {
    pet_commands::pet_get_settings_core(&state.db.conn)
        .await
        .map(Json)
}

pub async fn pet_set_active(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PetSetActiveParams>,
) -> Result<Json<PetWindowConfig>, AppCommandError> {
    pet_commands::pet_set_active_core(&state.db.conn, &state.emitter, params.pet_id)
        .await
        .map(Json)
}

pub async fn pet_save_window_state(
    Extension(state): Extension<Arc<AppState>>,
    Json(patch): Json<PetWindowStatePatch>,
) -> Result<Json<PetWindowConfig>, AppCommandError> {
    pet_commands::pet_save_window_state_core(&state.db.conn, patch)
        .await
        .map(Json)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCelebrateParams {
    pub kind: PetCelebrationKind,
}

pub async fn pet_celebrate(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PetCelebrateParams>,
) -> Result<Json<()>, AppCommandError> {
    pet_commands::pet_celebrate_core(&state.emitter, params.kind);
    Ok(Json(()))
}

pub async fn pet_marketplace_list(
    Json(params): Json<MarketplaceListParams>,
) -> Result<Json<MarketplaceListResponse>, AppCommandError> {
    pet_commands::pet_marketplace_list_core(params)
        .await
        .map(Json)
}

pub async fn pet_marketplace_install(
    Json(request): Json<MarketplaceInstallRequest>,
) -> Result<Json<MarketplaceInstallResponse>, AppCommandError> {
    pet_commands::pet_marketplace_install_core(request)
        .await
        .map(Json)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetAssetParams {
    pub url: String,
}

pub async fn pet_marketplace_asset(
    Json(params): Json<PetAssetParams>,
) -> Result<Json<PetSpriteAsset>, AppCommandError> {
    pet_commands::pet_marketplace_asset_core(params.url)
        .await
        .map(Json)
}

pub async fn pet_get_current_state(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<PetState>, AppCommandError> {
    Ok(Json(pet_commands::pet_get_current_state_core(
        &state.pet_state,
    )))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSessionsWithCompletions {
    #[serde(flatten)]
    sessions: PetSessionsPayload,
    completed_count: usize,
}

pub async fn pet_list_active_sessions(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<PetSessionsWithCompletions>, AppCommandError> {
    let sessions =
        pet_commands::pet_list_active_sessions_core(&state.connection_manager, &state.db.conn)
            .await?;
    let completions = state.acp_event_bus.recent_completed_conversations();
    let completed_count = if completions.is_empty() {
        0
    } else {
        // 完成和运行采用相同的主会话口径，不能把委派子任务再次计入总数。
        let roots: std::collections::HashSet<_> = conversation::Entity::find()
            .filter(conversation::Column::Id.is_in(completions.iter().copied()))
            .filter(conversation::Column::ParentId.is_null())
            .filter(conversation::Column::DeletedAt.is_null())
            .all(&state.db.conn)
            .await
            .map_err(crate::db::error::DbError::from)?
            .into_iter()
            .map(|entry| entry.id)
            .collect();
        completions.iter().filter(|id| roots.contains(id)).count()
    };
    Ok(Json(PetSessionsWithCompletions {
        sessions,
        completed_count,
    }))
}

#[cfg(test)]
mod sentinel_tests {
    use super::*;
    use crate::acp::delegation::spawner::DelegationLink;
    use crate::acp::types::AcpEvent;
    use crate::db::service::conversation_service;
    use crate::db::test_helpers;
    use crate::models::agent::AgentType;
    use crate::web::event_bridge::emit_with_state;

    async fn complete(state: &AppState, connection_id: &str, stop_reason: &str) {
        let session = state
            .connection_manager
            .get_state(connection_id)
            .await
            .expect("session");
        session.write().await.turn_in_flight = true;
        emit_with_state(
            &session,
            &state.emitter,
            AcpEvent::TurnComplete {
                session_id: connection_id.into(),
                stop_reason: stop_reason.into(),
                agent_type: "codex".into(),
            },
        )
        .await;
    }

    #[tokio::test]
    async fn sentinel_counts_successful_root_turns_and_deduplicates_completion_events() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/sentinel").await;
        let root = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::Codex,
            Some("Root".into()),
            None,
        )
        .await
        .expect("root");
        let child = conversation_service::create_with_delegation(
            &db.conn,
            folder_id,
            AgentType::Codex,
            Some("Child".into()),
            None,
            Some(DelegationLink {
                parent_conversation_id: root.id,
                parent_tool_use_id: "tool".into(),
                delegation_call_id: "call".into(),
                assistant: None,
            }),
        )
        .await
        .expect("child");
        let data_dir = tempfile::tempdir().expect("data dir");
        let state = Arc::new(AppState::new_for_test(db, data_dir.path().into()));
        for (connection_id, conversation_id) in [("root", root.id), ("child", child.id)] {
            state
                .connection_manager
                .insert_test_connection(
                    connection_id,
                    AgentType::Codex,
                    None,
                    state.emitter.clone(),
                )
                .await;
            let session = state
                .connection_manager
                .get_state(connection_id)
                .await
                .expect("session");
            let mut session = session.write().await;
            session.conversation_id = Some(conversation_id);
            session.folder_id = Some(folder_id);
        }

        complete(&state, "root", "end_turn").await;
        let root_session = state
            .connection_manager
            .get_state("root")
            .await
            .expect("root session");
        emit_with_state(
            &root_session,
            &state.emitter,
            AcpEvent::TurnComplete {
                session_id: "root".into(),
                stop_reason: "end_turn".into(),
                agent_type: "codex".into(),
            },
        )
        .await;
        complete(&state, "root", "cancelled").await;
        complete(&state, "root", "max_tokens").await;
        complete(&state, "child", "end_turn").await;

        let Json(first) = pet_list_active_sessions(Extension(state.clone()))
            .await
            .expect("first snapshot");
        assert_eq!(first.completed_count, 1);
        let first_json = serde_json::to_value(first).expect("JSON");
        assert_eq!(first_json["completedCount"], 1);
        assert!(first_json["runningCount"].is_number());
        assert!(first_json["waitingCount"].is_number());
        assert!(first_json["sessions"].is_array());

        complete(&state, "root", "end_turn").await;
        let Json(second) = pet_list_active_sessions(Extension(state))
            .await
            .expect("second snapshot");
        assert_eq!(second.completed_count, 2);
    }
}
