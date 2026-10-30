use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 输入框收藏：一个跨会话、跨项目复用的提示词库。
        //
        // 与"草稿"（每会话一份、存浏览器 localStorage、从不保存附件）是两条
        // 互不相干的通道，所以它有自己的表，而不是给草稿加一份副本。
        //
        // `doc_json` 存输入框的富文本文档快照，用于原样回填；`text` 只是它的
        // 纯文本影子，供列表预览与将来搜索用。`asset_bytes` 是这条收藏随附
        // 附件副本的总字节数——容量淘汰要按它算，而不去每次 stat 磁盘。
        manager
            .create_table(
                Table::create()
                    .table(PromptStash::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(PromptStash::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(PromptStash::Text).text().not_null())
                    .col(ColumnDef::new(PromptStash::DocJson).text().not_null())
                    .col(
                        ColumnDef::new(PromptStash::AttachmentsJson)
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    // 首行预览在保存时算好：列表不该每次都对全文做截断。
                    .col(ColumnDef::new(PromptStash::Preview).text().not_null())
                    // 正文 + 附件的内容指纹，用来去重。唯一，因为"同一份东西"
                    // 在收藏库里只该有一条。
                    .col(ColumnDef::new(PromptStash::Fingerprint).text().not_null())
                    .col(
                        ColumnDef::new(PromptStash::AssetBytes)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(PromptStash::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(PromptStash::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_prompt_stash_fingerprint")
                    .table(PromptStash::Table)
                    .col(PromptStash::Fingerprint)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // 列表按"最近用过"倒序，淘汰也是按这个顺序取最旧的一条。
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_prompt_stash_updated_at")
                    .table(PromptStash::Table)
                    .col(PromptStash::UpdatedAt)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(PromptStash::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum PromptStash {
    Table,
    Id,
    Text,
    DocJson,
    AttachmentsJson,
    Preview,
    Fingerprint,
    AssetBytes,
    CreatedAt,
    UpdatedAt,
}

#[cfg(test)]
mod tests {
    use sea_orm_migration::sea_orm::{ConnectionTrait, Database, DbBackend, Statement};
    use sea_orm_migration::SchemaManager;

    use super::*;

    /// 指纹唯一是这个功能的支柱：同一份东西在库里只该有一条，否则"去重后
    /// 置顶"就退化成"每次都新增一条"。
    #[tokio::test]
    async fn the_fingerprint_is_unique() {
        let conn = Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        Migration
            .up(&SchemaManager::new(&conn))
            .await
            .expect("run migration up");

        let insert = |id: i32| {
            format!(
                "INSERT INTO prompt_stash \
                 (id, text, doc_json, attachments_json, preview, fingerprint, asset_bytes, created_at, updated_at) \
                 VALUES ({id}, 't', '{{}}', '[]', 'p', 'same', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
            )
        };

        conn.execute(Statement::from_string(DbBackend::Sqlite, insert(1)))
            .await
            .expect("first row");
        let second = conn
            .execute(Statement::from_string(DbBackend::Sqlite, insert(2)))
            .await;

        assert!(second.is_err(), "a duplicate fingerprint must be refused");
    }
}
