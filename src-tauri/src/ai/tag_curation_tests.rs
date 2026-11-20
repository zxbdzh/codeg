use async_trait::async_trait;
use serde_json::json;

use crate::ai::{
    client::AiError, fake::FakeAiClient, settings, tag_curation, tag_jobs::ContextSource,
};
use crate::db::error::DbError;
use crate::db::service::{
    conversation_service, conversation_tag_service as tags, model_provider_service,
};
use crate::db::test_helpers::{fresh_disk_db, seed_conversation, seed_folder};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;

struct TranscriptFixture;

#[async_trait]
impl ContextSource for TranscriptFixture {
    async fn read(&self, _: i32) -> Result<String, DbError> {
        Ok("User: 修正浏览器的 DPI 缩放".into())
    }
}

async fn review(db: &AppDatabase, changes: serde_json::Value) -> tag_curation::Job {
    let client = FakeAiClient::replying(&json!({ "changes": changes }).to_string());
    let job = tag_curation::start(&db.conn).await.unwrap();
    tag_curation::generate(&db.conn, &client, &TranscriptFixture, &job.id)
        .await
        .unwrap();
    let current = tag_curation::status(&db.conn).await.unwrap().unwrap();
    assert_eq!(current.state, tag_curation::State::Review);
    current
}

fn selected(index: usize) -> tag_curation::Choice {
    tag_curation::Choice {
        index,
        ..Default::default()
    }
}

async fn configure(db: &AppDatabase) {
    let provider = model_provider_service::create(
        &db.conn,
        "Test provider".into(),
        "https://example.invalid/v1".into(),
        "fake-key".into(),
        "codex".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &settings::AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "test-model".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn generates_a_durable_preview_without_changing_tags_or_links() {
    let directory = tempfile::tempdir().unwrap();
    let db = fresh_disk_db(directory.path()).await;
    configure(&db).await;
    let folder = seed_folder(&db, "/tmp/tag-curation-project").await;
    let conversation_id = seed_conversation(&db, folder, AgentType::Codex).await;
    conversation_service::update_title(&db.conn, conversation_id, "内置浏览器".into())
        .await
        .unwrap();
    let tag = tags::create_tag(&db.conn, None, "浏览器旧标签", "#123456")
        .await
        .unwrap();
    tags::update_conversation_tags(&db.conn, conversation_id, &[tag.id], &[])
        .await
        .unwrap();

    let client = FakeAiClient::replying(
        &json!({"changes":[{"kind":"update","tagId":tag.id,"dimension":"action"}]}).to_string(),
    );
    let job = tag_curation::start(&db.conn).await.unwrap();
    tag_curation::generate(&db.conn, &client, &TranscriptFixture, &job.id)
        .await
        .unwrap();
    db.conn.close().await.unwrap();

    let reopened = fresh_disk_db(directory.path()).await;
    let preview = tag_curation::status(&reopened.conn).await.unwrap().unwrap();
    assert_eq!(preview.id, job.id);
    assert_eq!(preview.state, tag_curation::State::Review);
    assert_eq!(preview.items.len(), 1);
    assert_eq!(
        tags::list_tags(&reopened.conn).await.unwrap(),
        vec![tag.clone()]
    );
    assert_eq!(
        conversation_service::get_by_id(&reopened.conn, conversation_id)
            .await
            .unwrap()
            .tag_ids,
        vec![tag.id],
    );
    assert!(client.prompts()[0].contains("内置浏览器"));
    assert!(client.prompts()[0].contains("修正浏览器的 DPI 缩放"));
    assert!(!client.prompts()[0].contains("/tmp/tag-curation-project"));
}

#[tokio::test]
async fn creates_and_applies_tag_links_only_within_their_model_reply() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    configure(&db).await;
    let folder = seed_folder(&db, "/tmp/tag-curation-create").await;
    let first = seed_conversation(&db, folder, AgentType::Codex).await;
    for _ in 0..7 {
        seed_conversation(&db, folder, AgentType::Codex).await;
    }
    let next_batch = seed_conversation(&db, folder, AgentType::Codex).await;
    let client = FakeAiClient::with_replies(vec![
        Ok(json!({"changes": [
            {"kind":"create","tagId":-1,"name":"部署","color":"#123456","dimension":"action"},
            {"kind":"add","tagId":-1,"conversationId":first},
        ]})
        .to_string()),
        Ok(json!({"changes": [
            {"kind":"add","tagId":-1,"conversationId":next_batch},
        ]})
        .to_string()),
    ]);
    let job = tag_curation::start(&db.conn).await.unwrap();
    tag_curation::generate(&db.conn, &client, &TranscriptFixture, &job.id)
        .await
        .unwrap();
    let preview = tag_curation::status(&db.conn).await.unwrap().unwrap();
    assert_eq!(preview.state, tag_curation::State::Review);
    assert_eq!(client.request_count(), 2);
    assert_eq!(preview.items.len(), 2);
    assert!(tags::list_tags(&db.conn).await.unwrap().is_empty());

    tag_curation::apply(&db.conn, &job.id, vec![selected(0), selected(1)])
        .await
        .unwrap();
    let saved = tags::list_tags(&db.conn).await.unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].dimension, Some(tag_curation::Dimension::Action));
    assert!(!saved[0].is_protected);
    assert_eq!(
        conversation_service::get_by_id(&db.conn, first)
            .await
            .unwrap()
            .tag_ids,
        vec![saved[0].id],
    );
    assert!(conversation_service::get_by_id(&db.conn, next_batch)
        .await
        .unwrap()
        .tag_ids
        .is_empty());
}

#[tokio::test]
async fn applies_only_the_selected_edit_and_retains_a_concurrent_change() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    configure(&db).await;
    let chosen = tags::create_tag(&db.conn, None, "浏览器", "#123456")
        .await
        .unwrap();
    let skipped = tags::create_tag(&db.conn, None, "更新", "#654321")
        .await
        .unwrap();
    tag_curation::set_protection(&db.conn, vec![chosen.id], false)
        .await
        .unwrap();
    let client = FakeAiClient::replying(
        &json!({"changes":[
            {"kind":"update","tagId":chosen.id,"dimension":"action"},
            {"kind":"update","tagId":skipped.id,"dimension":"action"},
        ]})
        .to_string(),
    );
    let job = tag_curation::start(&db.conn).await.unwrap();
    tag_curation::generate(&db.conn, &client, &TranscriptFixture, &job.id)
        .await
        .unwrap();
    tags::update_tag(&db.conn, skipped.id, Some("更新说明"), None)
        .await
        .unwrap();

    let err = tag_curation::apply(
        &db.conn,
        &job.id,
        vec![tag_curation::Choice {
            index: 1,
            ..Default::default()
        }],
    )
    .await
    .unwrap_err();
    assert!(matches!(err, DbError::Conflict(_)));
    assert_eq!(
        tag_curation::status(&db.conn).await.unwrap().unwrap().id,
        job.id
    );

    let choices = vec![tag_curation::Choice {
        index: 0,
        name: Some("内置浏览器".into()),
        ..Default::default()
    }];
    let outcome = tag_curation::apply(&db.conn, &job.id, choices.clone())
        .await
        .unwrap();
    assert_eq!(
        tag_curation::apply(&db.conn, &job.id, choices)
            .await
            .unwrap(),
        outcome
    );
    let saved = tags::list_tags(&db.conn).await.unwrap();
    assert_eq!(saved[0].dimension, Some(tag_curation::Dimension::Action));
    assert_eq!(saved[0].name, "内置浏览器");
    assert_eq!(saved[1].name, "更新说明");
    assert_eq!(saved[1].dimension, Some(tag_curation::Dimension::Theme));
}

#[tokio::test]
async fn merge_and_delete_require_each_confirmation_and_undo_restores_original_links() {
    let directory = tempfile::tempdir().unwrap();
    let db = fresh_disk_db(directory.path()).await;
    configure(&db).await;
    let folder = seed_folder(&db, "/tmp/tag-curation-merge").await;
    let session = seed_conversation(&db, folder, AgentType::Codex).await;
    let keep = tags::create_tag(&db.conn, None, "内置浏览器", "#123456")
        .await
        .unwrap();
    let first = tags::create_tag(&db.conn, None, "浏览器", "#234567")
        .await
        .unwrap();
    let second = tags::create_tag(&db.conn, None, "WebView", "#345678")
        .await
        .unwrap();
    let remove = tags::create_tag(&db.conn, None, "浏览器试用", "#456789")
        .await
        .unwrap();
    tags::update_conversation_tags_with_source(
        &db.conn,
        session,
        &[keep.id],
        &[],
        tags::TagSource::Ai,
    )
    .await
    .unwrap();
    tags::update_conversation_tags(&db.conn, session, &[first.id, second.id, remove.id], &[])
        .await
        .unwrap();
    tag_curation::set_protection(&db.conn, vec![first.id, second.id, remove.id], false)
        .await
        .unwrap();
    let preview = review(
        &db,
        json!([
            {"kind":"merge","tagId":first.id,"targetId":keep.id},
            {"kind":"merge","tagId":second.id,"targetId":keep.id},
            {"kind":"delete","tagId":remove.id},
        ]),
    )
    .await;
    assert!(
        tag_curation::apply(&db.conn, &preview.id, vec![selected(0)])
            .await
            .is_err()
    );
    assert!(tag_curation::apply(
        &db.conn,
        &preview.id,
        vec![tag_curation::Choice {
            confirm_manual: true,
            ..selected(2)
        }]
    )
    .await
    .is_err());
    assert_eq!(tags::list_tags(&db.conn).await.unwrap().len(), 4);

    tag_curation::apply(
        &db.conn,
        &preview.id,
        (0..3)
            .map(|index| tag_curation::Choice {
                confirm_manual: true,
                confirm_delete: index == 2,
                ..selected(index)
            })
            .collect(),
    )
    .await
    .unwrap();
    db.conn.close().await.unwrap();
    let reopened = fresh_disk_db(directory.path()).await;
    let saved = tags::list_tags(&reopened.conn).await.unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].id, keep.id);
    assert_eq!(saved[0].aliases, ["浏览器", "WebView"]);
    let merged = review(
        &reopened,
        json!([{"kind":"remove","tagId":keep.id,"conversationId":session}]),
    )
    .await;
    assert!(merged.items[0].affected[0].manual, "重叠关联要保留人工来源");
    assert_eq!(
        tag_curation::history(&reopened.conn).await.unwrap()[0].state,
        tag_curation::State::Applied
    );

    tag_curation::undo(&reopened.conn, &preview.id)
        .await
        .unwrap();
    assert_eq!(
        tags::list_tags(&reopened.conn).await.unwrap(),
        vec![
            keep.clone(),
            crate::models::ConversationTagDetail {
                is_protected: false,
                ..first.clone()
            },
            crate::models::ConversationTagDetail {
                is_protected: false,
                ..second.clone()
            },
            crate::models::ConversationTagDetail {
                is_protected: false,
                ..remove.clone()
            },
        ]
    );
    assert_eq!(
        conversation_service::get_by_id(&reopened.conn, session)
            .await
            .unwrap()
            .tag_ids,
        vec![keep.id, first.id, second.id, remove.id]
    );
    assert_eq!(
        tag_curation::history(&reopened.conn).await.unwrap()[0].state,
        tag_curation::State::Undone
    );
}

#[tokio::test]
async fn scope_and_failed_selection_leave_the_entire_batch_unapplied() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    configure(&db).await;
    let folder = seed_folder(&db, "/tmp/tag-curation-other-scope").await;
    let source = tags::create_tag(&db.conn, None, "工作台", "#123456")
        .await
        .unwrap();
    let target = tags::create_tag(&db.conn, None, "编码工作台", "#234567")
        .await
        .unwrap();
    let other_scope = tags::create_tag(&db.conn, Some(folder), "编码工作台", "#345678")
        .await
        .unwrap();
    tag_curation::set_protection(&db.conn, vec![source.id, target.id], false)
        .await
        .unwrap();
    let preview = review(
        &db,
        json!([
            {"kind":"update","tagId":target.id,"name":"会话工作台"},
            {"kind":"update","tagId":source.id,"color":"#765432"},
        ]),
    )
    .await;
    assert!(tag_curation::apply(
        &db.conn,
        &preview.id,
        vec![
            selected(0),
            tag_curation::Choice {
                color: Some("not a color".into()),
                ..selected(1)
            },
        ]
    )
    .await
    .is_err());
    assert_eq!(
        tags::list_tags(&db.conn).await.unwrap()[1].name,
        target.name
    );
    tag_curation::discard(&db.conn, &preview.id).await.unwrap();

    let merge = review(
        &db,
        json!([
            {"kind":"merge","tagId":source.id,"targetId":other_scope.id},
            {"kind":"merge","tagId":source.id,"targetId":target.id},
        ]),
    )
    .await;
    assert_eq!(merge.items.len(), 1);
    let rejected = tag_curation::apply(
        &db.conn,
        &merge.id,
        vec![tag_curation::Choice {
            target_id: Some(other_scope.id),
            ..selected(0)
        }],
    )
    .await;
    assert!(matches!(rejected, Err(DbError::Validation(_))));
    assert_eq!(tags::list_tags(&db.conn).await.unwrap().len(), 3);
}

#[tokio::test]
async fn protects_manual_definitions_and_refuses_to_undo_over_a_later_edit() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    configure(&db).await;
    let tag = tags::create_tag(&db.conn, None, "脚本", "#123456")
        .await
        .unwrap();
    let preview = review(&db, json!([
        {"kind":"delete","tagId":tag.id},
        {"kind":"update","tagId":tag.id,"name":"脚本解析","color":"#000000","dimension":"action"},
    ])).await;
    assert_eq!(preview.items.len(), 1);
    assert!(matches!(
        &preview.items[0].change,
        tag_curation::Change::Update {
            name: None,
            color: None,
            ..
        }
    ));
    let forged = tag_curation::Choice {
        name: Some("脚本解析".into()),
        ..selected(0)
    };
    assert!(matches!(
        tag_curation::apply(&db.conn, &preview.id, vec![forged]).await,
        Err(DbError::Validation(_))
    ));
    tag_curation::apply(&db.conn, &preview.id, vec![selected(0)])
        .await
        .unwrap();
    let later = tags::update_tag(&db.conn, tag.id, Some("人工脚本"), None)
        .await
        .unwrap();
    assert!(matches!(
        tag_curation::undo(&db.conn, &preview.id).await,
        Err(DbError::Conflict(_))
    ));
    assert_eq!(tags::list_tags(&db.conn).await.unwrap(), vec![later]);
}

#[tokio::test]
async fn manual_overage_is_reported_and_preserved_and_the_model_retries_once() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    configure(&db).await;
    let folder = seed_folder(&db, "/tmp/tag-curation-overage").await;
    let session = seed_conversation(&db, folder, AgentType::Codex).await;
    let mut tag_ids = Vec::new();
    for name in ["One", "Two", "Three", "Four", "Five"] {
        tag_ids.push(
            tags::create_tag(&db.conn, None, name, "#123456")
                .await
                .unwrap()
                .id,
        );
    }
    tags::update_conversation_tags(&db.conn, session, &tag_ids[..4], &[])
        .await
        .unwrap();
    let initial = tag_curation::start(&db.conn).await.unwrap();
    let client = FakeAiClient::with_replies(vec![
        Err(AiError::Transport("private network detail".into())),
        Err(AiError::Transport("private network detail".into())),
    ]);
    tag_curation::generate(&db.conn, &client, &TranscriptFixture, &initial.id)
        .await
        .unwrap();
    assert_eq!(client.request_count(), 2);
    let failed = tag_curation::status(&db.conn).await.unwrap().unwrap();
    assert_eq!(failed.state, tag_curation::State::Failed);
    assert_eq!(failed.error.as_deref(), Some("transport"));

    let retried = tag_curation::retry(&db.conn, &initial.id).await.unwrap();
    assert_eq!(retried.id, initial.id);
    let client = FakeAiClient::replying(
        &json!({"changes":[
            {"kind":"add","tagId":tag_ids[4],"conversationId":session},
        ]})
        .to_string(),
    );
    tag_curation::generate(&db.conn, &client, &TranscriptFixture, &initial.id)
        .await
        .unwrap();
    let preview = tag_curation::status(&db.conn).await.unwrap().unwrap();
    assert!(preview.items.is_empty());
    assert_eq!(preview.notices[0].count, 4);
    assert_eq!(
        conversation_service::get_by_id(&db.conn, session)
            .await
            .unwrap()
            .tag_ids,
        tag_ids[..4]
    );
}
