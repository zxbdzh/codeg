use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared(
            "CREATE TABLE ai_tag_batch (id TEXT PRIMARY KEY NOT NULL, conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE, payload TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, is_current INTEGER NOT NULL DEFAULT 1, leased_until INTEGER, leases TEXT NOT NULL DEFAULT '{}');
             CREATE INDEX ai_tag_batch_conversation ON ai_tag_batch(conversation_id, created_at);
             CREATE UNIQUE INDEX ai_tag_batch_current ON ai_tag_batch(conversation_id) WHERE is_current = 1;
             CREATE TABLE ai_tag_ignored (conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE, identity TEXT NOT NULL, tag_id INTEGER, name TEXT NOT NULL, folder_id INTEGER, PRIMARY KEY(conversation_id, identity));
             CREATE TABLE ai_tag_job (conversation_id INTEGER PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE, target TEXT NOT NULL, processed TEXT NOT NULL DEFAULT '', cache_key TEXT NOT NULL DEFAULT '', lease_target TEXT, last_start INTEGER, due_at INTEGER, retry_count INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER, error TEXT);
             CREATE TRIGGER ai_tag_cleanup_deleted_conversation AFTER UPDATE OF deleted_at ON conversation WHEN NEW.deleted_at IS NOT NULL BEGIN
                 DELETE FROM ai_tag_job WHERE conversation_id = NEW.id;
                 DELETE FROM ai_tag_batch WHERE conversation_id = NEW.id;
                 DELETE FROM ai_tag_ignored WHERE conversation_id = NEW.id;
             END;
             CREATE TRIGGER ai_tag_update_ignored_label AFTER UPDATE OF name ON conversation_tag BEGIN
                 UPDATE ai_tag_ignored SET name = NEW.name WHERE tag_id = NEW.id;
             END;"
        ).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("DROP TRIGGER ai_tag_update_ignored_label; DROP TRIGGER ai_tag_cleanup_deleted_conversation; DROP TABLE ai_tag_job; DROP TABLE ai_tag_ignored; DROP TABLE ai_tag_batch;").await?;
        Ok(())
    }
}
