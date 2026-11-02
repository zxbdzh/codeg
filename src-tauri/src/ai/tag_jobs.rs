use async_trait::async_trait;
use sea_orm::{
    ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait, Statement, TransactionTrait,
};
use sha2::{Digest, Sha256};

use crate::ai::{
    client::{AiClient, AiError},
    settings,
    suggest::{request_suggestion, resolve_provider, AiFlowError, SuggestionInput},
    tag_store::{self, TagCandidate},
};
use crate::db::{error::DbError, service::conversation_tag_service};

pub const TAG_INTERVAL_SECONDS: i64 = 120;

pub async fn record_completed(
    conn: &DatabaseConnection,
    conversation_id: i32,
    completed: &[crate::models::message::MessageTurn],
    now: i64,
) -> Result<(), DbError> {
    use crate::models::message::TurnRole;
    if !settings::load(conn).await?.auto_suggest_tags {
        return Ok(());
    }
    let has_user = completed.iter().any(|turn| {
        matches!(turn.role, TurnRole::User) && crate::ai::context::text_of_turn(turn).is_some()
    });
    let has_reply = completed.iter().any(|turn| {
        matches!(turn.role, TurnRole::Assistant) && crate::ai::context::text_of_turn(turn).is_some()
    });
    if !has_user || !has_reply {
        return Ok(());
    }
    let persisted =
        crate::commands::conversations::get_folder_conversation_core(conn, conversation_id)
            .await
            .map(|(detail, _)| detail.turns)
            .unwrap_or_default();
    let turns = crate::ai::completed_turn::merge_completed_turn(persisted, completed);
    let settings = settings::load(conn).await?;
    let context = crate::ai::context::build_tag_context(
        &turns,
        settings.context_turns,
        crate::ai::context::MAX_CONTEXT_CHARS,
    );
    enqueue_context(conn, conversation_id, &context, now).await
}

pub struct TranscriptSource {
    pub conn: DatabaseConnection,
    pub manager: crate::acp::manager::ConnectionManager,
}

#[async_trait]
impl ContextSource for TranscriptSource {
    async fn read(&self, conversation_id: i32) -> Result<String, DbError> {
        let mut completed = Vec::new();
        if let Some(connection) = self
            .manager
            .find_connection_by_conversation_id(conversation_id)
            .await
        {
            if let Some(state) = self.manager.get_state(&connection).await {
                completed = state.read().await.completed_title_turns.clone();
            }
        }
        let persisted = match crate::commands::conversations::get_folder_conversation_core(
            &self.conn,
            conversation_id,
        )
        .await
        {
            Ok((detail, _)) => detail.turns,
            Err(_) if !completed.is_empty() => Vec::new(),
            Err(error) => return Err(DbError::Validation(error.to_string())),
        };
        let turns = crate::ai::completed_turn::merge_completed_turn(persisted, &completed);
        let settings = settings::load(&self.conn).await?;
        Ok(crate::ai::context::build_tag_context(
            &turns,
            settings.context_turns,
            crate::ai::context::MAX_CONTEXT_CHARS,
        ))
    }
}

pub async fn worker(
    conn: DatabaseConnection,
    manager: crate::acp::manager::ConnectionManager,
    emitter: crate::web::event_bridge::EventEmitter,
) {
    let client = match crate::ai::client::HttpAiClient::new() {
        Ok(client) => client,
        Err(error) => {
            tracing::warn!(%error, "could not initialize tag worker");
            return;
        }
    };
    let source = TranscriptSource {
        conn: conn.clone(),
        manager,
    };
    let mut ticks = tokio::time::interval(std::time::Duration::from_secs(2));
    loop {
        ticks.tick().await;
        let now = chrono::Utc::now().timestamp();
        if let Err(error) = tag_store::cleanup_batches(&conn, now).await {
            tracing::warn!(%error, "could not collect expired tag reviews");
        }
        // 只查询已存在的待更新任务；浏览历史与启动应用不能扫描补算会话。
        let rows = match conn.query_all(Statement::from_sql_and_values(DbBackend::Sqlite, "SELECT job.conversation_id FROM ai_tag_job AS job INNER JOIN conversation ON conversation.id = job.conversation_id WHERE job.due_at IS NOT NULL AND job.due_at <= ? AND (job.lease_until IS NULL OR job.lease_until <= ?) AND conversation.deleted_at IS NULL AND conversation.status != 'in_progress'", vec![now.into(), now.into()])).await {
                Ok(rows) => rows,
                Err(error) => { tracing::warn!(%error, "tag worker state unavailable"); continue; }
            };
        for row in rows {
            let Ok(conversation_id) = row.try_get::<i32>("", "conversation_id") else {
                continue;
            };
            let before = tag_store::read_status(&conn, conversation_id).await.ok();
            let started = std::time::Instant::now();
            if let Err(error) = run_one(&conn, &client, &source, conversation_id, now).await {
                tracing::warn!(conversation_id, %error, "tag worker failed");
            }
            let finished_at =
                now.saturating_add(i64::try_from(started.elapsed().as_secs()).unwrap_or(i64::MAX));
            if finished_at > now {
                if let Err(error) = tag_store::cleanup_batches(&conn, finished_at).await {
                    tracing::warn!(%error, "could not collect expired tag reviews");
                }
            }
            let after = tag_store::read_status(&conn, conversation_id).await.ok();
            if before.map(|status| serde_json::to_string(&status).ok())
                != after.map(|status| serde_json::to_string(&status).ok())
            {
                crate::commands::tag_suggestions::emit_changed(&emitter, conversation_id);
            }
        }
    }
}

/// 正文属于会话存储；调度表只保存指纹，不能变成另一份聊天记录。
#[async_trait]
pub trait ContextSource: Send + Sync {
    async fn read(&self, conversation_id: i32) -> Result<String, DbError>;
}

pub fn fingerprint(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn configuration_fingerprint(
    settings: &settings::AiAssistantSettings,
    provider: &crate::db::entities::model_provider::Model,
) -> String {
    // 开关与标题策略不属于标签输入；关闭开关后，已付出调用的有效结果仍须保留。
    let input = serde_json::json!({
        "provider": provider.id,
        "endpoint": provider.api_url,
        "credentialRevision": fingerprint(&provider.api_key),
        "protocol": settings.protocol(),
        "header": settings.key_header,
        "model": settings.model_for(settings::AiTask::Tagging),
        "contextTurns": settings.context_turns,
        "promptVersion": "topic-tags-1"
    });
    fingerprint(&input.to_string())
}

async fn prepare_model_input(
    conn: &DatabaseConnection,
    conversation_id: i32,
    context: String,
    config: &str,
) -> Result<(SuggestionInput, String), DbError> {
    let limit = crate::ai::context::MAX_CONTEXT_CHARS;
    let context = if context.chars().count() > limit {
        // 极长的单轮不能绕过总预算；首部保留主线，尾部保留最新正文，按字符切割不损坏 UTF-8。
        let head_count = limit / 3;
        let tail_count = limit.saturating_sub(head_count + 3);
        let head: String = context.chars().take(head_count).collect();
        let tail: String = context
            .chars()
            .rev()
            .take(tail_count)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("{head}\n…\n{tail}")
    } else {
        context
    };
    let pool = conversation_tag_service::available_tags_for_conversation(conn, conversation_id)
        .await
        .map_err(|error| DbError::Validation(error.to_string()))?;
    let ignored = tag_store::list_ignored(conn, conversation_id).await?;
    let rows = conn
        .query_all(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT tag_id FROM conversation_tag_link WHERE conversation_id = ? ORDER BY tag_id",
            vec![conversation_id.into()],
        ))
        .await?;
    let attached = rows
        .into_iter()
        .map(|row| row.try_get::<i32>("", "tag_id"))
        .collect::<Result<Vec<_>, _>>()?;
    let key = fingerprint(
        &serde_json::json!({
            "context": context,
            "config": config,
            "pool": pool,
            "ignored": ignored,
            "attached": attached,
        })
        .to_string(),
    );
    let available = pool
        .into_iter()
        .filter(|tag| {
            !attached.contains(&tag.id)
                && !tag_store::tag_is_ignored(&ignored, tag.id, &tag.name, tag.folder_id)
        })
        .collect();
    Ok((SuggestionInput { context, available }, key))
}

pub async fn enqueue_context(
    conn: &DatabaseConnection,
    conversation_id: i32,
    context: &str,
    now: i64,
) -> Result<(), DbError> {
    if context.trim().is_empty() || !settings::load(conn).await?.auto_suggest_tags {
        return Ok(());
    }
    let target = fingerprint(context);
    conn.execute(Statement::from_sql_and_values(DbBackend::Sqlite,
        "INSERT INTO ai_tag_job(conversation_id, target, due_at) SELECT id, ?, ? FROM conversation WHERE id = ? AND deleted_at IS NULL ON CONFLICT(conversation_id) DO UPDATE SET target = excluded.target, due_at = CASE WHEN ai_tag_job.last_start IS NULL THEN excluded.due_at ELSE max(excluded.due_at, ai_tag_job.last_start + 120) END, retry_count = CASE WHEN ai_tag_job.target != excluded.target THEN 0 ELSE ai_tag_job.retry_count END, error = NULL, lease = CASE WHEN ai_tag_job.target != excluded.target THEN NULL ELSE ai_tag_job.lease END, lease_until = CASE WHEN ai_tag_job.target != excluded.target THEN NULL ELSE ai_tag_job.lease_until END, lease_target = CASE WHEN ai_tag_job.target != excluded.target THEN NULL ELSE ai_tag_job.lease_target END WHERE ai_tag_job.target != excluded.target",
        vec![target.into(), now.into(), conversation_id.into()])).await?;
    Ok(())
}

pub async fn run_due(
    conn: &DatabaseConnection,
    client: &dyn AiClient,
    source: &dyn ContextSource,
    now: i64,
) -> Result<(), DbError> {
    let settings = settings::load(conn).await?;
    if !settings.auto_suggest_tags {
        return Ok(());
    }
    let rows = conn.query_all(Statement::from_sql_and_values(DbBackend::Sqlite, "SELECT conversation_id FROM ai_tag_job WHERE due_at IS NOT NULL AND due_at <= ? AND (lease_until IS NULL OR lease_until <= ?)", vec![now.into(), now.into()])).await?;
    for row in rows {
        let conversation_id: i32 = row.try_get("", "conversation_id")?;
        if let Err(error) = run_one(conn, client, source, conversation_id, now).await {
            tracing::warn!(conversation_id, %error, "tag suggestion job failed");
        }
    }
    Ok(())
}

pub async fn run_one(
    conn: &DatabaseConnection,
    client: &dyn AiClient,
    source: &dyn ContextSource,
    conversation_id: i32,
    now: i64,
) -> Result<(), DbError> {
    run_job(conn, client, source, conversation_id, now, false).await
}

pub async fn generate_manual(
    conn: &DatabaseConnection,
    client: &dyn AiClient,
    source: &dyn ContextSource,
    conversation_id: i32,
    force: bool,
    now: i64,
) -> Result<tag_store::TagStatus, DbError> {
    let status = tag_store::read_status(conn, conversation_id).await?;
    let context = source.read(conversation_id).await?;
    if context.trim().is_empty() {
        return Err(DbError::Validation(
            "the conversation has no completed text".into(),
        ));
    }
    let target = fingerprint(&context);
    let settings = settings::load(conn).await?;
    let provider = resolve_provider(conn, &settings)
        .await
        .map_err(|error| DbError::Validation(error.to_string()))?;
    let config = configuration_fingerprint(&settings, &provider);
    let (_, input_key) = prepare_model_input(conn, conversation_id, context, &config).await?;
    if !force
        && status
            .batch
            .as_ref()
            .is_some_and(|batch| batch.input == input_key && batch.config == config)
    {
        return Ok(status);
    }
    let started = std::time::Instant::now();
    let mut waited_for_request = false;
    loop {
        let elapsed = i64::try_from(started.elapsed().as_secs()).unwrap_or(35);
        let clock = now + elapsed;
        let row = conn.query_one(Statement::from_sql_and_values(DbBackend::Sqlite, "SELECT lease_until, processed, cache_key FROM ai_tag_job WHERE conversation_id = ?", vec![conversation_id.into()])).await?;
        if let Some(row) = row {
            let until: Option<i64> = row.try_get("", "lease_until")?;
            if until.is_some_and(|until| until > clock) {
                waited_for_request = true;
                if started.elapsed() >= std::time::Duration::from_secs(35) {
                    return tag_store::read_status(conn, conversation_id).await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
            // 共用刚完成的请求，不因同时点入口而再花一次调用。
            if waited_for_request {
                return tag_store::read_status(conn, conversation_id).await;
            }
            let processed: String = row.try_get("", "processed")?;
            let cached: String = row.try_get("", "cache_key")?;
            if !force && processed == target && cached == input_key {
                return tag_store::read_status(conn, conversation_id).await;
            }
        }
        conn.execute(Statement::from_sql_and_values(DbBackend::Sqlite,
        "INSERT INTO ai_tag_job(conversation_id, target, due_at) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET target = excluded.target, due_at = excluded.due_at, retry_count = 0, error = NULL, lease = NULL, lease_target = NULL, lease_until = NULL WHERE ai_tag_job.lease_until IS NULL OR ai_tag_job.lease_until <= ?",
            vec![conversation_id.into(), target.clone().into(), clock.into(), clock.into()])).await?;
        run_job(conn, client, source, conversation_id, clock, true).await?;
        return tag_store::read_status(conn, conversation_id).await;
    }
}

async fn run_job(
    conn: &DatabaseConnection,
    client: &dyn AiClient,
    source: &dyn ContextSource,
    conversation_id: i32,
    now: i64,
    manual: bool,
) -> Result<(), DbError> {
    let execution_started = std::time::Instant::now();
    let settings = settings::load(conn).await?;
    if !settings.auto_suggest_tags && !manual {
        return Ok(());
    }
    // 请求被取消或进程退出时不会走失败回调；恢复过期占位也必须消耗同一重试预算。
    conn.execute(Statement::from_sql_and_values(DbBackend::Sqlite,
        "UPDATE ai_tag_job SET due_at = CASE WHEN retry_count = 0 THEN max(coalesce(due_at, ?), coalesce(last_start, ?) + 120) ELSE NULL END, error = CASE WHEN retry_count = 0 THEN 'The previous tag request was interrupted; one recovery attempt is pending' ELSE 'Tag generation was interrupted twice; refresh manually or continue the conversation' END, retry_count = retry_count + 1, lease = NULL, lease_target = NULL, lease_until = NULL WHERE conversation_id = ? AND lease IS NOT NULL AND lease_target = target AND lease_until <= ?",
        vec![now.into(), now.into(), conversation_id.into(), now.into()])).await?;
    let token = uuid::Uuid::new_v4().to_string();
    let claimed = conn.execute(Statement::from_sql_and_values(DbBackend::Sqlite,
        "UPDATE ai_tag_job SET lease = ?, lease_target = target, lease_until = ?, last_start = ? WHERE conversation_id = ? AND due_at <= ? AND (lease_until IS NULL OR lease_until <= ?) AND EXISTS (SELECT 1 FROM conversation WHERE id = ? AND deleted_at IS NULL AND (? = 1 OR status != 'in_progress'))",
        vec![token.clone().into(), (now + 45).into(), now.into(), conversation_id.into(), now.into(), now.into(), conversation_id.into(), manual.into()])).await?;
    if claimed.rows_affected() == 0 {
        return Ok(());
    }
    let target_row = conn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT target FROM ai_tag_job WHERE conversation_id = ? AND lease = ?",
            vec![conversation_id.into(), token.clone().into()],
        ))
        .await?
        .ok_or_else(|| DbError::Conflict("job ownership lost".into()))?;
    let target: String = target_row.try_get("", "target")?;
    let prepared = async {
        let context = source.read(conversation_id).await?;
        let provider = resolve_provider(conn, &settings)
            .await
            .map_err(|error| DbError::Validation(error.to_string()))?;
        let config = configuration_fingerprint(&settings, &provider);
        let input = fingerprint(&context);
        let (model_input, cache_key) =
            prepare_model_input(conn, conversation_id, context, &config).await?;
        Ok::<_, DbError>((model_input, provider, config, input, cache_key))
    }
    .await;
    let (model_input, provider, config, input, cache_key) = match prepared {
        Ok(input) => input,
        Err(error) => {
            let failed_at = now.saturating_add(
                i64::try_from(execution_started.elapsed().as_secs()).unwrap_or(i64::MAX),
            );
            finish_failure(
                conn,
                conversation_id,
                &token,
                &target,
                &error.to_string(),
                None,
                failed_at,
            )
            .await?;
            return Ok(());
        }
    };
    let suggestion = match request_suggestion(client, &settings, &provider, &model_input).await {
        Ok(suggestion) => suggestion,
        Err(error) => {
            let transient = match &error {
                AiFlowError::Client(AiError::Transport(message)) => message
                    .split_whitespace()
                    .next()
                    .and_then(|part| part.parse::<u16>().ok())
                    .is_none_or(|status| status == 429 || status >= 500),
                AiFlowError::Client(AiError::HttpStatus { code, .. }) => {
                    *code == 408 || *code == 429 || (500..600).contains(code)
                }
                _ => false,
            };
            let retry_wait = match &error {
                AiFlowError::Client(error) => error
                    .retry_after_seconds()
                    .and_then(|seconds| i64::try_from(seconds).ok())
                    .unwrap_or(TAG_INTERVAL_SECONDS)
                    .max(TAG_INTERVAL_SECONDS),
                _ => TAG_INTERVAL_SECONDS,
            };
            let message = crate::ai::wire::scrub_secret(&error.to_string(), &provider.api_key);
            let failed_at = now.saturating_add(
                i64::try_from(execution_started.elapsed().as_secs()).unwrap_or(i64::MAX),
            );
            finish_failure(
                conn,
                conversation_id,
                &token,
                &target,
                &message,
                transient.then_some(retry_wait),
                failed_at,
            )
            .await?;
            return Ok(());
        }
    };
    let mut candidates = Vec::new();
    for tag in suggestion.tags {
        let matches: Vec<_> = model_input
            .available
            .iter()
            .filter(|item| item.name.to_lowercase() == tag.name.to_lowercase())
            .collect();
        if matches.is_empty() {
            continue;
        }
        candidates.push(TagCandidate {
            index: candidates.len(),
            name: tag.name,
            reason: tag.reason,
            color: matches[0].color.clone(),
            folder_id: matches[0].folder_id,
            tag_ids: matches.iter().map(|item| item.id).collect(),
        });
    }
    for tag in suggestion.new_tags {
        if candidates.len() == 5 {
            break;
        }
        let mut candidate = TagCandidate::new_tag(&tag.name, None, "");
        if let Some(color) = tag.color.filter(|color| {
            color.len() == 7
                && color.starts_with('#')
                && color[1..]
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
        }) {
            candidate.color = color;
        }
        candidates.push(candidate);
    }
    let txn = conn.begin().await?;
    let owner = txn
        .execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "UPDATE ai_tag_job SET lease = lease WHERE conversation_id = ? AND lease = ?",
            vec![conversation_id.into(), token.clone().into()],
        ))
        .await?;
    if owner.rows_affected() == 0 {
        txn.commit().await?;
        return Ok(());
    }
    // 写锁内读取配置，避免校验后、保存前另一窗口切换模型而落入旧结果。
    let saved = crate::db::service::app_metadata_service::get_value_conn(
        &txn,
        settings::AI_ASSISTANT_SETTINGS_KEY,
    )
    .await?;
    let current_settings = settings::parse_settings(saved.as_deref());
    let current_provider = match current_settings.provider_id {
        Some(provider_id) => {
            crate::db::entities::model_provider::Entity::find_by_id(provider_id)
                .one(&txn)
                .await?
        }
        None => None,
    };
    let current_config = current_provider
        .as_ref()
        .map(|provider| configuration_fingerprint(&current_settings, provider));
    if current_config.as_deref() != Some(config.as_str()) {
        txn.execute(Statement::from_sql_and_values(DbBackend::Sqlite, "UPDATE ai_tag_job SET lease = NULL, lease_target = NULL, lease_until = NULL, due_at = max(last_start + 120, ?), error = NULL WHERE conversation_id = ? AND lease = ?", vec![now.into(), conversation_id.into(), token.into()])).await?;
        txn.commit().await?;
        return Ok(());
    }
    let changed = txn.execute(Statement::from_sql_and_values(DbBackend::Sqlite, "UPDATE ai_tag_job SET processed = ?, cache_key = ?, due_at = CASE WHEN target = ? THEN NULL ELSE last_start + 120 END, lease = NULL, lease_target = NULL, lease_until = NULL, error = NULL WHERE conversation_id = ? AND lease = ?", vec![input.clone().into(), cache_key.clone().into(), input.clone().into(), conversation_id.into(), token.into()])).await?;
    if changed.rows_affected() != 0 {
        let candidates = tag_store::filter_candidates(&txn, conversation_id, candidates).await?;
        tag_store::save_batch(&txn, conversation_id, &cache_key, &config, candidates, now).await?;
    }
    txn.commit().await?;
    Ok(())
}

async fn finish_failure(
    conn: &DatabaseConnection,
    conversation_id: i32,
    token: &str,
    target: &str,
    message: &str,
    retry_wait: Option<i64>,
    now: i64,
) -> Result<(), DbError> {
    // 重试预算随目标保存；同一目标失败两次后不再因轮询或重启复活。
    conn.execute(Statement::from_sql_and_values(DbBackend::Sqlite,
        "UPDATE ai_tag_job SET error = ?, due_at = CASE WHEN target != ? THEN max(?, last_start + 120) WHEN retry_count = 0 AND ? THEN ? ELSE NULL END, retry_count = CASE WHEN target != ? THEN 0 ELSE retry_count + 1 END, lease = NULL, lease_target = NULL, lease_until = NULL WHERE conversation_id = ? AND lease = ?",
        vec![message.into(), target.into(), now.into(), retry_wait.is_some().into(), now.saturating_add(retry_wait.unwrap_or(TAG_INTERVAL_SECONDS)).into(), target.into(), conversation_id.into(), token.into()])).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
