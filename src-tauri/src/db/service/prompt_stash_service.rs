//! 输入框收藏的存取与容量约束。
//!
//! 这一层只管**数据与规则**：一条收藏怎么去重、库满了淘汰谁、多大算太大。
//! 附件副本的复制与删除留给调用方——那些是文件系统的活，而淘汰时"删哪几条
//! 的附件目录"由这里通过返回被淘汰的行来点名。

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait,
    QueryFilter, QueryOrder, Set,
};
use sha2::{Digest, Sha256};

use crate::db::entities::prompt_stash;
use crate::db::error::DbError;

/// 收藏库最多留多少条。条数控体验，字节数控磁盘。
pub const MAX_STASH_ENTRIES: usize = 50;

/// 单条收藏随附附件的字节上限。
pub const MAX_ITEM_ASSET_BYTES: i64 = 10 * 1024 * 1024;

/// 整个收藏库的附件总字节上限。超了就从最旧开始淘汰。
pub const MAX_TOTAL_ASSET_BYTES: i64 = 200 * 1024 * 1024;

/// 首行预览的长度上限。
pub const PREVIEW_MAX_CHARS: usize = 80;

/// 一次保存要写进去的东西。`preview` 与 `fingerprint` 由服务层算，不由调用方给：
/// 它们是派生值，让调用方各自算一遍迟早会算出两种口径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewStashItem {
    pub scope_key: Option<String>,
    pub text: String,
    pub doc_json: String,
    pub attachments_json: String,
    /// 随附附件副本的总字节数。
    pub asset_bytes: i64,
}

/// 保存为什么失败。
#[derive(Debug, thiserror::Error)]
pub enum StashError {
    #[error("stash item assets {actual} bytes exceed the per-item limit {limit}")]
    ItemTooLarge { actual: i64, limit: i64 },
    #[error(transparent)]
    Db(#[from] DbError),
}

/// 一次保存的结果。`evicted` 是必须被删掉附件副本的那些行——调用方据此清理
/// 磁盘，否则收藏库会把磁盘慢慢占满。
#[derive(Debug, Clone)]
pub struct SaveOutcome {
    pub entry: prompt_stash::Model,
    /// false 表示命中同指纹的旧条目，只把它置顶了。
    pub created: bool,
    pub evicted: Vec<prompt_stash::Model>,
}

/// 取正文的第一行做预览。全空时给空串，让列表渲染成一条占位。
pub fn preview_of(text: &str) -> String {
    let first_line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    first_line.chars().take(PREVIEW_MAX_CHARS).collect()
}

/// 正文 + 附件的指纹。中间插一个 `\0` 作分隔符，免得 `("ab","c")` 与
/// `("a","bc")` 撞成同一个指纹。
pub fn fingerprint_of(text: &str, attachments_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hasher.update([0u8]);
    hasher.update(attachments_json.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 保存一条收藏。
///
/// 顺序很重要：先校验单条体积（省得白写一次），再去重，最后才淘汰——淘汰必须
/// 在写入之后算，否则刚存的这条可能被自己挤掉。
pub async fn save(
    conn: &DatabaseConnection,
    item: NewStashItem,
) -> Result<SaveOutcome, StashError> {
    if item.asset_bytes > MAX_ITEM_ASSET_BYTES {
        return Err(StashError::ItemTooLarge {
            actual: item.asset_bytes,
            limit: MAX_ITEM_ASSET_BYTES,
        });
    }

    let fingerprint = fingerprint_of(&item.text, &item.attachments_json);
    let preview = preview_of(&item.text);
    let now = Utc::now();

    let existing = prompt_stash::Entity::find()
        .filter(prompt_stash::Column::Fingerprint.eq(fingerprint.clone()))
        .filter(match &item.scope_key {
            Some(scope) => prompt_stash::Column::ScopeKey.eq(scope.clone()),
            None => prompt_stash::Column::ScopeKey.is_null(),
        })
        .one(conn)
        .await
        .map_err(DbError::from)?;

    let (entry, created) = match existing {
        Some(row) => {
            // 同一份东西再次收藏：只刷新内容与时间，把它顶到列表最前。
            let mut active: prompt_stash::ActiveModel = row.clone().into();
            active.text = Set(item.text.clone());
            active.doc_json = Set(item.doc_json.clone());
            active.attachments_json = Set(item.attachments_json.clone());
            active.preview = Set(preview.clone());
            active.asset_bytes = Set(item.asset_bytes);
            active.updated_at = Set(now);
            let updated = active.update(conn).await.map_err(DbError::from)?;
            (updated, false)
        }
        None => {
            let inserted = prompt_stash::Entity::insert(prompt_stash::ActiveModel {
                id: NotSet,
                scope_key: Set(item.scope_key.clone()),
                text: Set(item.text.clone()),
                doc_json: Set(item.doc_json.clone()),
                attachments_json: Set(item.attachments_json.clone()),
                preview: Set(preview.clone()),
                fingerprint: Set(fingerprint),
                asset_bytes: Set(item.asset_bytes),
                created_at: Set(now),
                updated_at: Set(now),
            })
            .exec(conn)
            .await
            .map_err(DbError::from)?;
            let row = prompt_stash::Entity::find_by_id(inserted.last_insert_id)
                .one(conn)
                .await
                .map_err(DbError::from)?
                .ok_or_else(|| {
                    DbError::NotFound("prompt_stash row vanished after insert".into())
                })?;
            (row, true)
        }
    };

    let evicted = trim_to_limits(conn).await?;

    Ok(SaveOutcome {
        entry,
        created,
        evicted,
    })
}

/// 列表：最近用过的在前。恢复与再次保存都会把一条顶上来，所以这个顺序天然
/// 就是"我最近关心的模板"。
pub async fn list(conn: &DatabaseConnection) -> Result<Vec<prompt_stash::Model>, DbError> {
    Ok(prompt_stash::Entity::find()
        .order_by_desc(prompt_stash::Column::UpdatedAt)
        .order_by_desc(prompt_stash::Column::Id)
        .all(conn)
        .await?)
}

pub async fn list_scope(
    conn: &DatabaseConnection,
    scope: &str,
) -> Result<Vec<prompt_stash::Model>, DbError> {
    Ok(prompt_stash::Entity::find()
        .filter(prompt_stash::Column::ScopeKey.eq(scope))
        .order_by_desc(prompt_stash::Column::UpdatedAt)
        .order_by_desc(prompt_stash::Column::Id)
        .all(conn)
        .await?)
}

pub async fn get(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<prompt_stash::Model>, DbError> {
    Ok(prompt_stash::Entity::find_by_id(id).one(conn).await?)
}

/// 恢复一条收藏时调用：**不删除**，只把它顶到最前。同一个模板要能反复用，
/// 这是与参考实现（恢复即删除）最本质的差别。
pub async fn touch(conn: &DatabaseConnection, id: i32) -> Result<bool, DbError> {
    let result = prompt_stash::Entity::update_many()
        .col_expr(
            prompt_stash::Column::UpdatedAt,
            sea_orm::sea_query::Expr::value(Utc::now()),
        )
        .filter(prompt_stash::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(result.rows_affected > 0)
}

/// 删掉一条，返回被删的行，好让调用方清理它的附件目录。
pub async fn remove(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<prompt_stash::Model>, DbError> {
    let Some(row) = get(conn, id).await? else {
        return Ok(None);
    };
    prompt_stash::Entity::delete_many()
        .filter(prompt_stash::Column::Id.eq(id))
        .exec(conn)
        .await?;
    Ok(Some(row))
}

/// 把收藏库压回上限内，返回被淘汰的行（最旧的先被淘汰）。
async fn trim_to_limits(conn: &DatabaseConnection) -> Result<Vec<prompt_stash::Model>, DbError> {
    let mut evicted: Vec<prompt_stash::Model> = Vec::new();

    loop {
        let rows = prompt_stash::Entity::find()
            .order_by_asc(prompt_stash::Column::UpdatedAt)
            .order_by_asc(prompt_stash::Column::Id)
            .all(conn)
            .await?;
        if rows.is_empty() {
            break;
        }

        let total_bytes: i64 = rows.iter().map(|row| row.asset_bytes).sum();
        let over_count = rows.len() > MAX_STASH_ENTRIES;
        let over_bytes = total_bytes > MAX_TOTAL_ASSET_BYTES;
        if !over_count && !over_bytes {
            break;
        }

        // 一次只淘汰最旧的一条：条数与字节两条约束可能同时成立，逐条推进能
        // 保证每次淘汰的都是"当前最旧的"，也不会一口气删掉刚存进来的东西。
        let oldest = rows[0].clone();
        prompt_stash::Entity::delete_many()
            .filter(prompt_stash::Column::Id.eq(oldest.id))
            .exec(conn)
            .await?;
        evicted.push(oldest);
    }

    Ok(evicted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    fn item(text: &str) -> NewStashItem {
        NewStashItem {
            scope_key: Some("conv:1".to_string()),
            text: text.to_string(),
            doc_json: format!(r#"{{"type":"doc","text":"{text}"}}"#),
            attachments_json: "[]".to_string(),
            asset_bytes: 0,
        }
    }

    #[tokio::test]
    async fn a_saved_item_comes_back_in_the_list() {
        let db = fresh_in_memory_db().await;

        let outcome = save(&db.conn, item("先跑一遍 lint\n再跑测试"))
            .await
            .expect("save");
        let listed = list(&db.conn).await.expect("list");

        assert!(outcome.created);
        assert!(outcome.evicted.is_empty());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].preview, "先跑一遍 lint");
        assert_eq!(listed[0].text, "先跑一遍 lint\n再跑测试");
    }

    #[tokio::test]
    async fn the_same_content_is_reused_and_pushed_to_the_top() {
        let db = fresh_in_memory_db().await;
        save(&db.conn, item("模板 A")).await.expect("save a");
        save(&db.conn, item("模板 B")).await.expect("save b");

        let second = save(&db.conn, item("模板 A")).await.expect("save a again");
        let listed = list(&db.conn).await.expect("list");

        assert!(
            !second.created,
            "the same content must not create a second row"
        );
        assert_eq!(listed.len(), 2);
        assert_eq!(
            listed[0].text, "模板 A",
            "the reused entry moves to the top"
        );
    }

    #[tokio::test]
    async fn attachments_are_part_of_the_fingerprint() {
        let db = fresh_in_memory_db().await;
        let with_image = NewStashItem {
            attachments_json: r#"[{"kind":"image","path":"a.png"}]"#.to_string(),
            ..item("同样的文字")
        };

        save(&db.conn, item("同样的文字"))
            .await
            .expect("save text only");
        let second = save(&db.conn, with_image).await.expect("save with image");

        assert!(
            second.created,
            "a different attachment set is a different entry"
        );
        assert_eq!(list(&db.conn).await.expect("list").len(), 2);
    }

    #[tokio::test]
    async fn an_item_over_the_per_item_limit_is_refused_and_nothing_is_written() {
        let db = fresh_in_memory_db().await;
        let too_big = NewStashItem {
            asset_bytes: MAX_ITEM_ASSET_BYTES + 1,
            ..item("带一张超大图")
        };

        let error = save(&db.conn, too_big).await.expect_err("must refuse");

        assert!(
            matches!(error, StashError::ItemTooLarge { .. }),
            "expected ItemTooLarge, got {error:?}"
        );
        assert!(list(&db.conn).await.expect("list").is_empty());
    }

    #[tokio::test]
    async fn the_library_keeps_at_most_fifty_entries_and_evicts_the_oldest() {
        let db = fresh_in_memory_db().await;

        for index in 0..MAX_STASH_ENTRIES {
            save(&db.conn, item(&format!("模板 {index}")))
                .await
                .expect("save");
        }
        let outcome = save(&db.conn, item("模板 50")).await.expect("save 51st");
        let listed = list(&db.conn).await.expect("list");

        assert_eq!(listed.len(), MAX_STASH_ENTRIES);
        assert_eq!(outcome.evicted.len(), 1, "exactly one entry makes room");
        assert_eq!(outcome.evicted[0].text, "模板 0", "the oldest one goes");
        assert!(!listed.iter().any(|row| row.preview == "模板 0"));
    }

    #[tokio::test]
    async fn the_total_asset_budget_evicts_until_it_fits() {
        let db = fresh_in_memory_db().await;
        // 每条都贴着单条上限（10MB）。存满 21 条就是 210MB，超过 200MB 的总预算。
        let per_item = MAX_ITEM_ASSET_BYTES;
        for index in 0..20 {
            save(
                &db.conn,
                NewStashItem {
                    asset_bytes: per_item,
                    ..item(&format!("大字附件 {index}"))
                },
            )
            .await
            .expect("save under budget");
        }

        let outcome = save(
            &db.conn,
            NewStashItem {
                asset_bytes: per_item,
                ..item("把总量顶过线的那一条")
            },
        )
        .await
        .expect("save over budget");
        let listed = list(&db.conn).await.expect("list");
        let total: i64 = listed.iter().map(|row| row.asset_bytes).sum();

        assert_eq!(outcome.evicted.len(), 1);
        assert_eq!(outcome.evicted[0].preview, "大字附件 0");
        assert!(total <= MAX_TOTAL_ASSET_BYTES);
        assert_eq!(listed.len(), 20);
    }

    #[tokio::test]
    async fn restoring_an_entry_keeps_it_and_brings_it_forward() {
        let db = fresh_in_memory_db().await;
        let older = save(&db.conn, item("旧模板")).await.expect("save older");
        save(&db.conn, item("新模板")).await.expect("save newer");

        let restored = touch(&db.conn, older.entry.id).await.expect("touch");
        let listed = list(&db.conn).await.expect("list");

        assert!(restored);
        assert_eq!(listed.len(), 2, "restoring must not delete anything");
        assert_eq!(listed[0].text, "旧模板");
    }

    #[tokio::test]
    async fn removing_an_entry_hands_back_the_row_for_asset_cleanup() {
        let db = fresh_in_memory_db().await;
        let saved = save(&db.conn, item("要被删掉的模板")).await.expect("save");

        let removed = remove(&db.conn, saved.entry.id).await.expect("remove");

        assert_eq!(
            removed.map(|row| row.preview),
            Some("要被删掉的模板".to_string())
        );
        assert!(list(&db.conn).await.expect("list").is_empty());
        assert_eq!(remove(&db.conn, 424242).await.expect("idempotent"), None);
    }

    #[test]
    fn the_preview_is_the_first_non_empty_line_cut_short() {
        assert_eq!(preview_of("\n\n  第一行  \n第二行"), "第一行");
        assert_eq!(preview_of(""), "");
        assert_eq!(
            preview_of(&"字".repeat(200)).chars().count(),
            PREVIEW_MAX_CHARS
        );
    }

    #[test]
    fn the_fingerprint_separates_text_from_attachments() {
        assert_eq!(
            fingerprint_of("ab", "c"),
            fingerprint_of("ab", "c"),
            "same input, same fingerprint"
        );
        assert_ne!(
            fingerprint_of("ab", "c"),
            fingerprint_of("a", "bc"),
            "the separator must keep the two halves from bleeding together"
        );
    }
}
