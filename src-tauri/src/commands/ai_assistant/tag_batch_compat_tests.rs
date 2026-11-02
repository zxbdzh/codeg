use super::*;
use crate::ai::tag_store::{self, TagCandidate};
use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use crate::models::agent::AgentType;

#[tokio::test]
async fn legacy_manual_suggestions_reuse_pending_candidates_and_respect_ignored_choices() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/legacy-tag-batch").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let tag = conversation_tag_service::create_tag(&db.conn, None, "MCP", "#123456")
        .await
        .unwrap();
    let mut existing = TagCandidate::new_tag("MCP", None, "topic");
    existing.tag_ids = vec![tag.id];
    let batch = tag_store::save_batch(
        &db.conn,
        conversation,
        "input",
        "v1",
        vec![existing, TagCandidate::new_tag("Avatar", None, "topic")],
        1000,
    )
    .await
    .unwrap();
    tag_store::ignore_candidate(&db.conn, conversation, &batch.id, 0, None)
        .await
        .unwrap();
    let suggestions = suggest_conversation_tags_core(&db, &crate::acp::manager::ConnectionManager::new(), conversation, false)
        .await
        .unwrap();
    assert!(suggestions.tags.is_empty());
    assert_eq!(
        suggestions
            .new_tags
            .iter()
            .map(|tag| tag.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Avatar"]
    );
    assert!(
        crate::db::service::conversation_service::get_by_id(&db.conn, conversation)
            .await
            .unwrap()
            .tag_ids
            .is_empty()
    );
}
