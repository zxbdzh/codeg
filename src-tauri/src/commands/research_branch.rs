use std::path::Path;

use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;
use crate::db::service::research_branch_service;
use crate::db::AppDatabase;
use crate::research_branch::{self, CreateRequest, ResearchBranchInfo, SummaryAnswer};
use crate::web::event_bridge::EventEmitter;

pub async fn research_branch_create_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    emitter: &EventEmitter,
    request: CreateRequest,
) -> Result<ResearchBranchInfo, AppCommandError> {
    research_branch::create(db, manager, data_dir, emitter, request).await
}

pub async fn research_branch_list_core(
    db: &AppDatabase,
    conversation_id: i32,
) -> Result<Vec<ResearchBranchInfo>, AppCommandError> {
    research_branch_service::list(&db.conn, conversation_id)
        .await
        .map_err(research_branch::db_error)
}

pub async fn research_branch_save_summary_core(
    db: &AppDatabase,
    branch_conversation_id: i32,
    summary: String,
) -> Result<ResearchBranchInfo, AppCommandError> {
    research_branch_service::save_summary(&db.conn, branch_conversation_id, summary)
        .await
        .map_err(research_branch::db_error)
}

pub async fn research_branch_generate_summary_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    branch_conversation_id: i32,
    request_id: String,
) -> Result<SummaryAnswer, AppCommandError> {
    research_branch::generate_summary(db, manager, data_dir, branch_conversation_id, request_id)
        .await
}

#[cfg(feature = "tauri-runtime")]
fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppCommandError> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|path| crate::paths::resolve_effective_data_dir(&path))
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn research_branch_create(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    connection_id: String,
    source_conversation_id: i32,
    request_id: String,
) -> Result<ResearchBranchInfo, AppCommandError> {
    let emitter = EventEmitter::Tauri(app.clone());
    research_branch_create_core(
        &db,
        &manager,
        &data_dir(&app)?,
        &emitter,
        CreateRequest {
            connection_id,
            source_conversation_id,
            request_id,
        },
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn research_branch_list(
    db: tauri::State<'_, AppDatabase>,
    conversation_id: i32,
) -> Result<Vec<ResearchBranchInfo>, AppCommandError> {
    research_branch_list_core(&db, conversation_id).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn research_branch_save_summary(
    db: tauri::State<'_, AppDatabase>,
    branch_conversation_id: i32,
    summary: String,
) -> Result<ResearchBranchInfo, AppCommandError> {
    research_branch_save_summary_core(&db, branch_conversation_id, summary).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn research_branch_generate_summary(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    branch_conversation_id: i32,
    request_id: String,
) -> Result<SummaryAnswer, AppCommandError> {
    let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let finished_event = finished.clone();
    let cancel_id = request_id.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed)
            && !finished_event.load(std::sync::atomic::Ordering::SeqCst)
        {
            let _ = crate::side_question::cancel(&cancel_id);
        }
    });
    let result = research_branch_generate_summary_core(
        &db,
        &manager,
        &data_dir(&app)?,
        branch_conversation_id,
        request_id,
    )
    .await;
    finished.store(true, std::sync::atomic::Ordering::SeqCst);
    result
}
