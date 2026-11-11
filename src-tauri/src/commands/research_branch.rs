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
