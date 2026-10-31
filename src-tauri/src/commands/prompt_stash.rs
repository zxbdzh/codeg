//! 收藏的文件生命周期和双模式入口；DB 只存副本元数据，不存图片 base64。
use crate::{
    app_error::AppCommandError,
    db::{service::prompt_stash_service as service, AppDatabase},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashSnapshot {
    pub text: String,
    pub doc: Value,
    #[serde(default)]
    pub attachments: Vec<Value>,
    #[serde(default)]
    pub embedded_payloads: std::collections::BTreeMap<String, Value>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub id: i32,
    pub preview: String,
    pub updated_at: String,
    pub attachment_count: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedStash {
    pub entry: StashEntry,
    pub created: bool,
}

// 文件复制、DB 写入和淘汰共用一把异步锁；避免并发去重把另一请求的副本删掉。
static STASH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const MAX_JSON_BYTES: usize = 16 * 1024 * 1024;

fn entry(row: &crate::db::entities::prompt_stash::Model) -> StashEntry {
    StashEntry {
        id: row.id,
        preview: row.preview.clone(),
        updated_at: row.updated_at.to_rfc3339(),
        attachment_count: serde_json::from_str::<Vec<Value>>(&row.attachments_json)
            .map(|v| v.len())
            .unwrap_or(0),
    }
}
pub async fn list_core(db: &AppDatabase) -> Result<Vec<StashEntry>, AppCommandError> {
    Ok(service::list(&db.conn).await?.iter().map(entry).collect())
}
struct Asset {
    bytes: Vec<u8>,
    original: Option<String>,
}
fn invalid(message: &str) -> AppCommandError {
    AppCommandError::invalid_input(message)
}
fn read_asset(uri: &str) -> Result<Vec<u8>, AppCommandError> {
    use std::io::Read;
    let url = url::Url::parse(uri).map_err(|_| invalid("Invalid attachment URI"))?;
    let path = url
        .to_file_path()
        .map_err(|_| invalid("Only local file attachments can be copied"))?;
    let file = std::fs::File::open(path).map_err(AppCommandError::io)?;
    if !file.metadata().map_err(AppCommandError::io)?.is_file() {
        return Err(invalid("Only regular files can be collected"));
    }
    let mut bytes = Vec::new();
    file.take(service::MAX_ITEM_ASSET_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(AppCommandError::io)?;
    Ok(bytes)
}
fn collect(
    value: &mut Value,
    assets: &mut Vec<Asset>,
    total: &mut usize,
) -> Result<(), AppCommandError> {
    if let Some(object) = value.as_object_mut() {
        if object.contains_key("stashAsset") || object.contains_key("stashPayload") {
            return Err(invalid("Reserved collection metadata"));
        }
        // 只处理真实附件字段；不解析正文里的 URL，也不下载外部地址。
        let uri = object
            .get("uri")
            .and_then(Value::as_str)
            .filter(|u| u.starts_with("file://"))
            .map(str::to_owned);
        let field = if object
            .get("data")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        {
            Some(("data", true))
        } else if object
            .get("blob")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        {
            Some(("blob", true))
        } else if object.get("type").and_then(Value::as_str) == Some("resource")
            && object.get("text").and_then(Value::as_str).is_some()
        {
            Some(("text", false))
        } else {
            None
        };
        let bytes = if let Some((name, encoded)) = field {
            let raw = object[name].as_str().unwrap_or_default();
            if raw.len() > MAX_JSON_BYTES {
                return Err(invalid("Collection attachments exceed 10 MB"));
            }
            Some(if encoded {
                STANDARD
                    .decode(raw)
                    .map_err(|_| invalid("Invalid attachment base64"))?
            } else {
                raw.as_bytes().to_vec()
            })
        } else {
            uri.as_deref().map(read_asset).transpose()?
        };
        if let Some(bytes) = bytes {
            *total += bytes.len();
            if *total > service::MAX_ITEM_ASSET_BYTES as usize {
                return Err(invalid("Collection attachments exceed 10 MB"));
            }
            let index = assets.len();
            assets.push(Asset {
                bytes,
                original: uri,
            });
            if let Some((name, encoded)) = field {
                object.insert(name.into(), Value::String(String::new()));
                object.insert(
                    "stashPayload".into(),
                    json!({"asset":index,"field":name,"encoded":encoded}),
                );
            }
            object.insert("stashAsset".into(), json!(index));
            object.remove("uploading");
        }
        for (key, child) in object.iter_mut() {
            if key != "stashPayload" {
                collect(child, assets, total)?;
            }
        }
    } else if let Some(array) = value.as_array_mut() {
        for child in array {
            collect(child, assets, total)?;
        }
    }
    Ok(())
}
fn rewrite(value: &mut Value, uris: &[String], originals: &[(String, String)]) {
    match value {
        Value::Object(map) => {
            if let Some(index) = map.get("stashAsset").and_then(Value::as_u64) {
                map.insert("uri".into(), json!(uris[index as usize]));
            }
            for child in map.values_mut() {
                rewrite(child, uris, originals);
            }
        }
        Value::Array(array) => {
            for child in array {
                rewrite(child, uris, originals);
            }
        }
        Value::String(s) => {
            if let Some((_, replacement)) = originals.iter().find(|(original, _)| original == s) {
                *s = replacement.clone();
            }
        }
        _ => {}
    }
}
fn hydrate(value: &mut Value, bucket: &Path) -> Result<(), AppCommandError> {
    if let Some(map) = value.as_object_mut() {
        if let Some(payload) = map.remove("stashPayload") {
            let index = payload["asset"]
                .as_u64()
                .ok_or_else(|| invalid("Invalid collection asset"))?;
            let field = payload["field"]
                .as_str()
                .filter(|s| ["data", "blob", "text"].contains(s))
                .ok_or_else(|| invalid("Invalid collection field"))?;
            let bytes =
                std::fs::read(bucket.join(index.to_string())).map_err(AppCommandError::io)?;
            let data = if payload["encoded"].as_bool() == Some(true) {
                STANDARD.encode(bytes)
            } else {
                String::from_utf8(bytes).map_err(|_| invalid("Invalid UTF-8 attachment"))?
            };
            map.insert(field.into(), json!(data));
        }
        map.remove("stashAsset");
        for child in map.values_mut() {
            hydrate(child, bucket)?;
        }
    } else if let Some(array) = value.as_array_mut() {
        for child in array {
            hydrate(child, bucket)?;
        }
    }
    Ok(())
}
fn bucket(root: &Path, fingerprint: &str) -> Result<PathBuf, AppCommandError> {
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("Invalid collection fingerprint"));
    }
    Ok(root.join(fingerprint))
}
pub async fn save_core(
    db: &AppDatabase,
    root: &Path,
    snapshot: StashSnapshot,
) -> Result<SavedStash, AppCommandError> {
    let _guard = STASH_LOCK.lock().await;
    let root = root.to_owned();
    let (snapshot, manifest, total, dir, preexisting) =
        tokio::task::spawn_blocking(move || -> Result<_, AppCommandError> {
            let mut value = serde_json::to_value(snapshot).map_err(|e| invalid(&e.to_string()))?;
            if value.to_string().len() > MAX_JSON_BYTES {
                return Err(invalid("Collection is too large"));
            }
            let mut assets = Vec::new();
            let mut total = 0;
            collect(&mut value, &mut assets, &mut total)?;
            let manifest: Vec<_> = assets
                .iter()
                .map(|a| json!({"sha256":format!("{:x}", Sha256::digest(&a.bytes))}))
                .collect();
            let text = value["text"].as_str().unwrap_or_default();
            if text.trim().is_empty()
                && assets.is_empty()
                && value["doc"]["content"].as_array().is_none_or(Vec::is_empty)
            {
                return Err(invalid("Collection cannot be empty"));
            }
            let manifest = serde_json::to_string(&manifest).map_err(|e| invalid(&e.to_string()))?;
            let fingerprint = service::fingerprint_of(text, &manifest);
            let dir = bucket(&root, &fingerprint)?;
            let preexisting = dir.exists();
            std::fs::create_dir_all(&dir).map_err(AppCommandError::io)?;
            let write_result = (|| {
                let mut uris = Vec::new();
                let mut originals = Vec::new();
                for (index, asset) in assets.iter().enumerate() {
                    let path = dir.join(index.to_string());
                    std::fs::write(&path, &asset.bytes).map_err(AppCommandError::io)?;
                    let uri = url::Url::from_file_path(crate::paths::simplify_verbatim_path(
                        &std::fs::canonicalize(&path).map_err(AppCommandError::io)?,
                    ))
                    .map_err(|_| invalid("Invalid collection path"))?
                    .to_string();
                    if let Some(original) = &asset.original {
                        originals.push((original.clone(), uri.clone()));
                    }
                    uris.push(uri);
                }
                rewrite(&mut value, &uris, &originals);
                serde_json::from_value::<StashSnapshot>(value).map_err(|e| invalid(&e.to_string()))
            })();
            match write_result {
                Ok(snapshot) => Ok((snapshot, manifest, total, dir, preexisting)),
                Err(error) => {
                    if !preexisting {
                        let _ = std::fs::remove_dir_all(&dir);
                    }
                    Err(error)
                }
            }
        })
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))??;
    let outcome = service::save(
        &db.conn,
        service::NewStashItem {
            text: snapshot.text.clone(),
            doc_json: serde_json::to_string(&snapshot).map_err(|e| invalid(&e.to_string()))?,
            attachments_json: manifest,
            asset_bytes: total as i64,
        },
    )
    .await;
    match outcome {
        Ok(outcome) => {
            for row in outcome.evicted {
                if let Ok(path) = bucket(root_parent(&dir), &row.fingerprint) {
                    if let Err(error) = std::fs::remove_dir_all(path) {
                        tracing::warn!(%error, "could not remove evicted collection assets");
                    }
                }
            }
            Ok(SavedStash {
                entry: entry(&outcome.entry),
                created: outcome.created,
            })
        }
        Err(error) => {
            if !preexisting {
                let _ = std::fs::remove_dir_all(&dir);
            }
            Err(AppCommandError::task_execution_failed(error.to_string()))
        }
    }
}
fn root_parent(dir: &Path) -> &Path {
    dir.parent().expect("bucket always has parent")
}
pub async fn restore_core(
    db: &AppDatabase,
    root: &Path,
    id: i32,
) -> Result<StashSnapshot, AppCommandError> {
    let _guard = STASH_LOCK.lock().await;
    let row = service::get(&db.conn, id)
        .await?
        .ok_or_else(|| AppCommandError::not_found("Collection no longer exists"))?;
    let dir = bucket(root, &row.fingerprint)?;
    let snapshot =
        tokio::task::spawn_blocking(move || -> Result<StashSnapshot, AppCommandError> {
            let mut value: Value =
                serde_json::from_str(&row.doc_json).map_err(|e| invalid(&e.to_string()))?;
            hydrate(&mut value, &dir)?;
            serde_json::from_value(value).map_err(|e| invalid(&e.to_string()))
        })
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))??;
    service::touch(&db.conn, id).await?;
    Ok(snapshot)
}
// 放在已有上传 jail 内，恢复的图片才能继续走服务器发送时的安全再内联链路。
pub fn stash_root() -> PathBuf {
    crate::paths::codeg_uploads_root().join("prompt-stash")
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn save_prompt_stash(
    db: tauri::State<'_, AppDatabase>,
    snapshot: StashSnapshot,
) -> Result<SavedStash, AppCommandError> {
    save_core(&db, &stash_root(), snapshot).await
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_prompt_stash(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<StashEntry>, AppCommandError> {
    list_core(&db).await
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn restore_prompt_stash(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<StashSnapshot, AppCommandError> {
    restore_core(&db, &stash_root(), id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    #[tokio::test]
    async fn image_bytes_survive_capture_and_restore_without_deleting_the_template() {
        let db = fresh_in_memory_db().await;
        let temp = tempfile::tempdir().unwrap();
        let snapshot = StashSnapshot {
            text: "模板".into(),
            doc: json!({"type":"doc","content":[]}),
            attachments: vec![
                json!({"id":"random","type":"image","data":"aGVsbG8=","name":"test.png","mimeType":"image/png","uri":null}),
            ],
            embedded_payloads: Default::default(),
        };
        let saved = save_core(&db, temp.path(), snapshot.clone()).await.unwrap();
        assert!(saved.created);
        let restored = restore_core(&db, temp.path(), saved.entry.id)
            .await
            .unwrap();
        assert_eq!(restored.attachments[0]["data"], "aGVsbG8=");
        assert_eq!(restored.text, "模板");
        assert_eq!(list_core(&db).await.unwrap().len(), 1);
        let duplicate = save_core(&db, temp.path(), snapshot).await.unwrap();
        assert!(!duplicate.created);
        assert_eq!(duplicate.entry.id, saved.entry.id);
    }
}
