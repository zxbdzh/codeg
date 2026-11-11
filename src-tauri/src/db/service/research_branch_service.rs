use chrono::Utc;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, DatabaseConnection,
    EntityTrait, QueryFilter, Set, TransactionTrait,
};
#[cfg(test)]
use sea_orm::{Condition, QueryOrder};
use serde::Serialize;

use crate::db::entities::{conversation, research_branch};
use crate::db::error::DbError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchBranchInfo {
    pub id: i32,
    pub source_conversation_id: i32,
    pub branch_conversation_id: i32,
    pub source_session_id: String,
    pub branch_session_id: String,
    pub source_turn_id: Option<String>,
    pub boundary: String,
    pub title: String,
    pub source_title: String,
    pub created_at: String,
}

pub async fn live_conversation<C: ConnectionTrait>(
    conn: &C,
    id: i32,
) -> Result<conversation::Model, DbError> {
    conversation::Entity::find_by_id(id)
        .filter(conversation::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("Conversation {id}")))
}

async fn info<C: ConnectionTrait>(
    conn: &C,
    row: research_branch::Model,
) -> Result<ResearchBranchInfo, DbError> {
    let source = live_conversation(conn, row.source_conversation_id).await?;
    let branch = live_conversation(conn, row.branch_conversation_id).await?;
    Ok(ResearchBranchInfo {
        id: row.id,
        source_conversation_id: source.id,
        branch_conversation_id: branch.id,
        source_session_id: row.source_session_id,
        branch_session_id: row.branch_session_id,
        source_turn_id: row.source_turn_id,
        boundary: row.boundary,
        title: branch.title.unwrap_or_default(),
        source_title: source.title.unwrap_or_default(),
        created_at: row.created_at.to_rfc3339(),
    })
}

pub async fn by_request(
    conn: &DatabaseConnection,
    request_id: &str,
    source_id: i32,
) -> Result<Option<ResearchBranchInfo>, DbError> {
    by_request_conn(conn, request_id, source_id).await
}

async fn by_request_conn<C: ConnectionTrait>(
    conn: &C,
    request_id: &str,
    source_id: i32,
) -> Result<Option<ResearchBranchInfo>, DbError> {
    let row = research_branch::Entity::find()
        .filter(research_branch::Column::RequestId.eq(request_id))
        .one(conn)
        .await?;
    match row {
        Some(row) if row.source_conversation_id != source_id => Err(DbError::Conflict(
            "Research request id belongs to another source".into(),
        )),
        Some(row) => Ok(Some(info(conn, row).await?)),
        None => Ok(None),
    }
}

#[cfg(test)]
pub async fn by_branch(
    conn: &DatabaseConnection,
    branch_id: i32,
) -> Result<ResearchBranchInfo, DbError> {
    let row = research_branch::Entity::find()
        .filter(research_branch::Column::BranchConversationId.eq(branch_id))
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("Research branch {branch_id}")))?;
    info(conn, row).await
}

#[cfg(test)]
pub async fn list(conn: &DatabaseConnection, id: i32) -> Result<Vec<ResearchBranchInfo>, DbError> {
    live_conversation(conn, id).await?;
    let rows = research_branch::Entity::find()
        .filter(
            Condition::any()
                .add(research_branch::Column::SourceConversationId.eq(id))
                .add(research_branch::Column::BranchConversationId.eq(id)),
        )
        .order_by_asc(research_branch::Column::Id)
        .all(conn)
        .await?;
    let mut results = Vec::new();
    for row in rows {
        match info(conn, row).await {
            Ok(value) => results.push(value),
            Err(DbError::NotFound(_)) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(results)
}

#[cfg(test)]
pub async fn create(
    conn: &DatabaseConnection,
    request_id: &str,
    source_id: i32,
    source_session_id: &str,
    branch_session_id: &str,
    source_turn_id: Option<String>,
) -> Result<ResearchBranchInfo, DbError> {
    create_with_boundary(
        conn,
        request_id,
        source_id,
        source_session_id,
        branch_session_id,
        source_turn_id,
        "session_tail",
    )
    .await
}

pub async fn create_with_boundary(
    conn: &DatabaseConnection,
    request_id: &str,
    source_id: i32,
    source_session_id: &str,
    branch_session_id: &str,
    source_turn_id: Option<String>,
    boundary: &str,
) -> Result<ResearchBranchInfo, DbError> {
    if !matches!(boundary, "session_tail" | "before_prompt") {
        return Err(DbError::Validation("Unknown research boundary".into()));
    }
    if boundary == "before_prompt" && source_turn_id.as_deref().is_none_or(str::is_empty) {
        return Err(DbError::Validation(
            "A historical fork must name its prompt".into(),
        ));
    }
    if let Some(existing) = by_request(conn, request_id, source_id).await? {
        return Ok(existing);
    }
    if source_session_id.is_empty()
        || branch_session_id.is_empty()
        || source_session_id == branch_session_id
    {
        return Err(DbError::Validation(
            "Fork must return a distinct nonempty session id".into(),
        ));
    }
    let tx = conn.begin().await?;
    claim_writer(&tx).await?;
    if let Some(existing) = by_request_conn(&tx, request_id, source_id).await? {
        return Ok(existing);
    }
    let source = live_conversation(&tx, source_id).await?;
    if source.external_id.as_deref() != Some(source_session_id) {
        return Err(DbError::Conflict(
            "Source session changed during research fork".into(),
        ));
    }
    if !matches!(
        source.kind,
        conversation::ConversationKind::Regular | conversation::ConversationKind::Chat
    ) {
        return Err(DbError::Validation(
            "Research source must be a regular or chat conversation".into(),
        ));
    }
    if conversation::Entity::find()
        .filter(conversation::Column::ExternalId.eq(branch_session_id))
        .filter(conversation::Column::AgentType.eq(&source.agent_type))
        .one(&tx)
        .await?
        .is_some()
    {
        return Err(DbError::Conflict(
            "Fork session already belongs to a conversation".into(),
        ));
    }
    let now = Utc::now();
    let title = format!(
        "[Fork] {}",
        source.title.as_deref().unwrap_or("Conversation")
    );
    let mut branch: conversation::ActiveModel = source.into();
    branch.id = NotSet;
    branch.external_id = Set(Some(branch_session_id.to_string()));
    branch.title = Set(Some(title));
    branch.title_locked = Set(true);
    branch.status = Set(conversation::ConversationStatus::PendingReview);
    branch.parent_id = Set(None);
    branch.parent_tool_use_id = Set(None);
    branch.delegation_call_id = Set(None);
    branch.assistant_id = Set(None);
    branch.assistant_snapshot = Set(None);
    branch.pinned_at = Set(None);
    branch.created_at = Set(now);
    branch.updated_at = Set(now);
    branch.source = Set(Some("fork".into()));
    let branch = branch.insert(&tx).await?;
    // 新会话和来源关系同事务提交，任何失败都不能留下侧栏可见的半行。
    let row = research_branch::ActiveModel {
        id: NotSet,
        request_id: Set(request_id.into()),
        source_conversation_id: Set(source_id),
        branch_conversation_id: Set(branch.id),
        source_session_id: Set(source_session_id.into()),
        branch_session_id: Set(branch_session_id.into()),
        source_turn_id: Set(source_turn_id),
        boundary: Set(boundary.into()),
        summary: Set(String::new()),
        created_at: Set(now),
    }
    .insert(&tx)
    .await?;
    let result = info(&tx, row).await?;
    tx.commit().await?;
    Ok(result)
}

async fn claim_writer<C: ConnectionTrait>(conn: &C) -> Result<(), DbError> {
    // SQLite deferred BEGIN 先 SELECT 会遇到 BUSY_SNAPSHOT；空 UPDATE 先取写锁，不触碰主行。
    research_branch::Entity::update_many()
        .col_expr(
            research_branch::Column::Summary,
            Expr::col(research_branch::Column::Summary).into(),
        )
        .filter(research_branch::Column::Id.eq(-1))
        .exec(conn)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::service::conversation_service;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::db::AppDatabase;
    use crate::models::AgentType;
    use sea_orm::{DbBackend, PaginatorTrait, Statement};

    async fn source(db: &AppDatabase) -> i32 {
        let folder_id = seed_folder(db, "/research-test").await;
        let id = seed_conversation(db, folder_id, AgentType::ClaudeCode).await;
        let row = conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        let mut active: conversation::ActiveModel = row.into();
        active.external_id = Set(Some("S1".into()));
        active.title = Set(Some("主会话".into()));
        active.status = Set(conversation::ConversationStatus::PendingReview);
        active.update(&db.conn).await.unwrap();
        id
    }

    #[tokio::test]
    async fn historical_research_branch_preserves_its_boundary_and_source() {
        let db = fresh_in_memory_db().await;
        let source_id = source(&db).await;
        let before = live_conversation(&db.conn, source_id).await.unwrap();
        let branch = create_with_boundary(
            &db.conn,
            "historical",
            source_id,
            "S1",
            "S2",
            Some("turn-4".into()),
            "before_prompt",
        )
        .await
        .unwrap();
        assert_eq!(branch.boundary, "before_prompt");
        assert_eq!(branch.source_turn_id.as_deref(), Some("turn-4"));
        assert!(branch.title.starts_with("[Fork]"));
        assert_eq!(
            before,
            live_conversation(&db.conn, source_id).await.unwrap()
        );
        let loaded = by_request(&db.conn, "historical", source_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(loaded.branch_session_id, "S2");
        assert_eq!(loaded.source_turn_id, branch.source_turn_id);
    }

    #[tokio::test]
    async fn research_branch_preserves_source_and_never_sets_delegation_parent() {
        let db = fresh_in_memory_db().await;
        let source_id = source(&db).await;
        let before = conversation::Entity::find_by_id(source_id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        let branch = create(
            &db.conn,
            "first",
            source_id,
            "S1",
            "S2",
            Some("turn-2".into()),
        )
        .await
        .unwrap();
        let after = conversation::Entity::find_by_id(source_id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before, after);
        let row = live_conversation(&db.conn, branch.branch_conversation_id)
            .await
            .unwrap();
        assert_eq!(row.external_id.as_deref(), Some("S2"));
        assert_eq!(row.parent_id, None);
        assert_eq!(row.parent_tool_use_id, None);
        assert_eq!(row.delegation_call_id, None);
        assert_eq!(row.kind, conversation::ConversationKind::Regular);
        assert_eq!(row.source.as_deref(), Some("fork"));
        assert!(row.title_locked);
        assert_eq!(branch.source_turn_id.as_deref(), Some("turn-2"));
        assert_eq!(branch.boundary, "session_tail");
        assert_eq!(list(&db.conn, source_id).await.unwrap().len(), 1);
        assert_eq!(list(&db.conn, row.id).await.unwrap().len(), 1);
        assert!(conversation_service::list_children(&db.conn, source_id)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn research_branch_idempotency_summary_and_deletion_survive_relookup() {
        let db = fresh_in_memory_db().await;
        let source_id = source(&db).await;
        let first = create(&db.conn, "same", source_id, "S1", "S2", None)
            .await
            .unwrap();
        let again = create(&db.conn, "same", source_id, "S1", "unused", None)
            .await
            .unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(
            conversation::Entity::find().count(&db.conn).await.unwrap(),
            2
        );
        assert!(by_request(&db.conn, "same", source_id + 1).await.is_err());
        conversation_service::soft_delete(&db.conn, first.branch_conversation_id)
            .await
            .unwrap();
        assert!(list(&db.conn, source_id).await.unwrap().is_empty());
        assert!(matches!(
            list(&db.conn, first.branch_conversation_id).await,
            Err(DbError::NotFound(_))
        ));
        assert!(matches!(
            by_request(&db.conn, "same", source_id).await,
            Err(DbError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn research_branch_atomic_failure_rolls_back_conversation_insert() {
        let db = fresh_in_memory_db().await;
        let source_id = source(&db).await;
        db.conn.execute(Statement::from_string(DbBackend::Sqlite,
            "CREATE TRIGGER reject_research BEFORE INSERT ON research_branch BEGIN SELECT RAISE(ABORT, 'test failure'); END;".to_string())).await.unwrap();
        assert!(create(&db.conn, "rollback", source_id, "S1", "S2", None)
            .await
            .is_err());
        assert_eq!(
            conversation::Entity::find().count(&db.conn).await.unwrap(),
            1
        );
        assert_eq!(
            research_branch::Entity::find()
                .count(&db.conn)
                .await
                .unwrap(),
            0
        );
        db.conn
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                "DROP TRIGGER reject_research;".to_string(),
            ))
            .await
            .unwrap();
        assert!(create(&db.conn, "rollback", source_id, "S1", "S2", None)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn research_branch_chat_kind_and_source_deletion_are_explicit() {
        let db = fresh_in_memory_db().await;
        let source_id = source(&db).await;
        let mut row: conversation::ActiveModel =
            live_conversation(&db.conn, source_id).await.unwrap().into();
        row.kind = Set(conversation::ConversationKind::Chat);
        row.update(&db.conn).await.unwrap();
        let branch = create(&db.conn, "chat", source_id, "S1", "S2", None)
            .await
            .unwrap();
        assert_eq!(
            live_conversation(&db.conn, branch.branch_conversation_id)
                .await
                .unwrap()
                .kind,
            conversation::ConversationKind::Chat
        );
        conversation_service::soft_delete(&db.conn, source_id)
            .await
            .unwrap();
        assert!(list(&db.conn, branch.branch_conversation_id)
            .await
            .unwrap()
            .is_empty());
        assert!(matches!(
            by_branch(&db.conn, branch.branch_conversation_id).await,
            Err(DbError::NotFound(_))
        ));
        assert!(matches!(
            create(&db.conn, "new", source_id, "S1", "S3", None).await,
            Err(DbError::NotFound(_))
        ));
        assert_eq!(
            conversation::Entity::find().count(&db.conn).await.unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn research_branch_relationship_and_summary_survive_database_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let db = crate::db::test_helpers::fresh_disk_db(directory.path()).await;
        let source_id = source(&db).await;
        let branch = create(&db.conn, "restart", source_id, "S1", "S2", None)
            .await
            .unwrap();
        db.conn.close().await.unwrap();
        let url = format!(
            "sqlite:{}?mode=rwc",
            directory.path().join("source.db").display()
        );
        let conn = sea_orm::Database::connect(url).await.unwrap();
        let restored = by_request(&conn, "restart", source_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.id, branch.id);
        assert_eq!(
            list(&conn, branch.branch_conversation_id)
                .await
                .unwrap()
                .len(),
            1
        );
        conn.close().await.unwrap();
    }
}
