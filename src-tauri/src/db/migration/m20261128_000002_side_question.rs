use sea_orm::TransactionTrait;
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        // SeaORM 在 SQLite 上不把迁移包进事务（Postgres 才包）；显式包裹，
        // 避免中途退出留下半个 schema，重启重跑时因列已存在而卡住启动。
        let txn = db.begin().await?;
        txn.execute_unprepared("ALTER TABLE conversation ADD COLUMN readonly_ask_policy TEXT")
            .await?;
        txn.execute_unprepared("ALTER TABLE conversation ADD COLUMN readonly_ask_request_id TEXT")
            .await?;
        txn.execute_unprepared(
            "CREATE UNIQUE INDEX idx_readonly_ask_request ON conversation(readonly_ask_request_id)",
        )
        .await?;
        txn.commit().await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        let txn = db.begin().await?;
        txn.execute_unprepared("DROP INDEX idx_readonly_ask_request")
            .await?;
        txn.execute_unprepared("ALTER TABLE conversation DROP COLUMN readonly_ask_request_id")
            .await?;
        txn.execute_unprepared("ALTER TABLE conversation DROP COLUMN readonly_ask_policy")
            .await?;
        txn.commit().await?;
        Ok(())
    }
}
