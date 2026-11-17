use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::Utc;

use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;

use super::failed;

pub async fn cleanup_expired(
    manager: &ConnectionManager,
    data_dir: &Path,
    now: SystemTime,
) -> Result<usize, AppCommandError> {
    let manager = manager.clone_ref();
    let directory = data_dir.join("conversation-undo");
    let now = chrono::DateTime::<Utc>::from(now);
    tokio::task::spawn_blocking(move || {
        let entries = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(AppCommandError::io(error)),
        };
        let mut removed = 0;
        for entry in entries {
            let entry = entry.map_err(AppCommandError::io)?;
            let path = entry.path();
            let conversation_id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .and_then(|value| value.parse::<i32>().ok())
                .filter(|value| *value > 0);
            if !entry.file_type().map_err(AppCommandError::io)?.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("json")
                || conversation_id.is_none()
            {
                continue;
            }
            let Ok(_backup_guard) = super::operations::backup(&manager, conversation_id.unwrap())
            else {
                continue;
            };
            let file = match std::fs::File::open(&path) {
                Ok(file) => file,
                Err(error) => {
                    tracing::warn!(%error, "could not inspect an Undo backup");
                    continue;
                }
            };
            // 私有清单在正文前写入 expiresAt，仅读元数据前缀，避免反复加载整段历史。
            let mut prefix = Vec::new();
            if let Err(error) = file.take(8192).read_to_end(&mut prefix) {
                tracing::warn!(%error, "could not read an Undo backup expiration");
                continue;
            }
            let prefix = String::from_utf8_lossy(&prefix);
            let header = prefix.split("\"original\":").next().unwrap_or_default();
            let expires_at = header
                .split("\"expiresAt\":\"")
                .nth(1)
                .and_then(|value| value.split('"').next())
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
            if !expires_at.is_some_and(|value| value <= now) {
                continue;
            }
            match std::fs::remove_file(path) {
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => tracing::warn!(%error, "could not remove an expired Undo backup"),
            }
        }
        Ok(removed)
    })
    .await
    .map_err(|error| failed(error.to_string()))?
}

pub async fn cleanup_task(manager: ConnectionManager, data_dir: PathBuf) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    loop {
        interval.tick().await;
        if let Err(error) = cleanup_expired(&manager, &data_dir, SystemTime::now()).await {
            tracing::warn!(%error, "could not clean expired Undo backups");
        }
    }
}
