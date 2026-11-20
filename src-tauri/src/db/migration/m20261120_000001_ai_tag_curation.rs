use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE conversation_tag ADD COLUMN dimension TEXT CHECK (dimension IN ('theme', 'action'));
                 ALTER TABLE conversation_tag ADD COLUMN is_protected INTEGER NOT NULL DEFAULT 1;
                 ALTER TABLE conversation_tag ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';
                 CREATE TABLE ai_tag_curation (
                    id TEXT PRIMARY KEY NOT NULL,
                    state TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    lease_until INTEGER,
                    lease_token TEXT,
                    scanned INTEGER NOT NULL DEFAULT 0,
                    total INTEGER NOT NULL DEFAULT 0,
                    payload TEXT,
                    error TEXT,
                    journal TEXT
                 );
                 CREATE UNIQUE INDEX ai_tag_curation_active ON ai_tag_curation((1))
                    WHERE state IN ('queued', 'running', 'review', 'failed');",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DROP TABLE ai_tag_curation;
                 ALTER TABLE conversation_tag DROP COLUMN aliases_json;
                 ALTER TABLE conversation_tag DROP COLUMN is_protected;
                 ALTER TABLE conversation_tag DROP COLUMN dimension;",
            )
            .await?;
        Ok(())
    }
}
