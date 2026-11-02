use super::*;
use crate::ai::{
    fake::FakeAiClient,
    settings::{self, AiAssistantSettings},
    tag_store,
};
use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use crate::models::agent::AgentType;

struct Transcript;
#[async_trait::async_trait]
impl ContextSource for Transcript {
    async fn read(&self, _conversation_id: i32) -> Result<String, crate::db::error::DbError> {
        Ok("User: MCP integration".into())
    }
}

#[tokio::test]
async fn first_completed_context_generates_once_without_applying_tags() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            auto_suggest_tags: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let client =
        FakeAiClient::replying(r##"{"tags":[],"new_tags":[{"name":"MCP","color":"#123456"}]}"##);
    enqueue_context(&db.conn, conversation, "User: MCP integration", 1000)
        .await
        .unwrap();
    run_due(&db.conn, &client, &Transcript, 1000).await.unwrap();
    let first = tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap()
        .batch
        .unwrap();
    enqueue_context(&db.conn, conversation, "User: MCP integration", 1001)
        .await
        .unwrap();
    run_due(&db.conn, &client, &Transcript, 1001).await.unwrap();
    assert_eq!(
        tag_store::read_status(&db.conn, conversation)
            .await
            .unwrap()
            .batch
            .unwrap()
            .id,
        first.id
    );
    assert_eq!(client.request_count(), 1);
    assert!(
        crate::db::service::conversation_service::get_by_id(&db.conn, conversation)
            .await
            .unwrap()
            .tag_ids
            .is_empty()
    );
}

#[tokio::test]
async fn transient_failure_retries_only_once_and_preserves_previous_suggestions() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-retry-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            auto_suggest_tags: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let old = tag_store::save_batch(
        &db.conn,
        conversation,
        "older",
        "v1",
        vec![tag_store::TagCandidate::new_tag("MCP", None, "topic")],
        900,
    )
    .await
    .unwrap();
    let client = FakeAiClient::with_replies(vec![
        Err(crate::ai::client::AiError::Transport("timeout".into())),
        Err(crate::ai::client::AiError::Transport(
            "timeout again".into(),
        )),
    ]);
    enqueue_context(&db.conn, conversation, "User: MCP integration", 1000)
        .await
        .unwrap();
    let _ = run_due(&db.conn, &client, &Transcript, 1000).await;
    assert!(tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap()
        .error
        .is_some());
    let _ = run_due(&db.conn, &client, &Transcript, 1119).await;
    assert_eq!(client.request_count(), 1);
    let _ = run_due(&db.conn, &client, &Transcript, 1120).await;
    let _ = run_due(&db.conn, &client, &Transcript, 2000).await;
    assert_eq!(client.request_count(), 2);
    assert_eq!(
        tag_store::read_status(&db.conn, conversation)
            .await
            .unwrap()
            .batch
            .unwrap()
            .id,
        old.id
    );
}

#[tokio::test]
async fn a_completed_turn_is_queued_even_when_title_generation_is_disabled() {
    use crate::models::message::{ContentBlock, MessageTurn, TurnRole};
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-completed-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            auto_suggest_tags: true,
            title_source: crate::ai::gate::TitleSource::Agent,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let turns = [TurnRole::User, TurnRole::Assistant]
        .into_iter()
        .enumerate()
        .map(|(index, role)| MessageTurn {
            id: format!("turn-{index}"),
            role,
            blocks: vec![ContentBlock::Text {
                text: "MCP integration".into(),
            }],
            timestamp: chrono::Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        })
        .collect::<Vec<_>>();
    record_completed(&db.conn, conversation, &turns, 1000)
        .await
        .unwrap();
    let client = FakeAiClient::replying(r##"{"tags":[],"new_tags":[{"name":"MCP"}]}"##);
    run_due(&db.conn, &client, &Transcript, 1000).await.unwrap();
    assert!(tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap()
        .batch
        .is_some());
}

#[tokio::test]
async fn manual_refresh_works_with_auto_disabled_and_bypasses_the_interval_only_when_forced() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-manual-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            auto_suggest_tags: false,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let client = FakeAiClient::with_replies(vec![
        Ok(r##"{"tags":[],"new_tags":[{"name":"MCP"}]}"##.into()),
        Ok(r##"{"tags":[],"new_tags":[{"name":"Avatar"}]}"##.into()),
    ]);
    generate_manual(&db.conn, &client, &Transcript, conversation, false, 1000)
        .await
        .unwrap();
    let first = tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap()
        .batch
        .unwrap()
        .id;
    generate_manual(&db.conn, &client, &Transcript, conversation, false, 1001)
        .await
        .unwrap();
    assert_eq!(client.request_count(), 1);
    generate_manual(&db.conn, &client, &Transcript, conversation, true, 1002)
        .await
        .unwrap();
    assert_eq!(client.request_count(), 2);
    assert_ne!(
        tag_store::read_status(&db.conn, conversation)
            .await
            .unwrap()
            .batch
            .unwrap()
            .id,
        first
    );
    run_due(&db.conn, &client, &Transcript, 1122).await.unwrap();
    assert_eq!(client.request_count(), 2);
}

#[tokio::test]
async fn manual_suggestions_remain_available_while_a_turn_is_in_progress() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/manual-tag-during-turn").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let provider = crate::db::service::model_provider_service::create(&db.conn, "test".into(), "https://test.invalid/v1".into(), "fake".into(), "claude_code".into(), None).await.unwrap();
    settings::save(&db.conn, &AiAssistantSettings { provider_id: Some(provider.id), tag_model: "fake".into(), auto_suggest_tags: false, ..Default::default() }).await.unwrap();
    let client = FakeAiClient::replying(r##"{"tags":[],"new_tags":[{"name":"MCP"}]}"##);
    let status = generate_manual(&db.conn, &client, &Transcript, conversation, false, 1000).await.unwrap();
    assert_eq!(status.batch.unwrap().candidates[0].name, "MCP");
    assert_eq!(client.request_count(), 1);
}

struct ChangingTranscript(std::sync::Mutex<String>);

#[async_trait::async_trait]
impl ContextSource for ChangingTranscript {
    async fn read(&self, _conversation_id: i32) -> Result<String, crate::db::error::DbError> {
        Ok(self.0.lock().unwrap().clone())
    }
}

#[tokio::test]
async fn rapid_completed_turns_merge_into_one_update_after_the_conversation_pauses() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-coalesce-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            auto_suggest_tags: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let client = FakeAiClient::with_replies(vec![
        Ok(r##"{"tags":[],"new_tags":[{"name":"MCP"}]}"##.into()),
        Ok(r##"{"tags":[],"new_tags":[{"name":"Avatar"}]}"##.into()),
    ]);
    let source = ChangingTranscript(std::sync::Mutex::new("first".into()));
    enqueue_context(&db.conn, conversation, "first", 1000)
        .await
        .unwrap();
    run_due(&db.conn, &client, &source, 1000).await.unwrap();
    enqueue_context(&db.conn, conversation, "intermediate", 1010)
        .await
        .unwrap();
    enqueue_context(&db.conn, conversation, "latest", 1050)
        .await
        .unwrap();
    *source.0.lock().unwrap() = "latest".into();
    run_due(&db.conn, &client, &source, 1119).await.unwrap();
    assert_eq!(client.request_count(), 1);
    run_due(&db.conn, &client, &source, 1120).await.unwrap();
    assert_eq!(client.request_count(), 2);
    assert_eq!(
        tag_store::read_status(&db.conn, conversation)
            .await
            .unwrap()
            .batch
            .unwrap()
            .candidates[0]
            .name,
        "Avatar"
    );
    run_due(&db.conn, &client, &source, 2000).await.unwrap();
    assert_eq!(client.request_count(), 2);
}

struct GatedModel {
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    requests: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl crate::ai::client::AiClient for GatedModel {
    async fn complete(
        &self,
        _request: crate::ai::client::CompletionRequest,
    ) -> Result<String, crate::ai::client::AiError> {
        if self
            .requests
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            == 0
        {
            self.entered.notify_one();
            self.release.notified().await;
        }
        Ok(r##"{"tags":[],"new_tags":[{"name":"MCP"}]}"##.into())
    }
}

#[tokio::test]
async fn simultaneous_manual_refreshes_share_the_in_flight_request() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-concurrent-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let model = std::sync::Arc::new(GatedModel {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        requests: std::sync::atomic::AtomicUsize::new(0),
    });
    let first_conn = db.conn.clone();
    let first_model = model.clone();
    let first = tokio::spawn(async move {
        generate_manual(
            &first_conn,
            first_model.as_ref(),
            &Transcript,
            conversation,
            true,
            1000,
        )
        .await
        .unwrap()
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.notified())
        .await
        .unwrap();
    let second_conn = db.conn.clone();
    let second_model = model.clone();
    let second = tokio::spawn(async move {
        generate_manual(
            &second_conn,
            second_model.as_ref(),
            &Transcript,
            conversation,
            true,
            1000,
        )
        .await
        .unwrap()
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    model.release.notify_one();
    let first_status = first.await.unwrap();
    let second_status = second.await.unwrap();
    assert_eq!(model.requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        first_status.batch.unwrap().id,
        second_status.batch.unwrap().id
    );
}

#[tokio::test]
async fn changing_the_model_rejects_an_old_in_flight_response() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-config-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    let original = AiAssistantSettings {
        provider_id: Some(provider.id),
        tag_model: "first-model".into(),
        auto_suggest_tags: true,
        ..Default::default()
    };
    settings::save(&db.conn, &original).await.unwrap();
    enqueue_context(&db.conn, conversation, "User: MCP integration", 1000)
        .await
        .unwrap();
    let model = std::sync::Arc::new(GatedModel {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        requests: std::sync::atomic::AtomicUsize::new(0),
    });
    let runner_conn = db.conn.clone();
    let runner_model = model.clone();
    let runner = tokio::spawn(async move {
        run_due(&runner_conn, runner_model.as_ref(), &Transcript, 1000)
            .await
            .unwrap()
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.notified())
        .await
        .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            tag_model: "second-model".into(),
            ..original
        },
    )
    .await
    .unwrap();
    model.release.notify_one();
    runner.await.unwrap();
    assert!(tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap()
        .batch
        .is_none());
    let current = FakeAiClient::replying(r##"{"tags":[],"new_tags":[{"name":"Current model"}]}"##);
    run_due(&db.conn, &current, &Transcript, 1120)
        .await
        .unwrap();
    assert_eq!(
        tag_store::read_status(&db.conn, conversation)
            .await
            .unwrap()
            .batch
            .unwrap()
            .candidates[0]
            .name,
        "Current model"
    );
}

#[tokio::test]
async fn interrupted_requests_have_only_one_recovery_attempt() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-interrupted-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            auto_suggest_tags: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    enqueue_context(&db.conn, conversation, "User: MCP integration", 1000)
        .await
        .unwrap();
    for now in [1000, 1120] {
        let model = std::sync::Arc::new(GatedModel {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
            requests: std::sync::atomic::AtomicUsize::new(0),
        });
        let runner_conn = db.conn.clone();
        let runner_model = model.clone();
        let runner = tokio::spawn(async move {
            run_due(&runner_conn, runner_model.as_ref(), &Transcript, now)
                .await
                .unwrap()
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.notified())
            .await
            .unwrap();
        runner.abort();
        assert!(runner.await.unwrap_err().is_cancelled());
    }
    let unexpected = FakeAiClient::replying(r##"{"tags":[],"new_tags":[]}"##);
    run_due(&db.conn, &unexpected, &Transcript, 1240)
        .await
        .unwrap();
    assert_eq!(unexpected.request_count(), 0);
    assert!(tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap()
        .error
        .is_some());
}

struct SlowFailure(std::sync::atomic::AtomicUsize);

#[async_trait::async_trait]
impl crate::ai::client::AiClient for SlowFailure {
    async fn complete(
        &self,
        _request: crate::ai::client::CompletionRequest,
    ) -> Result<String, crate::ai::client::AiError> {
        if self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            Err(crate::ai::client::AiError::Transport("timeout".into()))
        } else {
            Ok(r##"{"tags":[],"new_tags":[]}"##.into())
        }
    }
}

#[tokio::test]
async fn retry_wait_starts_after_failure_rather_than_before_the_slow_request() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-slow-failure-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            auto_suggest_tags: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let model = SlowFailure(std::sync::atomic::AtomicUsize::new(0));
    enqueue_context(&db.conn, conversation, "User: MCP integration", 1000)
        .await
        .unwrap();
    run_due(&db.conn, &model, &Transcript, 1000).await.unwrap();
    run_due(&db.conn, &model, &Transcript, 1120).await.unwrap();
    assert_eq!(model.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    run_due(&db.conn, &model, &Transcript, 1200).await.unwrap();
    assert_eq!(model.0.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test]
async fn server_retry_after_can_extend_the_automatic_retry_wait() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-rate-limit-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            auto_suggest_tags: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let client = FakeAiClient::with_replies(vec![
        Err(crate::ai::client::AiError::HttpStatus {
            code: 429,
            retry_after: Some(300),
            message: "busy".into(),
        }),
        Ok(r##"{"tags":[],"new_tags":[{"name":"MCP"}]}"##.into()),
    ]);
    enqueue_context(&db.conn, conversation, "User: MCP integration", 1000)
        .await
        .unwrap();
    run_due(&db.conn, &client, &Transcript, 1000).await.unwrap();
    run_due(&db.conn, &client, &Transcript, 1120).await.unwrap();
    run_due(&db.conn, &client, &Transcript, 1299).await.unwrap();
    assert_eq!(client.request_count(), 1);
    run_due(&db.conn, &client, &Transcript, 1300).await.unwrap();
    assert_eq!(client.request_count(), 2);
    assert!(tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap()
        .batch
        .is_some());
}

#[tokio::test]
async fn reopening_the_database_restores_only_existing_work_and_preserves_review_state() {
    let directory = tempfile::tempdir().unwrap();
    let db = crate::db::test_helpers::fresh_disk_db(directory.path()).await;
    let folder = seed_folder(&db, "F:/job-disk-restart").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let historical = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    crate::db::service::conversation_service::update_status(
        &db.conn,
        historical,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    let enabled = AiAssistantSettings {
        provider_id: Some(provider.id),
        tag_model: "fake".into(),
        auto_suggest_tags: true,
        ..Default::default()
    };
    settings::save(&db.conn, &enabled).await.unwrap();
    let first =
        FakeAiClient::replying(r##"{"tags":[],"new_tags":[{"name":"MCP"},{"name":"Ignore me"}]}"##);
    let source = ChangingTranscript(std::sync::Mutex::new("first".into()));
    enqueue_context(&db.conn, conversation, "first", 1000)
        .await
        .unwrap();
    run_due(&db.conn, &first, &source, 1000).await.unwrap();
    let batch = tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap()
        .batch
        .unwrap();
    tag_store::ignore_candidate(&db.conn, conversation, &batch.id, 1, None)
        .await
        .unwrap();
    enqueue_context(&db.conn, conversation, "latest", 1010)
        .await
        .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            auto_suggest_tags: false,
            ..enabled.clone()
        },
    )
    .await
    .unwrap();
    run_due(&db.conn, &first, &source, 1120).await.unwrap();
    assert_eq!(first.request_count(), 1);
    db.conn.close().await.unwrap();

    let path = directory.path().join("source.db");
    let connection =
        sea_orm::Database::connect(format!("sqlite:{}?mode=rw", path.to_string_lossy()))
            .await
            .unwrap();
    let restored = crate::db::AppDatabase { conn: connection };
    let status = tag_store::read_status(&restored.conn, conversation)
        .await
        .unwrap();
    assert_eq!(status.batch.unwrap().id, batch.id);
    assert_eq!(status.ignored[0].name, "Ignore me");
    let next = FakeAiClient::replying(r##"{"tags":[],"new_tags":[{"name":"Avatar"}]}"##);
    let source = ChangingTranscript(std::sync::Mutex::new("latest".into()));
    run_due(&restored.conn, &next, &source, 1120).await.unwrap();
    assert_eq!(next.request_count(), 0);
    settings::save(&restored.conn, &enabled).await.unwrap();
    run_due(&restored.conn, &next, &source, 1120).await.unwrap();
    assert_eq!(next.request_count(), 1);
    assert_eq!(
        tag_store::read_status(&restored.conn, conversation)
            .await
            .unwrap()
            .batch
            .unwrap()
            .candidates[0]
            .name,
        "Avatar"
    );
    assert!(tag_store::read_status(&restored.conn, historical)
        .await
        .unwrap()
        .batch
        .is_none());
    run_due(&restored.conn, &next, &source, 2000).await.unwrap();
    assert_eq!(next.request_count(), 1);
    restored.conn.close().await.unwrap();
}

#[tokio::test]
async fn deleting_and_restoring_a_conversation_does_not_resurrect_old_suggestions_or_jobs() {
    use crate::db::service::conversation_service as conversations;
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-delete-test").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    conversations::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            auto_suggest_tags: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let batch = tag_store::save_batch(
        &db.conn,
        conversation,
        "old",
        "v1",
        vec![
            tag_store::TagCandidate::new_tag("MCP", None, "topic"),
            tag_store::TagCandidate::new_tag("Ignore me", None, "topic"),
        ],
        900,
    )
    .await
    .unwrap();
    tag_store::ignore_candidate(&db.conn, conversation, &batch.id, 1, None)
        .await
        .unwrap();
    enqueue_context(&db.conn, conversation, "User: MCP integration", 1000)
        .await
        .unwrap();
    conversations::soft_delete(&db.conn, conversation)
        .await
        .unwrap();
    let status = tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap();
    assert!(status.batch.is_none());
    assert!(status.ignored.is_empty());
    assert!(
        conversations::restore_soft_deleted(&db.conn, conversation, folder)
            .await
            .unwrap()
    );
    let client = FakeAiClient::replying(r##"{"tags":[],"new_tags":[{"name":"Unexpected"}]}"##);
    run_due(&db.conn, &client, &Transcript, 1120).await.unwrap();
    assert_eq!(client.request_count(), 0);
    let status = tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap();
    assert!(status.batch.is_none());
    assert!(status.ignored.is_empty());
    assert!(status.error.is_none());
}

#[tokio::test]
async fn explicit_generation_reuses_only_the_same_model_tag_pool_and_ignore_preferences() {
    use crate::db::service::conversation_tag_service as tags;
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-input-cache").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    let original = AiAssistantSettings {
        provider_id: Some(provider.id),
        tag_model: "first-model".into(),
        ..Default::default()
    };
    settings::save(&db.conn, &original).await.unwrap();
    let client = FakeAiClient::with_replies(vec![
        Ok(r##"{"tags":[],"new_tags":[{"name":"Initial"}]}"##.into()),
        Ok(r##"{"tags":[{"name":"MCP","reason":"topic"}],"new_tags":[]}"##.into()),
        Ok(r##"{"tags":[{"name":"MCP","reason":"new model"}],"new_tags":[]}"##.into()),
        Ok(r##"{"tags":[],"new_tags":[{"name":"Alternative"}]}"##.into()),
    ]);
    let first = generate_manual(&db.conn, &client, &Transcript, conversation, false, 1000)
        .await
        .unwrap()
        .batch
        .unwrap();
    assert_eq!(
        generate_manual(&db.conn, &client, &Transcript, conversation, false, 1001)
            .await
            .unwrap()
            .batch
            .unwrap()
            .id,
        first.id
    );
    assert_eq!(client.request_count(), 1);
    tags::create_tag(&db.conn, None, "MCP", "#123456")
        .await
        .unwrap();
    let pooled = generate_manual(&db.conn, &client, &Transcript, conversation, false, 1002)
        .await
        .unwrap()
        .batch
        .unwrap();
    assert_eq!(client.request_count(), 2);
    assert_ne!(pooled.id, first.id);
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            tag_model: "second-model".into(),
            ..original
        },
    )
    .await
    .unwrap();
    let current = generate_manual(&db.conn, &client, &Transcript, conversation, false, 1003)
        .await
        .unwrap()
        .batch
        .unwrap();
    assert_eq!(client.request_count(), 3);
    assert_ne!(current.id, pooled.id);
    tag_store::ignore_candidate(&db.conn, conversation, &current.id, 0, None)
        .await
        .unwrap();
    let alternative = generate_manual(&db.conn, &client, &Transcript, conversation, false, 1004)
        .await
        .unwrap()
        .batch
        .unwrap();
    assert_eq!(client.request_count(), 4);
    assert_eq!(alternative.candidates[0].name, "Alternative");
    assert!(!client.prompts()[3].contains("- MCP\n"));
}

#[tokio::test]
async fn disabling_auto_suggestions_keeps_the_successful_in_flight_result_without_new_calls() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-disable-in-flight").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    let enabled = AiAssistantSettings {
        provider_id: Some(provider.id),
        tag_model: "fake".into(),
        auto_suggest_tags: true,
        ..Default::default()
    };
    settings::save(&db.conn, &enabled).await.unwrap();
    enqueue_context(&db.conn, conversation, "User: MCP integration", 1000)
        .await
        .unwrap();
    let model = std::sync::Arc::new(GatedModel {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        requests: std::sync::atomic::AtomicUsize::new(0),
    });
    let runner_conn = db.conn.clone();
    let runner_model = model.clone();
    let runner = tokio::spawn(async move {
        run_due(&runner_conn, runner_model.as_ref(), &Transcript, 1000)
            .await
            .unwrap()
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.notified())
        .await
        .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            auto_suggest_tags: false,
            ..enabled
        },
    )
    .await
    .unwrap();
    model.release.notify_one();
    runner.await.unwrap();
    let batch = tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap()
        .batch
        .unwrap();
    assert_eq!(batch.candidates[0].name, "MCP");
    run_due(&db.conn, model.as_ref(), &Transcript, 1120)
        .await
        .unwrap();
    assert_eq!(model.requests.load(std::sync::atomic::Ordering::SeqCst), 1);
    tag_store::confirm_batch(
        &db.conn,
        conversation,
        &batch.id,
        vec![tag_store::TagChoice::candidate(0)],
    )
    .await
    .unwrap();
    assert_eq!(
        crate::db::service::conversation_service::get_by_id(&db.conn, conversation)
            .await
            .unwrap()
            .tag_ids
            .len(),
        1
    );
}

#[tokio::test]
async fn oversized_context_keeps_the_main_topic_and_latest_prose_within_the_budget() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-context-budget").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let context = format!(
        "User: MAIN_TOPIC\n{}\nAssistant: {}\nLATEST_PROSE",
        "主".repeat(14000),
        "新".repeat(14000)
    );
    let source = ChangingTranscript(std::sync::Mutex::new(context));
    let client = FakeAiClient::replying(r##"{"tags":[],"new_tags":[]}"##);
    generate_manual(&db.conn, &client, &source, conversation, true, 1000)
        .await
        .unwrap();
    let prompt = client.prompts().pop().unwrap();
    let content = prompt
        .split_once("<对话>\n")
        .unwrap()
        .1
        .rsplit_once("\n</对话>")
        .unwrap()
        .0;
    assert!(content.chars().count() <= crate::ai::context::MAX_CONTEXT_CHARS);
    assert!(content.contains("MAIN_TOPIC"));
    assert!(content.contains("LATEST_PROSE"));
}

#[tokio::test]
async fn an_interrupted_old_target_does_not_spend_the_new_targets_retry_budget() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-new-target-budget").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            auto_suggest_tags: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    enqueue_context(&db.conn, conversation, "old", 1000)
        .await
        .unwrap();
    let model = std::sync::Arc::new(GatedModel {
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        requests: std::sync::atomic::AtomicUsize::new(0),
    });
    let runner_conn = db.conn.clone();
    let runner_model = model.clone();
    let runner = tokio::spawn(async move {
        run_due(&runner_conn, runner_model.as_ref(), &Transcript, 1000)
            .await
            .unwrap()
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), model.entered.notified())
        .await
        .unwrap();
    enqueue_context(&db.conn, conversation, "latest", 1010)
        .await
        .unwrap();
    runner.abort();
    assert!(runner.await.unwrap_err().is_cancelled());
    let current = FakeAiClient::with_replies(vec![
        Err(crate::ai::client::AiError::Transport("temporary".into())),
        Ok(r##"{"tags":[],"new_tags":[{"name":"Latest target"}]}"##.into()),
    ]);
    let source = ChangingTranscript(std::sync::Mutex::new("latest".into()));
    run_due(&db.conn, &current, &source, 1120).await.unwrap();
    assert_eq!(current.request_count(), 1);
    run_due(&db.conn, &current, &source, 1240).await.unwrap();
    assert_eq!(current.request_count(), 2);
    assert_eq!(
        tag_store::read_status(&db.conn, conversation)
            .await
            .unwrap()
            .batch
            .unwrap()
            .candidates[0]
            .name,
        "Latest target"
    );
}

#[tokio::test]
async fn an_empty_result_for_oversized_context_is_not_regenerated_without_new_content() {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "F:/job-empty-oversized").await;
    let conversation = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    crate::db::service::conversation_service::update_status(
        &db.conn,
        conversation,
        crate::db::entities::conversation::ConversationStatus::PendingReview,
    )
    .await
    .unwrap();
    let provider = crate::db::service::model_provider_service::create(
        &db.conn,
        "test".into(),
        "https://test.invalid/v1".into(),
        "fake".into(),
        "claude_code".into(),
        None,
    )
    .await
    .unwrap();
    settings::save(
        &db.conn,
        &AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "fake".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let source = ChangingTranscript(std::sync::Mutex::new(format!(
        "{}{}",
        "old".repeat(5000),
        "latest".repeat(5000)
    )));
    let client = FakeAiClient::with_replies(vec![Ok(r##"{"tags":[],"new_tags":[]}"##.into())]);
    generate_manual(&db.conn, &client, &source, conversation, true, 1000)
        .await
        .unwrap();
    generate_manual(&db.conn, &client, &source, conversation, false, 1001)
        .await
        .unwrap();
    run_due(&db.conn, &client, &source, 1120).await.unwrap();
    assert_eq!(client.request_count(), 1);
    assert!(tag_store::read_status(&db.conn, conversation)
        .await
        .unwrap()
        .batch
        .is_none());
}
