use std::path::Path;

use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::side_question::{self, AskRequest, SideQuestionAnswer};

pub async fn side_question_ask_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    request: AskRequest,
) -> Result<SideQuestionAnswer, AppCommandError> {
    side_question::ask(db, manager, data_dir, request).await
}

pub fn side_question_cancel_core(request_id: &str) -> Result<(), AppCommandError> {
    side_question::cancel(request_id)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn side_question_ask(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    request_id: String,
    question: String,
    selection: Option<String>,
    context: Option<Vec<crate::side_question::ContextEntry>>,
    attachments: Option<Vec<crate::side_question::Attachment>>,
    source_connection_id: Option<String>,
    source_conversation_id: Option<i32>,
    source_agent_type: Option<crate::models::AgentType>,
) -> Result<SideQuestionAnswer, AppCommandError> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|path| crate::paths::resolve_effective_data_dir(&path))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let finished = finished.clone();
        let request_id = request_id.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed)
                && !finished.load(std::sync::atomic::Ordering::SeqCst)
            {
                let _ = side_question_cancel_core(&request_id);
            }
        });
    }
    let result = side_question_ask_core(
        &db,
        &manager,
        &data_dir,
        AskRequest {
            request_id,
            question,
            selection,
            context: context.unwrap_or_default(),
            attachments: attachments.unwrap_or_default(),
            source_connection_id,
            source_conversation_id,
            source_agent_type,
        },
    )
    .await;
    finished.store(true, std::sync::atomic::Ordering::SeqCst);
    result
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn side_question_cancel(request_id: String) -> Result<(), AppCommandError> {
    side_question_cancel_core(&request_id)
}
