//! 独立旁问的持久化层。
//!
//! 这一层只保存旁问的会话元数据：来源 agent、主原生 session、旁问自己的
//! 原生 session、工作目录、可选的 Pi session 文件和用户可见标题。它不启动
//! 原生进程、不读写会话文件，也不保存 token、Cookie、API key 等凭据。

use chrono::Utc;
use sea_orm::{
    sea_query::Expr, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
};
use uuid::Uuid;

use crate::db::entities::side_question_session;
use crate::db::error::DbError;
use crate::models::AgentType;

/// 用户可见标题的上限。标题只用于列表展示，不承载消息正文。
pub const MAX_TITLE_CHARS: usize = 200;
/// 原生 session ID 的上限，给不同 agent 的实现留足空间。
pub const MAX_SESSION_ID_CHARS: usize = 512;
/// 工作目录与 Pi session 文件路径的上限。
pub const MAX_PATH_CHARS: usize = 4096;

/// 创建一条旁问所需的数据。
///
/// `id` 由调用方生成并在重试时复用：同一个 UUID 配同一份内容会返回已有记录，
/// 内容不一致则 fail closed。这里刻意没有 token / Cookie / API key 字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSideQuestion {
    pub id: Uuid,
    pub source_agent: AgentType,
    pub source_session_id: String,
    pub native_session_id: String,
    pub cwd: String,
    pub pi_session_file: Option<String>,
    pub title: String,
}

/// 创建结果。`created == false` 表示这次是幂等重试，命中了已有记录。
#[derive(Debug, Clone, PartialEq)]
pub struct CreateOutcome {
    pub record: side_question_session::Model,
    pub created: bool,
}

/// 创建失败的原因。
#[derive(Debug, thiserror::Error)]
pub enum SideQuestionError {
    #[error("invalid side-question metadata: {0}")]
    Validation(String),
    /// 唯一键已被另一条内容不同的记录占用；调用方应放弃而不是盲目重试。
    #[error("side-question conflict: {0}")]
    Conflict(String),
    #[error(transparent)]
    Db(#[from] DbError),
}

struct ValidatedNew {
    id: String,
    source_agent: String,
    source_session_id: String,
    native_session_id: String,
    cwd: String,
    pi_session_file: Option<String>,
    title: String,
}

fn clean_required(
    value: &str,
    field: &str,
    max_chars: usize,
) -> Result<String, SideQuestionError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(SideQuestionError::Validation(format!("{field} is empty")));
    }
    if value.chars().count() > max_chars {
        return Err(SideQuestionError::Validation(format!(
            "{field} exceeds {max_chars} characters"
        )));
    }
    // NUL 会截断 C 侧路径/进程参数，也会让下游日志失去可读性。
    if value.contains('\0') {
        return Err(SideQuestionError::Validation(format!(
            "{field} contains a NUL character"
        )));
    }
    Ok(value.to_string())
}

fn clean_optional(
    value: Option<String>,
    field: &str,
    max_chars: usize,
) -> Result<Option<String>, SideQuestionError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    clean_required(value, field, max_chars).map(Some)
}

fn validate(new: NewSideQuestion) -> Result<ValidatedNew, SideQuestionError> {
    Ok(ValidatedNew {
        id: new.id.to_string(),
        source_agent: new.source_agent.as_wire().into_owned(),
        source_session_id: clean_required(
            &new.source_session_id,
            "source_session_id",
            MAX_SESSION_ID_CHARS,
        )?,
        native_session_id: clean_required(
            &new.native_session_id,
            "native_session_id",
            MAX_SESSION_ID_CHARS,
        )?,
        cwd: clean_required(&new.cwd, "cwd", MAX_PATH_CHARS)?,
        pi_session_file: clean_optional(
            new.pi_session_file,
            "pi_session_file",
            MAX_PATH_CHARS,
        )?,
        title: clean_required(&new.title, "title", MAX_TITLE_CHARS)?,
    })
}

async fn find_by_id(
    conn: &DatabaseConnection,
    id: &str,
) -> Result<Option<side_question_session::Model>, DbError> {
    Ok(side_question_session::Entity::find_by_id(id.to_string())
        .one(conn)
        .await?)
}

fn is_unique_violation(error: &sea_orm::DbErr) -> bool {
    // sea-orm 1.x 没有暴露结构化的唯一约束错误，SQLite 驱动把约束名放在
    // 错误文本里；沿用仓库内其他 service 的判定方式。
    error.to_string().contains("UNIQUE constraint failed")
}

/// 重复 UUID 或重复来源/原生 session 的兜底。
///
/// 先按 UUID 看是不是同一请求的重试；内容完全一致才返回已有行。这样并发插入
/// 的第二个请求不会制造副本，而内容不同的同 ID 写入会明确失败。若 UUID 不冲突，
/// 再看是不是同一来源下已经存过这个原生 session，仍然 fail closed。
async fn reconcile_after_conflict(
    conn: &DatabaseConnection,
    new: &ValidatedNew,
) -> Result<CreateOutcome, SideQuestionError> {
    if let Some(existing) = find_by_id(conn, &new.id).await? {
        if same_creation_payload(&existing, new) {
            return Ok(CreateOutcome {
                record: existing,
                created: false,
            });
        }
        return Err(SideQuestionError::Conflict(format!(
            "side-question id {} already names a different record",
            new.id
        )));
    }

    let holder = side_question_session::Entity::find()
        .filter(side_question_session::Column::SourceAgentType.eq(new.source_agent.clone()))
        .filter(
            side_question_session::Column::SourceSessionId.eq(new.source_session_id.clone()),
        )
        .filter(
            side_question_session::Column::NativeSessionId.eq(new.native_session_id.clone()),
        )
        .one(conn)
        .await
        .map_err(DbError::from)?;

    if let Some(holder) = holder {
        return Err(SideQuestionError::Conflict(format!(
            "native session {} is already stored as side question {} under {} / {}",
            new.native_session_id, holder.id, new.source_agent, new.source_session_id
        )));
    }

    // 唯一冲突但读不到占用者：可能是别的连接刚回滚或事务状态异常。这里不重试
    // 插入，直接失败，避免在不确定状态下写出第二条记录。
    Err(SideQuestionError::Conflict(format!(
        "side-question id {} collided with a row that could not be read back",
        new.id
    )))
}

/// 比较创建负载时不比较 `is_open` 和时间：手动关闭过的旁问被重试创建时，
/// 必须保持关闭，不能被幂等逻辑顺手重新打开。
fn same_creation_payload(
    existing: &side_question_session::Model,
    new: &ValidatedNew,
) -> bool {
    existing.source_agent_type == new.source_agent
        && existing.source_session_id == new.source_session_id
        && existing.native_session_id == new.native_session_id
        && existing.cwd == new.cwd
        && existing.pi_session_file == new.pi_session_file
        && existing.title == new.title
}

/// 创建一条旁问。
///
/// 并发/重试语义：同一 UUID + 同一内容返回已有记录（`created = false`）；
/// 同一 UUID + 不同内容，或同一来源/原生 session + 不同 UUID，返回
/// [`SideQuestionError::Conflict`]，且不修改已有行。
pub async fn create(
    conn: &DatabaseConnection,
    new: NewSideQuestion,
) -> Result<CreateOutcome, SideQuestionError> {
    let new = validate(new)?;
    let now = Utc::now();
    let active = side_question_session::ActiveModel {
        id: Set(new.id.clone()),
        source_agent_type: Set(new.source_agent.clone()),
        source_session_id: Set(new.source_session_id.clone()),
        native_session_id: Set(new.native_session_id.clone()),
        cwd: Set(new.cwd.clone()),
        pi_session_file: Set(new.pi_session_file.clone()),
        title: Set(new.title.clone()),
        is_open: Set(true),
        created_at: Set(now),
        updated_at: Set(now),
    };

    match side_question_session::Entity::insert(active).exec(conn).await {
        Ok(_) => {
            let record = find_by_id(conn, &new.id).await?.ok_or_else(|| {
                DbError::NotFound(format!(
                    "side_question_session {} vanished after insert",
                    new.id
                ))
            })?;
            Ok(CreateOutcome {
                record,
                created: true,
            })
        }
        Err(error) if is_unique_violation(&error) => {
            reconcile_after_conflict(conn, &new).await
        }
        Err(error) => Err(DbError::from(error).into()),
    }
}

/// 按 UUID 读取一条旁问。
pub async fn get(
    conn: &DatabaseConnection,
    id: Uuid,
) -> Result<Option<side_question_session::Model>, DbError> {
    find_by_id(conn, &id.to_string()).await
}

/// 列出一个来源下的全部旁问，包含已关闭历史，最近更新的在前。
pub async fn list_by_source(
    conn: &DatabaseConnection,
    source_agent: AgentType,
    source_session_id: &str,
) -> Result<Vec<side_question_session::Model>, DbError> {
    let source_session_id = source_session_id.trim();
    if source_session_id.is_empty() {
        return Ok(Vec::new());
    }
    Ok(side_question_session::Entity::find()
        .filter(
            side_question_session::Column::SourceAgentType
                .eq(source_agent.as_wire().into_owned()),
        )
        .filter(
            side_question_session::Column::SourceSessionId
                .eq(source_session_id.to_string()),
        )
        .order_by_desc(side_question_session::Column::UpdatedAt)
        .order_by_desc(side_question_session::Column::CreatedAt)
        .order_by_desc(side_question_session::Column::Id)
        .all(conn)
        .await?)
}

async fn set_open(
    conn: &DatabaseConnection,
    id: Uuid,
    open: bool,
) -> Result<Option<side_question_session::Model>, DbError> {
    let id = id.to_string();
    let result = side_question_session::Entity::update_many()
        .col_expr(side_question_session::Column::IsOpen, Expr::value(open))
        .col_expr(
            side_question_session::Column::UpdatedAt,
            Expr::value(Utc::now()),
        )
        .filter(side_question_session::Column::Id.eq(id.clone()))
        .exec(conn)
        .await?;
    if result.rows_affected == 0 {
        return Ok(None);
    }
    find_by_id(conn, &id).await
}

/// 手动关闭：只改 `is_open` 和更新时间，不删行，也不触碰原生 session 文件。
pub async fn close(
    conn: &DatabaseConnection,
    id: Uuid,
) -> Result<Option<side_question_session::Model>, DbError> {
    set_open(conn, id, false).await
}

/// 重新打开：把 `is_open` 改回 true，历史记录原样保留。
pub async fn reopen(
    conn: &DatabaseConnection,
    id: Uuid,
) -> Result<Option<side_question_session::Model>, DbError> {
    set_open(conn, id, true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_disk_db, fresh_in_memory_db};
    use crate::models::AgentType;
    use sea_orm::Database;
    use uuid::Uuid;

    const MAIN_SESSION: &str = "main-native-session";
    const MAIN_CWD: &str = "/workspace/project";

    fn side_question(id: u128, native_session_id: &str, title: &str) -> NewSideQuestion {
        NewSideQuestion {
            id: Uuid::from_u128(id),
            source_agent: AgentType::Codex,
            source_session_id: MAIN_SESSION.to_string(),
            native_session_id: native_session_id.to_string(),
            cwd: MAIN_CWD.to_string(),
            pi_session_file: None,
            title: title.to_string(),
        }
    }

    #[tokio::test]
    async fn one_main_session_keeps_multiple_side_questions_including_closed_history() {
        let db = fresh_in_memory_db().await;
        let first_id = Uuid::from_u128(1);
        let second_id = Uuid::from_u128(2);

        let first = create(&db.conn, side_question(1, "side-a", "旁问 A"))
            .await
            .expect("create first side question");
        let second = create(&db.conn, side_question(2, "side-b", "旁问 B"))
            .await
            .expect("create second side question");
        assert!(first.created);
        assert!(second.created);

        let closed = close(&db.conn, second_id)
            .await
            .expect("close second side question")
            .expect("second row exists");
        assert!(!closed.is_open);

        let listed = list_by_source(&db.conn, AgentType::Codex, MAIN_SESSION)
            .await
            .expect("list side questions");
        assert_eq!(listed.len(), 2, "closed history must stay listed");
        assert!(listed
            .iter()
            .any(|row| row.id == first_id.to_string() && row.is_open));
        assert!(listed
            .iter()
            .any(|row| row.id == second_id.to_string() && !row.is_open));
    }

    #[tokio::test]
    async fn closing_only_flips_the_open_state() {
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let native_file = dir.path().join("side-session.jsonl");
        std::fs::write(&native_file, b"{}").expect("write native session file");

        create(&db.conn, side_question(10, "side-c", "旁问 C"))
            .await
            .expect("create");
        let closed = close(&db.conn, Uuid::from_u128(10))
            .await
            .expect("close")
            .expect("row exists");

        assert!(!closed.is_open);
        assert_eq!(closed.title, "旁问 C");
        assert_eq!(closed.source_session_id, MAIN_SESSION);
        assert_eq!(closed.native_session_id, "side-c");
        assert_eq!(closed.cwd, MAIN_CWD);
        assert!(
            native_file.exists(),
            "closing a side question must not delete its native session file"
        );
    }

    #[tokio::test]
    async fn a_closed_side_question_can_be_reopened() {
        let db = fresh_in_memory_db().await;
        create(&db.conn, side_question(20, "side-d", "旁问 D"))
            .await
            .expect("create");
        close(&db.conn, Uuid::from_u128(20))
            .await
            .expect("close")
            .expect("row exists");

        let reopened = reopen(&db.conn, Uuid::from_u128(20))
            .await
            .expect("reopen")
            .expect("row exists");

        assert!(reopened.is_open);
        assert_eq!(reopened.title, "旁问 D");
    }

    #[tokio::test]
    async fn an_identical_retry_returns_the_same_record() {
        let db = fresh_in_memory_db().await;
        let first = create(&db.conn, side_question(30, "side-e", "旁问 E"))
            .await
            .expect("create");
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        let retried = create(&db.conn, side_question(30, "side-e", "旁问 E"))
            .await
            .expect("retry");

        assert!(first.created);
        assert!(!retried.created, "an identical retry must not insert twice");
        assert_eq!(retried.record.id, first.record.id);
        assert_eq!(retried.record.created_at, first.record.created_at);
        assert_eq!(
            list_by_source(&db.conn, AgentType::Codex, MAIN_SESSION)
                .await
                .expect("list")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn a_retry_after_close_does_not_reopen_the_row() {
        let db = fresh_in_memory_db().await;
        create(&db.conn, side_question(40, "side-f", "旁问 F"))
            .await
            .expect("create");
        close(&db.conn, Uuid::from_u128(40))
            .await
            .expect("close")
            .expect("row exists");

        let retried = create(&db.conn, side_question(40, "side-f", "旁问 F"))
            .await
            .expect("retry");

        assert!(!retried.created);
        assert!(
            !retried.record.is_open,
            "create retries must not override a manual close"
        );
    }

    #[tokio::test]
    async fn a_duplicate_id_with_different_content_fails_closed() {
        let db = fresh_in_memory_db().await;
        create(&db.conn, side_question(50, "side-g", "原标题"))
            .await
            .expect("create");

        let error = create(&db.conn, side_question(50, "side-g", "被改过的标题"))
            .await
            .expect_err("duplicate id with different content must be refused");

        assert!(matches!(error, SideQuestionError::Conflict { .. }));
        let listed = list_by_source(&db.conn, AgentType::Codex, MAIN_SESSION)
            .await
            .expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "原标题");
    }

    #[tokio::test]
    async fn the_same_native_session_cannot_be_stored_twice_under_one_source() {
        let db = fresh_in_memory_db().await;
        create(&db.conn, side_question(60, "side-h", "第一次"))
            .await
            .expect("create");

        let error = create(&db.conn, side_question(61, "side-h", "第二次"))
            .await
            .expect_err("the same native session must not be stored twice");

        assert!(matches!(error, SideQuestionError::Conflict { .. }));
        assert_eq!(
            list_by_source(&db.conn, AgentType::Codex, MAIN_SESSION)
                .await
                .expect("list")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn source_agent_is_part_of_the_source_identity() {
        let db = fresh_in_memory_db().await;
        create(&db.conn, side_question(70, "side-i", "Codex 旁问"))
            .await
            .expect("create codex side question");
        let mut claude = side_question(71, "side-j", "Claude 旁问");
        claude.source_agent = AgentType::ClaudeCode;
        create(&db.conn, claude)
            .await
            .expect("create claude side question");

        assert_eq!(
            list_by_source(&db.conn, AgentType::Codex, MAIN_SESSION)
                .await
                .expect("list codex")
                .len(),
            1
        );
        assert_eq!(
            list_by_source(&db.conn, AgentType::ClaudeCode, MAIN_SESSION)
                .await
                .expect("list claude")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn the_optional_pi_session_file_round_trips() {
        let db = fresh_in_memory_db().await;
        let mut input = side_question(80, "side-k", "Pi 旁问");
        input.source_agent = AgentType::Pi;
        input.pi_session_file = Some("/sessions/pi-session.json".to_string());

        let created = create(&db.conn, input).await.expect("create pi side question");

        assert_eq!(
            created.record.pi_session_file.as_deref(),
            Some("/sessions/pi-session.json")
        );
    }

    #[tokio::test]
    async fn empty_metadata_is_rejected_before_writing() {
        let db = fresh_in_memory_db().await;
        for mutate in [
            |input: &mut NewSideQuestion| input.source_session_id.clear(),
            |input: &mut NewSideQuestion| input.native_session_id.clear(),
            |input: &mut NewSideQuestion| input.cwd.clear(),
            |input: &mut NewSideQuestion| input.title = "   ".to_string(),
        ] {
            let mut input = side_question(90, "side-l", "有效标题");
            mutate(&mut input);
            let error = create(&db.conn, input)
                .await
                .expect_err("empty metadata must be refused");
            assert!(matches!(error, SideQuestionError::Validation(_)));
        }
        assert!(get(&db.conn, Uuid::from_u128(90))
            .await
            .expect("get")
            .is_none());
    }

    #[tokio::test]
    async fn records_survive_reopening_the_database() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = fresh_disk_db(dir.path()).await;
        create(&db.conn, side_question(100, "side-m", "重启后还在"))
            .await
            .expect("create");
        close(&db.conn, Uuid::from_u128(100))
            .await
            .expect("close")
            .expect("row exists");
        db.conn.close().await.expect("close database");

        let path = dir.path().join("source.db");
        let conn = Database::connect(format!("sqlite:{}?mode=rwc", path.to_string_lossy()))
            .await
            .expect("reopen database");
        let listed = list_by_source(&conn, AgentType::Codex, MAIN_SESSION)
            .await
            .expect("list after restart");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "重启后还在");
        assert!(!listed[0].is_open);
        conn.close().await.expect("close reopened database");
    }
}
