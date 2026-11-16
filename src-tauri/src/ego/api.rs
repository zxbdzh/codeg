use std::path::{Path, PathBuf};

use sea_orm::EntityTrait;
use serde_json::{json, Value};

use crate::db::{
    entities::{conversation, folder},
    AppDatabase,
};

use super::{EgoConfig, EgoService};

pub async fn project_root(db: &AppDatabase, session_id: i32) -> Result<PathBuf, String> {
    let session = conversation::Entity::find_by_id(session_id)
        .one(&db.conn)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("会话不存在。")?;
    let project = folder::Entity::find_by_id(session.folder_id)
        .one(&db.conn)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("会话项目不存在。")?;
    Ok(PathBuf::from(project.path))
}

async fn inside(root: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let canonical_root = tokio::fs::canonicalize(root)
        .await
        .map_err(|error| error.to_string())?;
    let selected = tokio::fs::canonicalize(candidate)
        .await
        .map_err(|error| error.to_string())?;
    if !selected.starts_with(&canonical_root) {
        return Err("所选文件不属于本会话项目或上传目录。".into());
    }
    Ok(selected)
}

pub async fn command(
    db: &AppDatabase,
    data_dir: &Path,
    mut request: Value,
) -> Result<Value, String> {
    let service = EgoService::shared(data_dir);
    let method = request["method"]
        .as_str()
        .ok_or("缺少 Ego 操作名称。")?
        .to_owned();
    if method == "config" {
        let pixel_display = std::env::var("CODEG_EGO_PIXEL_CODEC")
            .ok()
            .is_some_and(|filename| Path::new(&filename).is_file());
        return Ok(
            json!({"config": service.config().await?, "platform": std::env::consts::OS,
            "pixelDisplay": pixel_display}),
        );
    }
    if method == "configure" {
        let config: EgoConfig =
            serde_json::from_value(request["config"].clone()).map_err(|error| error.to_string())?;
        return service.configure(config).await;
    }
    if !matches!(
        method.as_str(),
        "session"
            | "pixelAck"
            | "rtcOffer"
            | "rtcClose"
            | "human"
            | "return"
            | "restore"
            | "frame"
            | "files"
            | "evalDecision"
            | "downloadData"
            | "visit"
            | "view"
            | "closeView"
    ) {
        return Err("不支持此 Ego 操作。".into());
    }
    let session_id = request["sessionId"]
        .as_i64()
        .and_then(|value| i32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or("请选择已保存的会话。")?;
    let root = project_root(db, session_id).await?;
    if method == "downloadData" {
        use base64::Engine;
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let (filename, name) = download(
            db,
            data_dir,
            session_id,
            request["downloadId"].as_str().ok_or("下载标识无效。")?,
        )
        .await?;
        let offset = request["offset"].as_u64().unwrap_or(0);
        let mut file = tokio::fs::File::open(filename)
            .await
            .map_err(|error| error.to_string())?;
        let size = file
            .metadata()
            .await
            .map_err(|error| error.to_string())?
            .len();
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        file.take(1024 * 1024)
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(
            json!({"name": name, "size": size, "data": base64::engine::general_purpose::STANDARD.encode(bytes)}),
        );
    }
    if method == "files" {
        let root = tokio::fs::canonicalize(&root)
            .await
            .map_err(|error| error.to_string())?;
        let relative = request["directory"].as_str().unwrap_or("");
        let directory = inside(&root, &root.join(relative)).await?;
        let mut entries = tokio::fs::read_dir(&directory)
            .await
            .map_err(|error| error.to_string())?;
        let mut result = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| error.to_string())?
        {
            if result.len() >= 1000 {
                return Err("目录条目超过 1000 个，请选择更具体的项目目录。".into());
            }
            let metadata = entry.file_type().await.map_err(|error| error.to_string())?;
            if metadata.is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
                continue;
            }
            result.push(json!({"name": entry.file_name().to_string_lossy(),
                "path": entry.path().strip_prefix(&root).map_err(|error| error.to_string())?.to_string_lossy(),
                "directory": metadata.is_dir()}));
        }
        return Ok(json!({"entries": result}));
    }
    if method == "human" && request["action"]["kind"] == "files" {
        let selected = request["action"]["files"]
            .as_array()
            .ok_or("文件列表无效。")?;
        if selected.len() > 100 {
            return Err("每次最多选择 100 个文件。".into());
        }
        let mut validated = Vec::new();
        for entry in selected {
            let supplied = entry["path"].as_str().ok_or("文件路径无效。")?;
            if !matches!(entry["source"].as_str(), Some("upload" | "project")) {
                return Err("文件来源无效。".into());
            }
            let allowed = if entry["source"] == "upload" {
                crate::paths::codeg_uploads_root()
            } else {
                root.clone()
            };
            let candidate = if entry["source"] == "upload" {
                PathBuf::from(supplied)
            } else {
                root.join(supplied)
            };
            let filename = inside(&allowed, &candidate).await?;
            if !tokio::fs::metadata(&filename)
                .await
                .map_err(|error| error.to_string())?
                .is_file()
            {
                return Err("只能上传普通文件。".into());
            }
            // Web 只能选择来源和文件；可信根由执行端根据真实会话确定。
            validated.push(json!({"path": filename, "root": allowed}));
        }
        request["action"]["files"] = json!(validated);
    }
    service.request(request).await
}

pub async fn download(
    db: &AppDatabase,
    data_dir: &Path,
    session_id: i32,
    download_id: &str,
) -> Result<(PathBuf, String), String> {
    project_root(db, session_id).await?;
    let result = EgoService::shared(data_dir)
        .request(json!({
            "method": "download", "sessionId": session_id, "downloadId": download_id,
        }))
        .await?;
    let root = data_dir
        .join("ego/sessions/downloads")
        .join(session_id.to_string());
    let selected = inside(
        &root,
        Path::new(result["path"].as_str().ok_or("下载路径不可用。")?),
    )
    .await?;
    Ok((
        selected,
        result["name"].as_str().unwrap_or("download").to_owned(),
    ))
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn ego_browser(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    request: Value,
) -> Result<Value, String> {
    use tauri::Manager;
    let fallback = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    command(
        &db,
        &crate::paths::resolve_effective_data_dir(&fallback),
        request,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn selected_files_cannot_escape_the_session_root() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        tokio::fs::create_dir(&project).await.unwrap();
        tokio::fs::write(project.join("inside.txt"), b"inside")
            .await
            .unwrap();
        tokio::fs::write(directory.path().join("outside.txt"), b"outside")
            .await
            .unwrap();
        assert!(inside(&project, &project.join("inside.txt")).await.is_ok());
        assert!(inside(&project, &project.join("../outside.txt"))
            .await
            .is_err());
        assert!(inside(&project, &directory.path().join("outside.txt"))
            .await
            .is_err());
    }
}
