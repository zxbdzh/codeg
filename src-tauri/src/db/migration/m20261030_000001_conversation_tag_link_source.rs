use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 谁提议了这条标签关联：`user`（人自己勾的）或 `ai`（AI 建议、人确认）。
        // 有了这个区分，"撤销 AI 打的那一批"才有可能。
        //
        // 默认值 `user` 不是占位符：这一列出现之前的所有关联都是人贴的，默认值
        // 陈述的是历史事实，而不是对历史的猜测。
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationTagLink::Table)
                    .add_column(
                        ColumnDef::new(ConversationTagLink::Source)
                            .text()
                            .not_null()
                            .default("user"),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationTagLink::Table)
                    .drop_column(ConversationTagLink::Source)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ConversationTagLink {
    Table,
    Source,
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};

    /// 这一列出现之前的关联全是人贴的，迁移必须把它们回填成 `user`。
    #[tokio::test]
    async fn up_backfills_preexisting_links_as_user() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        conn.execute_unprepared(
            "CREATE TABLE conversation_tag_link (\
                conversation_id INTEGER NOT NULL, \
                tag_id INTEGER NOT NULL, \
                created_at TEXT NOT NULL, \
                PRIMARY KEY (conversation_id, tag_id))",
        )
        .await
        .expect("create stub table");
        conn.execute_unprepared(
            "INSERT INTO conversation_tag_link (conversation_id, tag_id, created_at) \
             VALUES (1, 2, '2026-01-01T00:00:00Z')",
        )
        .await
        .expect("insert legacy link");

        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        let row = conn
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT source FROM conversation_tag_link".to_owned(),
            ))
            .await
            .expect("query row")
            .expect("one row");

        let source: String = row.try_get("", "source").expect("source column");
        assert_eq!(source, "user");
    }
}
