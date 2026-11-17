#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn conversation_redo_status(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    conversation_id: i32,
) -> Result<crate::conversation_undo::RedoStatus, crate::app_error::AppCommandError> {
    use tauri::Manager;
    let directory = app.path().app_data_dir().map_err(|error| {
        crate::app_error::AppCommandError::task_execution_failed(error.to_string())
    })?;
    crate::conversation_undo::redo_status(
        &db,
        &manager,
        &crate::paths::resolve_effective_data_dir(&directory),
        crate::conversation_undo::ConversationRequest { conversation_id },
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn conversation_redo_clear(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    conversation_id: i32,
) -> Result<(), crate::app_error::AppCommandError> {
    use tauri::Manager;
    let directory = app.path().app_data_dir().map_err(|error| {
        crate::app_error::AppCommandError::task_execution_failed(error.to_string())
    })?;
    crate::conversation_undo::clear_redo(
        &db,
        &manager,
        &crate::paths::resolve_effective_data_dir(&directory),
        crate::conversation_undo::ConversationRequest { conversation_id },
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn conversation_redo(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    conversation_id: i32,
) -> Result<crate::conversation_undo::UndoResult, crate::app_error::AppCommandError> {
    use tauri::Manager;
    let directory = app.path().app_data_dir().map_err(|error| {
        crate::app_error::AppCommandError::task_execution_failed(error.to_string())
    })?;
    crate::conversation_undo::redo(
        &db,
        &manager,
        &crate::paths::resolve_effective_data_dir(&directory),
        crate::conversation_undo::ConversationRequest { conversation_id },
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn conversation_undo_commit(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    conversation_id: i32,
    source_turn_id: String,
    history_revision: String,
    current_draft: Option<crate::commands::prompt_stash::StashSnapshot>,
    stop_confirmed: Option<bool>,
) -> Result<crate::conversation_undo::CommitResult, crate::app_error::AppCommandError> {
    use tauri::Manager;
    let directory = app.path().app_data_dir().map_err(|error| {
        crate::app_error::AppCommandError::task_execution_failed(error.to_string())
    })?;
    crate::conversation_undo::commit(
        &db,
        &manager,
        &crate::paths::resolve_effective_data_dir(&directory),
        crate::conversation_undo::CommitRequest {
            conversation_id,
            source_turn_id,
            history_revision,
            current_draft,
            stop_confirmed: stop_confirmed.unwrap_or(false),
        },
        true,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn conversation_undo_preview(
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    conversation_id: i32,
    source_turn_id: String,
) -> Result<crate::conversation_undo::UndoPreview, crate::app_error::AppCommandError> {
    crate::conversation_undo::preview(
        &db,
        &manager,
        crate::conversation_undo::PreviewRequest {
            conversation_id,
            source_turn_id,
        },
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn conversation_fork(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    connection_id: String,
    source_conversation_id: i32,
    request_id: String,
    source_turn_id: Option<String>,
    source_prompt: Option<crate::research_branch::PromptSnapshot>,
) -> Result<crate::research_branch::ResearchBranchInfo, crate::app_error::AppCommandError> {
    use tauri::Manager;
    let directory = app.path().app_data_dir().map_err(|error| {
        crate::app_error::AppCommandError::task_execution_failed(error.to_string())
    })?;
    crate::research_branch::create(
        &db,
        &manager,
        &crate::paths::resolve_effective_data_dir(&directory),
        &crate::web::event_bridge::EventEmitter::Tauri(app),
        crate::research_branch::CreateRequest {
            connection_id,
            source_conversation_id,
            request_id,
            source_turn_id,
            source_prompt,
        },
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn conversation_undo(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    conversation_id: i32,
    source_turn_id: String,
    source_prompt: crate::research_branch::PromptSnapshot,
) -> Result<crate::conversation_undo::UndoResult, crate::app_error::AppCommandError> {
    use tauri::Manager;
    let directory = app.path().app_data_dir().map_err(|error| {
        crate::app_error::AppCommandError::task_execution_failed(error.to_string())
    })?;
    crate::conversation_undo::undo(
        &db,
        &manager,
        &crate::paths::resolve_effective_data_dir(&directory),
        crate::conversation_undo::UndoRequest {
            conversation_id,
            source_turn_id,
            source_prompt,
        },
    )
    .await
}
