use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait};
use serde::{Deserialize, Serialize};

use crate::db::error::DbError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCandidate {
    #[serde(default)]
    pub index: usize,
    pub name: String,
    pub reason: String,
    pub color: String,
    pub folder_id: Option<i32>,
    pub tag_ids: Vec<i32>,
}

impl TagCandidate {
    pub fn new_tag(name: &str, folder_id: Option<i32>, reason: &str) -> Self {
        Self {
            index: 0,
            name: name.into(),
            reason: reason.into(),
            color: "#0969da".into(),
            folder_id,
            tag_ids: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagBatch {
    pub id: String,
    pub conversation_id: i32,
    pub input: String,
    pub config: String,
    pub candidates: Vec<TagCandidate>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_token: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagStatus {
    pub batch: Option<TagBatch>,
    pub ignored: Vec<IgnoredTag>,
    pub running: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoredTag {
    pub key: String,
    pub tag_id: Option<i32>,
    pub name: String,
    pub folder_id: Option<i32>,
}

fn candidate_key(name: &str, folder_id: Option<i32>) -> String {
    format!(
        "name:{}:{}",
        folder_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| "global".into()),
        name.trim().to_lowercase()
    )
}

pub fn tag_is_ignored(
    ignored: &[IgnoredTag],
    tag_id: i32,
    name: &str,
    folder_id: Option<i32>,
) -> bool {
    ignored
        .iter()
        .any(|item| item.tag_id == Some(tag_id) || item.key == candidate_key(name, folder_id))
}

pub async fn list_ignored<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
) -> Result<Vec<IgnoredTag>, DbError> {
    let rows = conn.query_all(Statement::from_sql_and_values(DbBackend::Sqlite, "SELECT identity, tag_id, name, folder_id FROM ai_tag_ignored WHERE conversation_id = ? ORDER BY name, identity", vec![conversation_id.into()])).await?;
    rows.into_iter()
        .map(|row| {
            Ok(IgnoredTag {
                key: row.try_get("", "identity")?,
                tag_id: row.try_get("", "tag_id")?,
                name: row.try_get("", "name")?,
                folder_id: row.try_get("", "folder_id")?,
            })
        })
        .collect()
}

pub async fn record_ignored<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
    tag_id: Option<i32>,
    name: &str,
    folder_id: Option<i32>,
) -> Result<(), DbError> {
    let key = tag_id
        .map(|id| format!("tag:{id}"))
        .unwrap_or_else(|| candidate_key(name, folder_id));
    conn.execute(Statement::from_sql_and_values(DbBackend::Sqlite, "INSERT INTO ai_tag_ignored(conversation_id, identity, tag_id, name, folder_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(conversation_id, identity) DO NOTHING", vec![conversation_id.into(), key.into(), tag_id.into(), name.into(), folder_id.into()])).await?;
    Ok(())
}

pub async fn bind_created_tag<C: ConnectionTrait>(
    conn: &C,
    tag_id: i32,
    name: &str,
    folder_id: Option<i32>,
) -> Result<(), DbError> {
    let name_key = candidate_key(name, folder_id);
    let identity = format!("tag:{tag_id}");
    // 正式创建后转为 ID 身份：以后改名不能让同一标签重新绕过用户的忽略。
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "INSERT INTO ai_tag_ignored(conversation_id, identity, tag_id, name, folder_id) SELECT conversation_id, ?, ?, ?, ? FROM ai_tag_ignored WHERE identity = ? AND tag_id IS NULL ON CONFLICT(conversation_id, identity) DO NOTHING",
        vec![identity.into(), tag_id.into(), name.into(), folder_id.into(), name_key.clone().into()],
    )).await?;
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "DELETE FROM ai_tag_ignored WHERE identity = ? AND tag_id IS NULL",
        vec![name_key.into()],
    ))
    .await?;
    Ok(())
}

pub async fn restore_ignored<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
    key: &str,
) -> Result<(), DbError> {
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "DELETE FROM ai_tag_ignored WHERE conversation_id = ? AND identity = ?",
        vec![conversation_id.into(), key.into()],
    ))
    .await?;
    Ok(())
}

pub async fn ignore_candidate(
    conn: &DatabaseConnection,
    conversation_id: i32,
    id: &str,
    index: usize,
    tag_id: Option<i32>,
) -> Result<(), DbError> {
    let txn = conn.begin().await?;
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET processed = processed WHERE id = ?",
        vec![id.into()],
    ))
    .await?;
    let (batch, _) = get_batch(&txn, conversation_id, id).await?;
    let candidate = batch
        .candidates
        .iter()
        .find(|candidate| candidate.index == index)
        .ok_or_else(|| DbError::Validation("candidate index".into()))?;
    let selected = tag_id.or_else(|| (candidate.tag_ids.len() == 1).then(|| candidate.tag_ids[0]));
    if !candidate.tag_ids.is_empty()
        && !selected.is_some_and(|selected| candidate.tag_ids.contains(&selected))
    {
        return Err(DbError::Validation("choose a tag scope".into()));
    }
    let folder_id = if let Some(selected) = selected {
        let row = txn
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "SELECT folder_id FROM conversation_tag WHERE id = ?",
                vec![selected.into()],
            ))
            .await?
            .ok_or_else(|| DbError::NotFound("tag".into()))?;
        row.try_get("", "folder_id")?
    } else {
        candidate.folder_id
    };
    record_ignored(&txn, conversation_id, selected, &candidate.name, folder_id).await?;
    txn.commit().await?;
    Ok(())
}

pub async fn filter_candidates<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
    candidates: Vec<TagCandidate>,
) -> Result<Vec<TagCandidate>, DbError> {
    let ignored = list_ignored(conn, conversation_id).await?;
    let mut filtered = Vec::new();
    for mut candidate in candidates {
        if candidate.tag_ids.is_empty() {
            if ignored
                .iter()
                .any(|item| item.key == candidate_key(&candidate.name, candidate.folder_id))
            {
                continue;
            }
            // 候选后来成为正式标签时，仍按同名同作用域延续忽略与已贴判断。
            let found = conn.query_one(Statement::from_sql_and_values(DbBackend::Sqlite, "SELECT id FROM conversation_tag WHERE lower(name) = lower(?) AND folder_id IS ?", vec![candidate.name.clone().into(), candidate.folder_id.into()])).await?;
            if let Some(row) = found {
                candidate.tag_ids.push(row.try_get("", "id")?);
            }
        }
        let was_existing = !candidate.tag_ids.is_empty();
        let mut keep = Vec::new();
        for tag_id in &candidate.tag_ids {
            let row = conn
                .query_one(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    "SELECT name, folder_id FROM conversation_tag WHERE id = ?",
                    vec![(*tag_id).into()],
                ))
                .await?;
            let Some(row) = row else {
                continue;
            };
            let name: String = row.try_get("", "name")?;
            let folder_id: Option<i32> = row.try_get("", "folder_id")?;
            if ignored.iter().any(|item| {
                item.tag_id == Some(*tag_id) || item.key == candidate_key(&name, folder_id)
            }) {
                continue;
            }
            let attached = conn.query_one(Statement::from_sql_and_values(DbBackend::Sqlite, "SELECT tag_id FROM conversation_tag_link WHERE conversation_id = ? AND tag_id = ?", vec![conversation_id.into(), (*tag_id).into()])).await?.is_some();
            if !attached {
                keep.push(*tag_id);
            }
        }
        candidate.tag_ids = keep;
        if was_existing && candidate.tag_ids.is_empty() {
            continue;
        }
        filtered.push(candidate);
        if filtered.len() == 5 {
            break;
        }
    }
    Ok(filtered)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagChoice {
    pub index: usize,
    pub tag_id: Option<i32>,
    pub name: Option<String>,
    pub color: Option<String>,
    pub folder_id: Option<i32>,
}

impl TagChoice {
    pub fn candidate(index: usize) -> Self {
        Self {
            index,
            tag_id: None,
            name: None,
            color: None,
            folder_id: None,
        }
    }
}

pub async fn get_batch<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
    id: &str,
) -> Result<(TagBatch, bool), DbError> {
    let row = conn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT payload, processed FROM ai_tag_batch WHERE id = ? AND conversation_id = ?",
            vec![id.into(), conversation_id.into()],
        ))
        .await?
        .ok_or_else(|| DbError::NotFound("suggestion batch".into()))?;
    let payload: String = row.try_get("", "payload")?;
    let processed: i32 = row.try_get("", "processed")?;
    let batch =
        serde_json::from_str(&payload).map_err(|error| DbError::Validation(error.to_string()))?;
    Ok((batch, processed != 0))
}

pub async fn open_batch(
    conn: &DatabaseConnection,
    conversation_id: i32,
    id: &str,
    now: i64,
    lease_token: Option<&str>,
) -> Result<TagBatch, DbError> {
    let txn = conn.begin().await?;
    let changed = txn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET leased_until = leased_until WHERE conversation_id = ? AND id = ? AND processed = 0 AND EXISTS (SELECT 1 FROM conversation WHERE id = ? AND deleted_at IS NULL)",
        vec![conversation_id.into(), id.into(), conversation_id.into()],
    )).await?;
    if changed.rows_affected() == 0 {
        return Err(DbError::NotFound("pending suggestion batch".into()));
    }
    let row = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT leases, is_current FROM ai_tag_batch WHERE conversation_id = ? AND id = ?",
            vec![conversation_id.into(), id.into()],
        ))
        .await?
        .ok_or_else(|| DbError::NotFound("suggestion batch".into()))?;
    let encoded: String = row.try_get("", "leases")?;
    let mut leases: std::collections::BTreeMap<String, i64> =
        serde_json::from_str(&encoded).map_err(|error| DbError::Validation(error.to_string()))?;
    leases.retain(|_, until| *until > now);
    let current: i32 = row.try_get("", "is_current")?;
    let token = if let Some(token) = lease_token {
        if !leases.contains_key(token) {
            return Err(DbError::NotFound("review lease expired".into()));
        }
        token.to_string()
    } else {
        if current == 0 && leases.is_empty() {
            return Err(DbError::NotFound("suggestion batch expired".into()));
        }
        if leases.len() >= 64 {
            return Err(DbError::Conflict("too many active review windows".into()));
        }
        uuid::Uuid::new_v4().to_string()
    };
    leases.insert(token.clone(), now.saturating_add(1800));
    let until = leases.values().max().copied();
    let encoded =
        serde_json::to_string(&leases).map_err(|error| DbError::Validation(error.to_string()))?;
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET leases = ?, leased_until = ? WHERE conversation_id = ? AND id = ?",
        vec![
            encoded.into(),
            until.into(),
            conversation_id.into(),
            id.into(),
        ],
    ))
    .await?;
    let (mut batch, _) = get_batch(&txn, conversation_id, id).await?;
    batch.candidates = filter_candidates(&txn, conversation_id, batch.candidates).await?;
    batch.lease_token = Some(token);
    txn.commit().await?;
    Ok(batch)
}

pub async fn close_batch(
    conn: &DatabaseConnection,
    conversation_id: i32,
    id: &str,
    now: i64,
    lease_token: Option<&str>,
) -> Result<(), DbError> {
    // 无凭据的旧客户端只能等待到期，不能释放另一个窗口持有的快照。
    let Some(token) = lease_token else {
        return Ok(());
    };
    let txn = conn.begin().await?;
    let changed = txn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET leased_until = leased_until WHERE conversation_id = ? AND id = ?",
        vec![conversation_id.into(), id.into()],
    )).await?;
    if changed.rows_affected() == 0 {
        txn.commit().await?;
        return Ok(());
    }
    let row = txn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT leases FROM ai_tag_batch WHERE conversation_id = ? AND id = ?",
            vec![conversation_id.into(), id.into()],
        ))
        .await?
        .ok_or_else(|| DbError::NotFound("suggestion batch".into()))?;
    let encoded: String = row.try_get("", "leases")?;
    let mut leases: std::collections::BTreeMap<String, i64> =
        serde_json::from_str(&encoded).map_err(|error| DbError::Validation(error.to_string()))?;
    leases.retain(|key, until| key != token && *until > now);
    let until = leases.values().max().copied();
    let encoded =
        serde_json::to_string(&leases).map_err(|error| DbError::Validation(error.to_string()))?;
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET leases = ?, leased_until = ? WHERE conversation_id = ? AND id = ?",
        vec![
            encoded.into(),
            until.into(),
            conversation_id.into(),
            id.into(),
        ],
    ))
    .await?;
    txn.commit().await?;
    Ok(())
}

pub async fn cleanup_batches<C: ConnectionTrait>(conn: &C, now: i64) -> Result<(), DbError> {
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET leases = '{}', leased_until = NULL WHERE leased_until <= ?",
        vec![now.into()],
    ))
    .await?;
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "DELETE FROM ai_tag_batch WHERE is_current = 0 AND processed = 0 AND leased_until IS NULL",
        Vec::<sea_orm::Value>::new(),
    ))
    .await?;
    // 保留最小幂等凭据，不长期保存已处理的候选及理由，也不动仍有窗口持有的快照。
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET payload = json_set(payload, '$.candidates', json('[]'), '$.input', '', '$.config', '') WHERE processed = 1 AND leased_until IS NULL AND json_array_length(payload, '$.candidates') > 0",
        Vec::<sea_orm::Value>::new(),
    )).await?;
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "DELETE FROM ai_tag_batch WHERE processed = 1 AND is_current = 0 AND leased_until IS NULL AND created_at < ?",
        vec![now.saturating_sub(30 * 24 * 60 * 60).into()],
    )).await?;
    Ok(())
}

pub async fn skip_batch<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
    id: &str,
) -> Result<(), DbError> {
    get_batch(conn, conversation_id, id).await?;
    conn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET processed = 1 WHERE conversation_id = ? AND id = ?",
        vec![conversation_id.into(), id.into()],
    ))
    .await?;
    Ok(())
}

pub async fn confirm_batch(
    conn: &DatabaseConnection,
    conversation_id: i32,
    id: &str,
    choices: Vec<TagChoice>,
) -> Result<(), DbError> {
    use crate::db::service::conversation_tag_service::{self, TagSource};
    let txn = conn.begin().await?;
    // 先获得写锁，避免读完候选后因另一窗口写入而无法升级 SQLite 事务。
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET processed = processed WHERE id = ? AND conversation_id = ?",
        vec![id.into(), conversation_id.into()],
    ))
    .await?;
    let (batch, processed) = get_batch(&txn, conversation_id, id).await?;
    if processed {
        txn.commit().await?;
        return Ok(());
    }
    if choices.len() > 5 {
        return Err(DbError::Validation("at most five tags".into()));
    }
    let mut add = Vec::new();
    for choice in choices {
        let candidate = batch
            .candidates
            .iter()
            .find(|candidate| candidate.index == choice.index)
            .ok_or_else(|| DbError::Validation("candidate index".into()))?;
        let current = filter_candidates(&txn, conversation_id, vec![candidate.clone()]).await?;
        if current.is_empty() {
            return Err(DbError::Validation(
                "candidate is no longer available".into(),
            ));
        }
        let tag_id = if candidate.tag_ids.is_empty() {
            conversation_tag_service::create_tag(
                &txn,
                choice.folder_id.or(candidate.folder_id),
                choice.name.as_deref().unwrap_or(&candidate.name),
                choice.color.as_deref().unwrap_or(&candidate.color),
            )
            .await
            .map_err(|error| DbError::Validation(error.to_string()))?
            .id
        } else {
            let selected = choice
                .tag_id
                .or_else(|| (candidate.tag_ids.len() == 1).then_some(candidate.tag_ids[0]))
                .ok_or_else(|| DbError::Validation("choose a tag scope".into()))?;
            if !candidate.tag_ids.contains(&selected) || !current[0].tag_ids.contains(&selected) {
                return Err(DbError::Validation(
                    "the selected tag is no longer available".into(),
                ));
            }
            selected
        };
        add.push(tag_id);
    }
    conversation_tag_service::update_conversation_tags_with_source(
        &txn,
        conversation_id,
        &add,
        &[],
        TagSource::Ai,
    )
    .await
    .map_err(|error| DbError::Validation(error.to_string()))?;
    // 仅处理指定批次；更新的候选不能被一次旧窗口提交清空。
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET processed = 1 WHERE id = ? AND conversation_id = ?",
        vec![id.into(), conversation_id.into()],
    ))
    .await?;
    txn.commit().await?;
    Ok(())
}

pub async fn save_batch<C: ConnectionTrait + TransactionTrait>(
    conn: &C,
    conversation_id: i32,
    input: &str,
    config: &str,
    candidates: Vec<TagCandidate>,
    now: i64,
) -> Result<TagBatch, DbError> {
    let txn = conn.begin().await?;
    let alive = txn
        .execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "UPDATE conversation SET id = id WHERE id = ? AND deleted_at IS NULL",
            vec![conversation_id.into()],
        ))
        .await?;
    if alive.rows_affected() == 0 {
        return Err(DbError::NotFound("conversation".into()));
    }
    let candidates = candidates
        .into_iter()
        .take(5)
        .enumerate()
        .map(|(index, mut candidate)| {
            candidate.index = index;
            candidate
        })
        .collect();
    let batch = TagBatch {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id,
        input: input.into(),
        config: config.into(),
        candidates,
        created_at: now,
        lease_token: None,
    };
    let payload =
        serde_json::to_string(&batch).map_err(|error| DbError::Validation(error.to_string()))?;
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "UPDATE ai_tag_batch SET is_current = 0 WHERE conversation_id = ?",
        vec![conversation_id.into()],
    ))
    .await?;
    txn.execute(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        "INSERT INTO ai_tag_batch(id, conversation_id, payload, created_at) VALUES (?, ?, ?, ?)",
        vec![
            batch.id.clone().into(),
            conversation_id.into(),
            payload.into(),
            now.into(),
        ],
    ))
    .await?;
    txn.commit().await?;
    Ok(batch)
}

pub async fn read_status<C: ConnectionTrait>(
    conn: &C,
    conversation_id: i32,
) -> Result<TagStatus, DbError> {
    let row = conn.query_one(Statement::from_sql_and_values(DbBackend::Sqlite, "SELECT payload FROM ai_tag_batch WHERE conversation_id = ? AND processed = 0 AND is_current = 1", vec![conversation_id.into()])).await?;
    let mut batch: Option<TagBatch> = row
        .map(|row| {
            let payload: String = row.try_get("", "payload")?;
            serde_json::from_str(&payload).map_err(|error| DbError::Validation(error.to_string()))
        })
        .transpose()?;
    if let Some(current) = &mut batch {
        current.candidates =
            filter_candidates(conn, conversation_id, current.candidates.clone()).await?;
        if current.candidates.is_empty() {
            batch = None;
        }
    }
    let job = conn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT lease_until, error FROM ai_tag_job WHERE conversation_id = ?",
            vec![conversation_id.into()],
        ))
        .await?;
    let mut running = false;
    let mut error = None;
    if let Some(job) = job {
        let until: Option<i64> = job.try_get("", "lease_until")?;
        running = until.is_some_and(|until| until > chrono::Utc::now().timestamp());
        error = job.try_get("", "error")?;
    }
    Ok(TagStatus {
        batch,
        ignored: list_ignored(conn, conversation_id).await?,
        running,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::agent::AgentType;

    #[tokio::test]
    async fn cleanup_discards_processed_candidate_payloads_but_keeps_confirmation_idempotent() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "F:/tag-processed-receipt").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let first = save_batch(
            &db.conn,
            conversation,
            "one",
            "v1",
            vec![TagCandidate::new_tag(
                "MCP",
                None,
                "A reason that should not remain after review",
            )],
            1000,
        )
        .await
        .unwrap();
        let mut opened = open_batch(&db.conn, conversation, &first.id, 1001, None)
            .await
            .unwrap();
        confirm_batch(
            &db.conn,
            conversation,
            &first.id,
            vec![TagChoice::candidate(0)],
        )
        .await
        .unwrap();
        close_batch(
            &db.conn,
            conversation,
            &first.id,
            1002,
            opened.lease_token.take().as_deref(),
        )
        .await
        .unwrap();
        let latest = save_batch(
            &db.conn,
            conversation,
            "two",
            "v1",
            vec![TagCandidate::new_tag("Avatar", None, "topic")],
            1010,
        )
        .await
        .unwrap();
        cleanup_batches(&db.conn, 1011).await.unwrap();
        let (receipt, processed) = get_batch(&db.conn, conversation, &first.id).await.unwrap();
        assert!(processed);
        assert!(receipt.candidates.is_empty());
        confirm_batch(
            &db.conn,
            conversation,
            &first.id,
            vec![TagChoice::candidate(0)],
        )
        .await
        .unwrap();
        assert_eq!(
            crate::db::service::conversation_service::get_by_id(&db.conn, conversation)
                .await
                .unwrap()
                .tag_ids
                .len(),
            1
        );
        assert_eq!(
            read_status(&db.conn, conversation)
                .await
                .unwrap()
                .batch
                .unwrap()
                .id,
            latest.id
        );
    }

    #[tokio::test]
    async fn an_ignored_proposal_stays_ignored_after_creation_and_rename_without_affecting_other_scopes(
    ) {
        use crate::db::service::conversation_tag_service as tags;
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "F:/tag-ignore-identity").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let proposal = save_batch(
            &db.conn,
            conversation,
            "one",
            "v1",
            vec![TagCandidate::new_tag("MCP", None, "topic")],
            1000,
        )
        .await
        .unwrap();
        ignore_candidate(&db.conn, conversation, &proposal.id, 0, None)
            .await
            .unwrap();
        let global = tags::create_tag(&db.conn, None, "MCP", "#123456")
            .await
            .unwrap();
        let local = tags::create_tag(&db.conn, Some(folder), "MCP", "#123456")
            .await
            .unwrap();
        tags::update_tag(&db.conn, global.id, Some("Renamed protocol"), None)
            .await
            .unwrap();
        let mut renamed = TagCandidate::new_tag("Renamed protocol", None, "topic");
        renamed.tag_ids = vec![global.id];
        let mut local_candidate = TagCandidate::new_tag("MCP", Some(folder), "topic");
        local_candidate.tag_ids = vec![local.id];
        save_batch(
            &db.conn,
            conversation,
            "two",
            "v1",
            vec![renamed, local_candidate],
            2000,
        )
        .await
        .unwrap();
        let status = read_status(&db.conn, conversation).await.unwrap();
        let candidates = status.batch.unwrap().candidates;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].tag_ids, vec![local.id]);
        assert_eq!(status.ignored[0].tag_id, Some(global.id));
        assert_eq!(status.ignored[0].name, "Renamed protocol");
        restore_ignored(&db.conn, conversation, &status.ignored[0].key)
            .await
            .unwrap();
        assert_eq!(
            read_status(&db.conn, conversation)
                .await
                .unwrap()
                .batch
                .unwrap()
                .candidates
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn deleting_a_tag_definition_removes_its_identity_based_ignore() {
        use crate::db::service::conversation_tag_service as tags;
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "F:/tag-delete-ignored").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let tag = tags::create_tag(&db.conn, None, "MCP", "#123456").await.unwrap();
        record_ignored(&db.conn, conversation, Some(tag.id), &tag.name, tag.folder_id).await.unwrap();
        assert!(tags::delete_tag(&db.conn, tag.id).await.unwrap());
        assert!(list_ignored(&db.conn, conversation).await.unwrap().is_empty());
        assert_eq!(tags::create_tag(&db.conn, None, "MCP", "#123456").await.unwrap().name, "MCP");
    }

    #[tokio::test]
    async fn confirming_a_now_ignored_choice_rolls_back_new_tags_and_keeps_the_batch_reviewable() {
        use crate::db::service::conversation_tag_service as tags;
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "F:/tag-confirm-rollback").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let global = tags::create_tag(&db.conn, None, "MCP", "#123456")
            .await
            .unwrap();
        let local = tags::create_tag(&db.conn, Some(folder), "MCP", "#123456")
            .await
            .unwrap();
        let mut ambiguous = TagCandidate::new_tag("MCP", None, "topic");
        ambiguous.tag_ids = vec![global.id, local.id];
        let batch = save_batch(
            &db.conn,
            conversation,
            "input",
            "v1",
            vec![
                TagCandidate::new_tag("Must roll back", None, "topic"),
                ambiguous,
            ],
            1000,
        )
        .await
        .unwrap();
        ignore_candidate(&db.conn, conversation, &batch.id, 1, Some(global.id))
            .await
            .unwrap();
        let mut forbidden = TagChoice::candidate(1);
        forbidden.tag_id = Some(global.id);
        assert!(confirm_batch(
            &db.conn,
            conversation,
            &batch.id,
            vec![TagChoice::candidate(0), forbidden]
        )
        .await
        .is_err());
        assert!(!tags::list_tags(&db.conn)
            .await
            .unwrap()
            .iter()
            .any(|tag| tag.name == "Must roll back"));
        assert!(
            crate::db::service::conversation_service::get_by_id(&db.conn, conversation)
                .await
                .unwrap()
                .tag_ids
                .is_empty()
        );
        assert_eq!(
            read_status(&db.conn, conversation)
                .await
                .unwrap()
                .batch
                .unwrap()
                .id,
            batch.id
        );
        let mut allowed = TagChoice::candidate(1);
        allowed.tag_id = Some(local.id);
        confirm_batch(
            &db.conn,
            conversation,
            &batch.id,
            vec![TagChoice::candidate(0), allowed],
        )
        .await
        .unwrap();
        let summary = crate::db::service::conversation_service::get_by_id(&db.conn, conversation)
            .await
            .unwrap();
        assert!(summary.tag_ids.contains(&local.id));
        assert!(!summary.tag_ids.contains(&global.id));
        assert_eq!(summary.tag_ids.len(), 2);
    }

    #[tokio::test]
    async fn separate_review_leases_survive_another_windows_repeated_close_and_are_collected_after_release(
    ) {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "F:/tag-review-leases").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let old = save_batch(
            &db.conn,
            conversation,
            "old",
            "v1",
            vec![TagCandidate::new_tag("MCP", None, "topic")],
            1000,
        )
        .await
        .unwrap();
        let first = open_batch(&db.conn, conversation, &old.id, 1000, None)
            .await
            .unwrap();
        let second = open_batch(&db.conn, conversation, &old.id, 1001, None)
            .await
            .unwrap();
        let first_lease = first.lease_token.unwrap();
        let second_lease = second.lease_token.unwrap();
        assert_ne!(first_lease, second_lease);
        let latest = save_batch(
            &db.conn,
            conversation,
            "new",
            "v1",
            vec![TagCandidate::new_tag("Avatar", None, "topic")],
            1010,
        )
        .await
        .unwrap();
        close_batch(&db.conn, conversation, &old.id, 1011, Some(&first_lease))
            .await
            .unwrap();
        close_batch(&db.conn, conversation, &old.id, 1012, Some(&first_lease))
            .await
            .unwrap();
        cleanup_batches(&db.conn, 1012).await.unwrap();
        let renewed = open_batch(&db.conn, conversation, &old.id, 1013, Some(&second_lease))
            .await
            .unwrap();
        assert_eq!(renewed.id, old.id);
        assert_eq!(renewed.lease_token.as_deref(), Some(second_lease.as_str()));
        close_batch(&db.conn, conversation, &old.id, 1014, Some(&second_lease))
            .await
            .unwrap();
        cleanup_batches(&db.conn, 1014).await.unwrap();
        assert!(open_batch(&db.conn, conversation, &old.id, 1015, None)
            .await
            .is_err());
        assert_eq!(
            read_status(&db.conn, conversation)
                .await
                .unwrap()
                .batch
                .unwrap()
                .id,
            latest.id
        );
    }

    #[tokio::test]
    async fn manually_removing_a_tag_prevents_ai_from_recommending_it_again() {
        use crate::db::service::conversation_tag_service as tags;
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "F:/tag-remove-test").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let tag = tags::create_tag(&db.conn, None, "MCP", "#123456")
            .await
            .unwrap();
        tags::update_conversation_tags(&db.conn, conversation, &[tag.id], &[])
            .await
            .unwrap();
        tags::update_conversation_tags(&db.conn, conversation, &[], &[tag.id])
            .await
            .unwrap();
        let mut candidate = TagCandidate::new_tag("MCP", None, "topic");
        candidate.tag_ids = vec![tag.id];
        save_batch(&db.conn, conversation, "input", "v1", vec![candidate], 1000)
            .await
            .unwrap();
        let status = read_status(&db.conn, conversation).await.unwrap();
        assert!(status.batch.is_none());
        assert_eq!(status.ignored[0].tag_id, Some(tag.id));
        tags::update_conversation_tags(&db.conn, conversation, &[tag.id], &[])
            .await
            .unwrap();
        assert!(
            crate::db::service::conversation_service::get_by_id(&db.conn, conversation)
                .await
                .unwrap()
                .tag_ids
                .contains(&tag.id)
        );
    }

    #[tokio::test]
    async fn ignoring_a_candidate_filters_future_batches_until_explicitly_restored() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "F:/tag-ignore-test").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let candidate = TagCandidate::new_tag("数字人", None, "主题");
        let first = save_batch(
            &db.conn,
            conversation,
            "one",
            "v1",
            vec![candidate.clone()],
            1000,
        )
        .await
        .unwrap();
        ignore_candidate(&db.conn, conversation, &first.id, 0, None)
            .await
            .unwrap();
        save_batch(&db.conn, conversation, "two", "v1", vec![candidate], 2000)
            .await
            .unwrap();
        let status = read_status(&db.conn, conversation).await.unwrap();
        assert!(status.batch.is_none());
        assert_eq!(status.ignored[0].name, "数字人");

        restore_ignored(&db.conn, conversation, &status.ignored[0].key)
            .await
            .unwrap();
        let tag = crate::db::service::conversation_tag_service::create_tag(
            &db.conn,
            None,
            "数字人",
            "#0969da",
        )
        .await
        .unwrap();
        let mut existing = TagCandidate::new_tag("数字人", None, "主题");
        existing.tag_ids = vec![tag.id];
        save_batch(&db.conn, conversation, "three", "v1", vec![existing], 3000)
            .await
            .unwrap();
        assert_eq!(
            read_status(&db.conn, conversation)
                .await
                .unwrap()
                .batch
                .unwrap()
                .candidates[0]
                .tag_ids,
            vec![tag.id]
        );
    }

    #[tokio::test]
    async fn confirming_an_older_batch_keeps_newer_candidates_and_is_idempotent() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "F:/tag-batches-test").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let old = save_batch(
            &db.conn,
            conversation,
            "one",
            "config",
            vec![TagCandidate::new_tag("MCP", None, "主题")],
            1000,
        )
        .await
        .unwrap();
        let latest = save_batch(
            &db.conn,
            conversation,
            "two",
            "config",
            vec![TagCandidate::new_tag("数字人", None, "主题")],
            2000,
        )
        .await
        .unwrap();

        confirm_batch(
            &db.conn,
            conversation,
            &old.id,
            vec![TagChoice::candidate(0)],
        )
        .await
        .unwrap();
        confirm_batch(
            &db.conn,
            conversation,
            &old.id,
            vec![TagChoice::candidate(0)],
        )
        .await
        .unwrap();

        let status = read_status(&db.conn, conversation).await.unwrap();
        assert_eq!(status.batch.unwrap().id, latest.id);
        let tags = crate::db::service::conversation_tag_service::list_tags(&db.conn)
            .await
            .unwrap();
        assert_eq!(
            tags.iter().map(|tag| tag.name.as_str()).collect::<Vec<_>>(),
            vec!["MCP"]
        );
        let summary = crate::db::service::conversation_service::get_by_id(&db.conn, conversation)
            .await
            .unwrap();
        assert_eq!(summary.tag_ids, vec![tags[0].id]);
    }

    #[tokio::test]
    async fn generated_candidates_are_retrievable_without_applying_tags() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "F:/tag-store-test").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let candidate = TagCandidate::new_tag("数字人", None, "会话主题");
        let batch = save_batch(
            &db.conn,
            conversation,
            "input-1",
            "config-1",
            vec![candidate],
            1000,
        )
        .await
        .expect("save candidates");

        let status = read_status(&db.conn, conversation)
            .await
            .expect("read status");
        assert_eq!(status.batch.expect("pending batch").id, batch.id);
        let summary = crate::db::service::conversation_service::get_by_id(&db.conn, conversation)
            .await
            .expect("conversation");
        assert!(summary.tag_ids.is_empty());
    }

    #[tokio::test]
    async fn processed_batch_receipts_expire_after_thirty_days_but_latest_batch_remains() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "F:/tag-receipt-expiry").await;
        let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let old = save_batch(&db.conn, conversation, "old", "v1", vec![TagCandidate::new_tag("MCP", None, "topic")], 1000).await.unwrap();
        confirm_batch(&db.conn, conversation, &old.id, vec![TagChoice::candidate(0)]).await.unwrap();
        let latest = save_batch(&db.conn, conversation, "new", "v1", vec![TagCandidate::new_tag("Avatar", None, "topic")], 2000).await.unwrap();
        cleanup_batches(&db.conn, 1000 + 31 * 24 * 60 * 60).await.unwrap();
        assert!(get_batch(&db.conn, conversation, &old.id).await.is_err());
        assert_eq!(read_status(&db.conn, conversation).await.unwrap().batch.unwrap().id, latest.id);
    }
}
