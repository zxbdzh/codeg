#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn file_checkpoint(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
    request: crate::file_checkpoint::Request,
) -> Result<crate::file_checkpoint::Response, crate::app_error::AppCommandError> {
    use tauri::Manager;
    let directory = app.path().app_data_dir().map_err(|error| {
        crate::app_error::AppCommandError::task_execution_failed(error.to_string())
    })?;
    crate::file_checkpoint::run(
        &db,
        &manager,
        &crate::paths::resolve_effective_data_dir(&directory),
        request,
    )
    .await
}
