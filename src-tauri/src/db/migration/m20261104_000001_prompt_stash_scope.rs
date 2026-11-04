use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 旧收藏无法可靠判断来自哪个对话，保留 NULL，仅在设置管理页展示。
        manager
            .alter_table(
                Table::alter()
                    .table(PromptStash::Table)
                    .add_column(ColumnDef::new(PromptStash::ScopeKey).text())
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .name("idx_prompt_stash_fingerprint")
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_prompt_stash_scope_fingerprint")
                    .table(PromptStash::Table)
                    .col(PromptStash::ScopeKey)
                    .col(PromptStash::Fingerprint)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 不合并不同对话的同内容收藏；回滚若会丢数据则由迁移框架报告失败。
        manager
            .drop_index(
                Index::drop()
                    .name("idx_prompt_stash_scope_fingerprint")
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_prompt_stash_fingerprint")
                    .table(PromptStash::Table)
                    .col(PromptStash::Fingerprint)
                    .unique()
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(PromptStash::Table)
                    .drop_column(PromptStash::ScopeKey)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum PromptStash {
    Table,
    ScopeKey,
    Fingerprint,
}
