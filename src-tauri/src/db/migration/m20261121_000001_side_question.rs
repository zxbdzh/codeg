use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 独立旁问的持久化元数据。一条主会话可以有多条旁问；来源由
        // agent 类型 + 主原生 session ID 共同确定，旁问自己的原生 session
        // 再作为同一来源内的唯一标识。
        //
        // 这张表只存会话定位信息，不存 token、Cookie、API key 或消息正文。
        // 关闭旁问只改 `is_open`，不删除行，也不碰任何原生 session 文件。
        manager
            .create_table(
                Table::create()
                    .table(SideQuestionSession::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SideQuestionSession::Id)
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SideQuestionSession::SourceAgentType)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SideQuestionSession::SourceSessionId)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SideQuestionSession::NativeSessionId)
                            .text()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SideQuestionSession::Cwd).text().not_null())
                    // Pi 的旁问可能还有独立的 session 文件；其他 agent 为空。
                    .col(
                        ColumnDef::new(SideQuestionSession::PiSessionFile)
                            .text()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(SideQuestionSession::Title)
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SideQuestionSession::IsOpen)
                            .boolean()
                            .not_null()
                            .default(true),
                    )
                    .col(
                        ColumnDef::new(SideQuestionSession::CreatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SideQuestionSession::UpdatedAt)
                            .timestamp_with_time_zone()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // 主会话的旁问列表按最近更新倒序，包含已关闭历史。
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_side_question_source_updated")
                    .table(SideQuestionSession::Table)
                    .col(SideQuestionSession::SourceAgentType)
                    .col(SideQuestionSession::SourceSessionId)
                    .col(SideQuestionSession::UpdatedAt)
                    .to_owned(),
            )
            .await?;

        // 同一个来源下，一个旁问原生 session 只能有一条记录；并发插入时由
        // 唯一索引兜底，service 再把它翻译成幂等或 fail-closed 冲突。
        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_side_question_source_native")
                    .table(SideQuestionSession::Table)
                    .col(SideQuestionSession::SourceAgentType)
                    .col(SideQuestionSession::SourceSessionId)
                    .col(SideQuestionSession::NativeSessionId)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SideQuestionSession::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum SideQuestionSession {
    Table,
    Id,
    SourceAgentType,
    SourceSessionId,
    NativeSessionId,
    Cwd,
    PiSessionFile,
    Title,
    IsOpen,
    CreatedAt,
    UpdatedAt,
}
