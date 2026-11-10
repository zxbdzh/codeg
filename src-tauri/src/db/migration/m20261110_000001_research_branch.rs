use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(ResearchBranch::Table)
                    .col(
                        ColumnDef::new(ResearchBranch::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ResearchBranch::RequestId)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(
                        ColumnDef::new(ResearchBranch::SourceConversationId)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ResearchBranch::BranchConversationId)
                            .integer()
                            .not_null()
                            .unique_key(),
                    )
                    .col(
                        ColumnDef::new(ResearchBranch::SourceSessionId)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ResearchBranch::BranchSessionId)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(ResearchBranch::SourceTurnId).text())
                    .col(ColumnDef::new(ResearchBranch::Boundary).string().not_null())
                    .col(ColumnDef::new(ResearchBranch::Summary).text().not_null())
                    .col(
                        ColumnDef::new(ResearchBranch::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    // 保留已删除关系用于幂等判定；绝不把已删除请求复活成新旁支。
                    .foreign_key(
                        ForeignKey::create()
                            .from(ResearchBranch::Table, ResearchBranch::SourceConversationId)
                            .to(Conversation::Table, Conversation::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(ResearchBranch::Table, ResearchBranch::BranchConversationId)
                            .to(Conversation::Table, Conversation::Id),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_research_branch_source")
                    .table(ResearchBranch::Table)
                    .col(ResearchBranch::SourceConversationId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(ResearchBranch::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum ResearchBranch {
    Table,
    Id,
    RequestId,
    SourceConversationId,
    BranchConversationId,
    SourceSessionId,
    BranchSessionId,
    SourceTurnId,
    Boundary,
    Summary,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    Id,
}
