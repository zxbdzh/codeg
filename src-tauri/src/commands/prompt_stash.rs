//! 收藏的文件生命周期和双模式入口；DB 只存副本元数据，不存图片 base64。
use crate::db::entities::{conversation, folder, prompt_stash};
use crate::{
    app_error::AppCommandError,
    db::{service::prompt_stash_service as service, AppDatabase},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
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
    pub scope_key: Option<String>,
    pub conversation_id: Option<i32>,
    pub conversation_title: Option<String>,
    pub conversation_status: Option<conversation::ConversationStatus>,
    pub conversation_deleted: bool,
    pub folder_name: Option<String>,
    pub asset_bytes: i64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedStash {
    pub entry: StashEntry,
    pub created: bool,
}

// 文件复制、DB 写入和淘汰共用一把异步锁；避免并发去重把另一请求的副本删掉。
static STASH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
pub const STASH_BODY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const MAX_JSON_BYTES: usize = STASH_BODY_LIMIT_BYTES;

fn to_stash_entry(row: &crate::db::entities::prompt_stash::Model) -> StashEntry {
    StashEntry {
        id: row.id,
        scope_key: row.scope_key.clone(),
        conversation_id: row.scope_key.as_deref().and_then(conversation_id),
        conversation_title: None,
        conversation_status: None,
        conversation_deleted: false,
        folder_name: None,
        asset_bytes: row.asset_bytes,
        preview: row.preview.clone(),
        updated_at: row.updated_at.to_rfc3339(),
        attachment_count: serde_json::from_str::<Vec<Value>>(&row.attachments_json)
            .map(|v| v.len())
            .unwrap_or(0),
    }
}
fn conversation_id(scope: &str) -> Option<i32> {
    scope
        .strip_prefix("conv:")?
        .parse::<i32>()
        .ok()
        .filter(|id| *id > 0)
}

fn is_draft_scope(scope: &str) -> bool {
    ["draft:", "canvas-draft:"].iter().any(|prefix| {
        scope
            .strip_prefix(prefix)
            .is_some_and(|suffix| !suffix.is_empty())
    })
}

// 新对话发送前用稳定草稿标识隔离，创建数据库会话后接续到 conv:<id>。
// 旧版 NULL 记录不猜测归属，不进入任何输入框列表。
async fn prepare_scope(
    db: &AppDatabase,
    scope: &str,
    draft_scope: Option<&str>,
) -> Result<(), AppCommandError> {
    if scope.len() > 512 || scope.chars().any(char::is_control) {
        return Err(invalid("Invalid collection conversation scope"));
    }
    let id = conversation_id(scope);
    if let Some(id) = id {
        let exists = conversation::Entity::find_by_id(id)
            .filter(conversation::Column::DeletedAt.is_null())
            .one(&db.conn)
            .await
            .map_err(crate::db::error::DbError::from)?;
        if scope != format!("conv:{id}") || exists.is_none() {
            return Err(invalid("Collection conversation no longer exists"));
        }
    } else if !is_draft_scope(scope) {
        return Err(invalid("A conversation is required for collected input"));
    }
    if let Some(from) = draft_scope.filter(|from| *from != scope) {
        if id.is_none()
            || !is_draft_scope(from)
            || from.len() > 512
            || from.chars().any(char::is_control)
        {
            return Err(invalid("Invalid collection draft handover"));
        }
        let rows = prompt_stash::Entity::find()
            .filter(prompt_stash::Column::ScopeKey.eq(from))
            .all(&db.conn)
            .await
            .map_err(crate::db::error::DbError::from)?;
        for row in rows {
            let existing = prompt_stash::Entity::find()
                .filter(prompt_stash::Column::ScopeKey.eq(scope))
                .filter(prompt_stash::Column::Fingerprint.eq(row.fingerprint.clone()))
                .one(&db.conn)
                .await
                .map_err(crate::db::error::DbError::from)?;
            if let Some(existing) = existing {
                // 相同正文/附件已经存在目标对话：只合并时间，磁盘副本仍有引用。
                if row.updated_at > existing.updated_at {
                    let mut active: prompt_stash::ActiveModel = existing.into();
                    active.updated_at = Set(row.updated_at);
                    active
                        .update(&db.conn)
                        .await
                        .map_err(crate::db::error::DbError::from)?;
                }
                service::remove(&db.conn, row.id).await?;
            } else {
                let mut active: prompt_stash::ActiveModel = row.into();
                active.scope_key = Set(Some(scope.to_owned()));
                active
                    .update(&db.conn)
                    .await
                    .map_err(crate::db::error::DbError::from)?;
            }
        }
    }
    Ok(())
}

pub async fn list_core(
    db: &AppDatabase,
    scope_key: Option<String>,
    draft_scope_key: Option<String>,
) -> Result<Vec<StashEntry>, AppCommandError> {
    let _guard = STASH_LOCK.lock().await;
    if let Some(scope) = &scope_key {
        prepare_scope(db, scope, draft_scope_key.as_deref()).await?;
    }
    let rows = if let Some(scope) = &scope_key {
        service::list_scope(&db.conn, scope).await?
    } else {
        service::list(&db.conn).await?
    };
    let ids: Vec<i32> = rows
        .iter()
        .filter_map(|row| row.scope_key.as_deref().and_then(conversation_id))
        .collect();
    let conversations = conversation::Entity::find()
        .filter(conversation::Column::Id.is_in(ids))
        .all(&db.conn)
        .await
        .map_err(crate::db::error::DbError::from)?;
    let folder_ids: Vec<i32> = conversations.iter().map(|row| row.folder_id).collect();
    let folders = folder::Entity::find()
        .filter(folder::Column::Id.is_in(folder_ids))
        .all(&db.conn)
        .await
        .map_err(crate::db::error::DbError::from)?;
    Ok(rows
        .iter()
        .map(|row| {
            let mut entry = to_stash_entry(row);
            if let Some(id) = entry.conversation_id {
                if let Some(conv) = conversations.iter().find(|conv| conv.id == id) {
                    entry.conversation_title = conv.title.clone();
                    entry.conversation_status = Some(conv.status.clone());
                    entry.conversation_deleted = conv.deleted_at.is_some();
                    entry.folder_name = folders
                        .iter()
                        .find(|folder| folder.id == conv.folder_id)
                        .map(|folder| folder.name.clone());
                } else {
                    entry.conversation_deleted = true;
                }
            }
            entry
        })
        .collect())
}

// 内容指纹仍是附件目录名。不同对话可保存同内容，最后一个引用删除才清磁盘。
async fn cleanup_assets(
    db: &AppDatabase,
    root: &Path,
    fingerprint: &str,
) -> Result<(), AppCommandError> {
    if prompt_stash::Entity::find()
        .filter(prompt_stash::Column::Fingerprint.eq(fingerprint))
        .one(&db.conn)
        .await
        .map_err(crate::db::error::DbError::from)?
        .is_none()
    {
        let dir = bucket(root, fingerprint)?;
        if dir.is_dir() {
            if let Err(error) = std::fs::remove_dir_all(dir) {
                tracing::warn!(%error, "could not remove collection assets");
            }
        }
    }
    Ok(())
}
struct Asset {
    bytes: Vec<u8>,
    original: Option<String>,
}
fn invalid(message: &str) -> AppCommandError {
    AppCommandError::invalid_input(message)
}
fn read_asset(
    uri: &str,
    uploads_root: &Path,
    allow_local_paths: bool,
) -> Result<Vec<u8>, AppCommandError> {
    use std::io::Read;
    let url = url::Url::parse(uri).map_err(|_| invalid("Invalid attachment URI"))?;
    let path = url
        .to_file_path()
        .map_err(|_| invalid("Only local file attachments can be copied"))?;
    if !allow_local_paths {
        let canonical = std::fs::canonicalize(&path).map_err(AppCommandError::io)?;
        let uploads = std::fs::canonicalize(uploads_root).map_err(AppCommandError::io)?;
        if !canonical.starts_with(&uploads) {
            return Err(invalid("Only uploaded attachments can be collected"));
        }
    }
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
    uploads_root: &Path,
    allow_local_paths: bool,
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
            uri.as_deref()
                .map(|uri| read_asset(uri, uploads_root, allow_local_paths))
                .transpose()?
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
                collect(child, assets, total, uploads_root, allow_local_paths)?;
            }
        }
    } else if let Some(array) = value.as_array_mut() {
        for child in array {
            collect(child, assets, total, uploads_root, allow_local_paths)?;
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
    allow_local_paths: bool,
    scope_key: String,
    draft_scope_key: Option<String>,
) -> Result<SavedStash, AppCommandError> {
    let _guard = STASH_LOCK.lock().await;
    prepare_scope(db, &scope_key, draft_scope_key.as_deref()).await?;
    let root = root.to_owned();
    let uploads_root = crate::paths::codeg_uploads_root();
    let (snapshot, manifest, total, dir, preexisting) =
        tokio::task::spawn_blocking(move || -> Result<_, AppCommandError> {
            let mut value = serde_json::to_value(snapshot).map_err(|e| invalid(&e.to_string()))?;
            if value.to_string().len() > MAX_JSON_BYTES {
                return Err(invalid("Collection is too large"));
            }
            let mut assets = Vec::new();
            let mut total = 0;
            collect(
                &mut value,
                &mut assets,
                &mut total,
                &uploads_root,
                allow_local_paths,
            )?;
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
            scope_key: Some(scope_key),
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
                cleanup_assets(db, root_parent(&dir), &row.fingerprint).await?;
            }
            Ok(SavedStash {
                entry: to_stash_entry(&outcome.entry),
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
fn file_uri(path: &Path) -> Result<String, AppCommandError> {
    let canonical = std::fs::canonicalize(path).map_err(AppCommandError::io)?;
    url::Url::from_file_path(crate::paths::simplify_verbatim_path(&canonical))
        .map(|url| url.to_string())
        .map_err(|_| invalid("Invalid collection path"))
}
/// 按“旧地址→新地址”精确替换文档里的附件地址。精确匹配而非前缀拼接，
/// 因为收藏目录与恢复目录的规范路径形态可能不同（Windows 的 `\\?\` 前缀）。
fn replace_asset_uris(value: &mut Value, pairs: &[(String, String)]) {
    match value {
        Value::Object(map) => {
            for child in map.values_mut() {
                replace_asset_uris(child, pairs);
            }
        }
        Value::Array(items) => {
            for child in items {
                replace_asset_uris(child, pairs);
            }
        }
        Value::String(text) => {
            if let Some((_, replacement)) = pairs.iter().find(|(old, _)| old == text) {
                *text = replacement.clone();
            }
        }
        _ => {}
    }
}
pub async fn restore_core(
    db: &AppDatabase,
    root: &Path,
    uploads_root: &Path,
    id: i32,
    scope_key: String,
    draft_scope_key: Option<String>,
) -> Result<StashSnapshot, AppCommandError> {
    let _guard = STASH_LOCK.lock().await;
    prepare_scope(db, &scope_key, draft_scope_key.as_deref()).await?;
    let row = service::get(&db.conn, id)
        .await?
        .filter(|row| row.scope_key.as_deref() == Some(scope_key.as_str()))
        .ok_or_else(|| {
            AppCommandError::not_found("Collection no longer exists in this conversation")
        })?;
    let dir = bucket(root, &row.fingerprint)?;
    let asset_count = serde_json::from_str::<Vec<Value>>(&row.attachments_json)
        .map(|manifest| manifest.len())
        .unwrap_or(0);
    let uploads_root = uploads_root.to_owned();
    let snapshot =
        tokio::task::spawn_blocking(move || -> Result<StashSnapshot, AppCommandError> {
            let mut value: Value =
                serde_json::from_str(&row.doc_json).map_err(|e| invalid(&e.to_string()))?;
            hydrate(&mut value, &dir)?;
            // 把附件**复制**到上传 jail 的独立目录并改写地址：恢复后前端持有
            // 的 uri 必须长期有效（发送时按 uri 再内联）。这里不移动源文件，
            // 所以“输入框非空、放弃恢复”之后仍可原样再取一次。
            if asset_count > 0 && dir.is_dir() {
                let target = uploads_root
                    .join(RESTORED_DIR_NAME)
                    .join(uuid::Uuid::new_v4().to_string());
                std::fs::create_dir_all(&target).map_err(AppCommandError::io)?;
                let mut pairs = Vec::new();
                for index in 0..asset_count {
                    let source = dir.join(index.to_string());
                    if !source.is_file() {
                        continue;
                    }
                    let destination = target.join(index.to_string());
                    std::fs::copy(&source, &destination).map_err(AppCommandError::io)?;
                    pairs.push((file_uri(&source)?, file_uri(&destination)?));
                }
                replace_asset_uris(&mut value, &pairs);
            }
            serde_json::from_value(value).map_err(|e| invalid(&e.to_string()))
        })
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))??;
    service::touch(&db.conn, id).await?;
    Ok(snapshot)
}
/// 删除一条收藏及其附件目录。恢复成功后前端会调用它，实现“取走即消失”。
pub async fn remove_core(
    db: &AppDatabase,
    root: &Path,
    id: i32,
    scope_key: Option<String>,
    draft_scope_key: Option<String>,
) -> Result<(), AppCommandError> {
    let _guard = STASH_LOCK.lock().await;
    if let Some(scope) = &scope_key {
        prepare_scope(db, scope, draft_scope_key.as_deref()).await?;
        if service::get(&db.conn, id)
            .await?
            .is_some_and(|row| row.scope_key.as_ref() != Some(scope))
        {
            return Err(AppCommandError::not_found(
                "Collection does not belong to this conversation",
            ));
        }
    }
    let Some(row) = service::remove(&db.conn, id).await? else {
        return Ok(());
    };
    cleanup_assets(db, root, &row.fingerprint).await?;
    Ok(())
}
// 放在上传目录下的独立位置：恢复后的附件必须能被服务器发送链路再次内联。
pub fn stash_root() -> PathBuf {
    crate::paths::codeg_home_dir().join("prompt-stash")
}
/// 恢复出来的附件副本目录名（在 `codeg_uploads_root()` 下）。
pub const RESTORED_DIR_NAME: &str = "prompt-stash-restored";

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn save_prompt_stash(
    db: tauri::State<'_, AppDatabase>,
    snapshot: StashSnapshot,
    scope_key: String,
    draft_scope_key: Option<String>,
) -> Result<SavedStash, AppCommandError> {
    save_core(
        &db,
        &stash_root(),
        snapshot,
        true,
        scope_key,
        draft_scope_key,
    )
    .await
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn list_prompt_stash(
    db: tauri::State<'_, AppDatabase>,
    scope_key: Option<String>,
    draft_scope_key: Option<String>,
) -> Result<Vec<StashEntry>, AppCommandError> {
    list_core(&db, scope_key, draft_scope_key).await
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn restore_prompt_stash(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    scope_key: String,
    draft_scope_key: Option<String>,
) -> Result<StashSnapshot, AppCommandError> {
    restore_core(
        &db,
        &stash_root(),
        &crate::paths::codeg_uploads_root(),
        id,
        scope_key,
        draft_scope_key,
    )
    .await
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn remove_prompt_stash(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    scope_key: Option<String>,
    draft_scope_key: Option<String>,
) -> Result<(), AppCommandError> {
    remove_core(&db, &stash_root(), id, scope_key, draft_scope_key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    fn snapshot() -> StashSnapshot {
        StashSnapshot {
            text: "同一份待办".into(),
            doc: json!({"type":"doc","content":[]}),
            attachments: vec![json!({"type":"image","data":"aGVsbG8=","mimeType":"image/png"})],
            embedded_payloads: Default::default(),
        }
    }

    #[tokio::test]
    async fn conversations_deduplicate_and_restore_only_their_own_entries() {
        let db = fresh_in_memory_db().await;
        let stash = tempfile::tempdir().unwrap();
        let uploads = tempfile::tempdir().unwrap();
        let a = save_core(&db, stash.path(), snapshot(), true, "draft:a".into(), None)
            .await
            .unwrap();
        let b = save_core(&db, stash.path(), snapshot(), true, "draft:b".into(), None)
            .await
            .unwrap();
        assert_ne!(a.entry.id, b.entry.id);
        assert!(
            !save_core(&db, stash.path(), snapshot(), true, "draft:a".into(), None)
                .await
                .unwrap()
                .created
        );
        let own = list_core(&db, Some("draft:a".into()), None).await.unwrap();
        assert_eq!(own.len(), 1);
        assert_eq!(own[0].id, a.entry.id);
        assert!(restore_core(
            &db,
            stash.path(),
            uploads.path(),
            a.entry.id,
            "draft:b".into(),
            None
        )
        .await
        .is_err());
        assert!(
            remove_core(&db, stash.path(), a.entry.id, Some("draft:b".into()), None)
                .await
                .is_err()
        );

        // 两个对话可以引用同内容附件；删掉其中一个不能破坏另一份收藏。
        remove_core(&db, stash.path(), a.entry.id, Some("draft:a".into()), None)
            .await
            .unwrap();
        let restored = restore_core(
            &db,
            stash.path(),
            uploads.path(),
            b.entry.id,
            "draft:b".into(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(restored.attachments[0]["data"], "aGVsbG8=");
        remove_core(&db, stash.path(), b.entry.id, None, None)
            .await
            .unwrap();
        assert!(list_core(&db, None, None).await.unwrap().is_empty());
        assert_eq!(std::fs::read_dir(stash.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn legacy_entries_are_manageable_but_never_returned_to_an_unrelated_conversation() {
        let db = fresh_in_memory_db().await;
        let stash = tempfile::tempdir().unwrap();
        let legacy = service::save(
            &db.conn,
            service::NewStashItem {
                scope_key: None,
                text: "升级前的收藏".into(),
                doc_json: serde_json::to_string(&snapshot()).unwrap(),
                attachments_json: "[]".into(),
                asset_bytes: 0,
            },
        )
        .await
        .unwrap();
        assert!(list_core(&db, Some("draft:new".into()), None)
            .await
            .unwrap()
            .is_empty());
        let managed = list_core(&db, None, None).await.unwrap();
        assert_eq!(managed.len(), 1);
        assert!(managed[0].scope_key.is_none());
        remove_core(&db, stash.path(), legacy.entry.id, None, None)
            .await
            .unwrap();
        assert!(list_core(&db, None, None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_bound_draft_follows_its_conversation_and_merges_identical_entries() {
        use crate::db::test_helpers::{seed_conversation, seed_folder};
        let db = fresh_in_memory_db().await;
        let stash = tempfile::tempdir().unwrap();
        let folder_id = seed_folder(&db, "/stash-project").await;
        let id = seed_conversation(&db, folder_id, crate::models::AgentType::ClaudeCode).await;
        let scope = format!("conv:{id}");
        let mut conv: conversation::ActiveModel = conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap()
            .into();
        conv.title = Set(Some("已完成的开发".into()));
        conv.status = Set(conversation::ConversationStatus::Completed);
        conv.update(&db.conn).await.unwrap();
        save_core(
            &db,
            stash.path(),
            snapshot(),
            true,
            "draft:tab-a".into(),
            None,
        )
        .await
        .unwrap();
        let target = save_core(&db, stash.path(), snapshot(), true, scope.clone(), None)
            .await
            .unwrap();
        let merged = list_core(&db, Some(scope), Some("draft:tab-a".into()))
            .await
            .unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].id, target.entry.id);
        assert_eq!(merged[0].conversation_id, Some(id));
        assert_eq!(
            merged[0].conversation_title.as_deref(),
            Some("已完成的开发")
        );
        assert_eq!(
            merged[0].conversation_status,
            Some(conversation::ConversationStatus::Completed)
        );
        assert!(merged[0].folder_name.is_some());
        assert!(list_core(&db, Some("draft:tab-a".into()), None)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn empty_scope_is_rejected_instead_of_saving_globally() {
        let db = fresh_in_memory_db().await;
        let stash = tempfile::tempdir().unwrap();
        assert!(
            save_core(&db, stash.path(), snapshot(), true, "".into(), None)
                .await
                .is_err()
        );
        assert!(list_core(&db, Some("".into()), None).await.is_err());
        assert!(list_core(&db, None, None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn restoring_hands_out_durable_attachment_copies_and_removal_clears_the_template() {
        let db = fresh_in_memory_db().await;
        let stash = tempfile::tempdir().unwrap();
        let uploads = tempfile::tempdir().unwrap();
        let snapshot = StashSnapshot {
            text: "模板".into(),
            doc: json!({"type":"doc","content":[]}),
            attachments: vec![
                json!({"id":"random","type":"image","data":"aGVsbG8=","name":"test.png","mimeType":"image/png","uri":null}),
            ],
            embedded_payloads: Default::default(),
        };
        let saved = save_core(
            &db,
            stash.path(),
            snapshot.clone(),
            true,
            "draft:test".into(),
            None,
        )
        .await
        .unwrap();
        assert!(saved.created);

        let restored = restore_core(
            &db,
            stash.path(),
            uploads.path(),
            saved.entry.id,
            "draft:test".into(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(restored.attachments[0]["data"], "aGVsbG8=");
        assert_eq!(restored.text, "模板");
        // 恢复后 uri 必须指向上传目录里的副本，删除收藏目录也不影响它。
        let uri = restored.attachments[0]["uri"].as_str().unwrap();
        assert!(
            uri.contains(RESTORED_DIR_NAME),
            "restored uri should live under the uploads jail: {uri}"
        );
        // 恢复本身不删除：放弃恢复时模板还在，可以再取一次。
        assert_eq!(list_core(&db, None, None).await.unwrap().len(), 1);

        remove_core(
            &db,
            stash.path(),
            saved.entry.id,
            Some("draft:test".into()),
            None,
        )
        .await
        .unwrap();
        assert!(list_core(&db, None, None).await.unwrap().is_empty());
        // 取走后再收藏同样内容是一条新收藏。
        let again = save_core(&db, stash.path(), snapshot, true, "draft:test".into(), None)
            .await
            .unwrap();
        assert!(again.created);
    }
}
