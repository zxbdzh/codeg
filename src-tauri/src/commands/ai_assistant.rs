//! AI 助手：标签建议与会话标题生成，以及它的设置。
//!
//! 三个命令族共用 `_core` 入口，桌面与服务器两条链路都只做"取依赖 → 调 `_core`"
//! 一件事，所以行为不可能两边漂移：
//!
//! - `ai_*` 设置读写；
//! - `suggest_tags` 读会话问模型，**不写库**——只有人在确认框里点头才会写；
//! - `apply_suggested_tags` 把确认过的标签打上去（带 `source = ai`）；
//! - `generate_conversation_title` 走门禁 → 生成 → 写入 → 广播。
//!
//! 标签建议和标题节流分别保存进程内状态；HTTP 客户端只复用连接池，
//! 每次请求仍使用当前设置的模型与提示词。

use std::collections::BTreeMap;
use std::sync::LazyLock;

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::ai::client::{AiError, HttpAiClient};
use crate::ai::settings::{self, AiAssistantSettings, AiAvailability};
use crate::ai::suggest::{suggest_tags, AiFlowError, SuggestionCache};
use crate::ai::title_gen::{apply_generated_title, generate_title, TitleOutcome, TitleThrottle};
use crate::app_error::AppCommandError;
use crate::db::service::conversation_tag_service::{self, TagSource};
use crate::db::AppDatabase;
use crate::models::DbConversationSummary;
use crate::web::event_bridge::{
    emit_event, ConversationChange, ConversationTagChange, EventEmitter,
    CONVERSATION_CHANGED_EVENT, CONVERSATION_TAG_CHANGED_EVENT,
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, TransactionTrait};

/// 每个会话最近一次建议的小缓存。有界：它纯粹为了省钱，没有任何东西应该
/// 因为它无限增长。
static TAG_SUGGESTIONS: LazyLock<SuggestionCache> = LazyLock::new(|| SuggestionCache::new(32));

/// 标题节流状态（内存）。重启后重新计一遍没有坏处，所以刻意不落库。
static TITLE_THROTTLE: LazyLock<TitleThrottle> = LazyLock::new(TitleThrottle::new);

/// 真正的 HTTP 客户端。构造失败（reqwest 的 TLS 后端起不来）在整个进程生命
/// 周期内都不会变好，所以也做成一次性的惰性单例。
static AI_CLIENT: LazyLock<Result<HttpAiClient, String>> =
    LazyLock::new(|| HttpAiClient::new().map_err(|e| e.to_string()));

fn client() -> Result<&'static HttpAiClient, AiFlowError> {
    AI_CLIENT
        .as_ref()
        .map_err(|message| AiFlowError::Client(AiError::Transport(message.clone())))
}

/// AI 助手错误到 `AppCommandError` 的映射。
///
/// 未配置单独走一类：它不是"出错了"，而是"还没设置"，前端据此把入口置灰、
/// 把用户带去设置页，而不是弹一个红叉。
fn to_app_error(error: AiFlowError) -> AppCommandError {
    let message = error.to_string();
    match error {
        AiFlowError::NotConfigured(availability) => match availability {
            AiAvailability::Ready => AppCommandError::invalid_input(message),
            AiAvailability::NoProvider => AppCommandError::configuration_missing(message)
                .with_i18n("aiAssistant.noProvider", BTreeMap::new()),
            AiAvailability::ProviderMissing => AppCommandError::not_found(message)
                .with_i18n("aiAssistant.providerMissing", BTreeMap::new()),
            AiAvailability::NoModel => AppCommandError::configuration_invalid(message)
                .with_i18n("aiAssistant.noModel", BTreeMap::new()),
            AiAvailability::UnsupportedProtocol => AppCommandError::configuration_invalid(message)
                .with_i18n("aiAssistant.unsupportedProtocol", BTreeMap::new()),
        },
        AiFlowError::Client(AiError::Unauthorized) => {
            AppCommandError::authentication_failed(message)
                .with_i18n("aiAssistant.errorUnauthorized", BTreeMap::new())
        }
        AiFlowError::Client(AiError::NotFound) => AppCommandError::not_found(message)
            .with_i18n("aiAssistant.errorNotFound", BTreeMap::new()),
        AiFlowError::Client(AiError::Transport(_)) => AppCommandError::network(message)
            .with_i18n("aiAssistant.errorTransport", BTreeMap::new()),
        AiFlowError::Client(AiError::MalformedReply(_)) | AiFlowError::Malformed(_) => {
            AppCommandError::task_execution_failed(message)
                .with_i18n("aiAssistant.errorMalformed", BTreeMap::new())
        }
        AiFlowError::Conversation(_) => AppCommandError::not_found(message)
            .with_i18n("aiAssistant.conversationNotFound", BTreeMap::new()),
        AiFlowError::EmptyConversation => AppCommandError::invalid_input(message)
            .with_i18n("aiAssistant.emptyConversation", BTreeMap::new()),
        AiFlowError::Db(db) => AppCommandError::from(db),
    }
}

pub async fn get_ai_assistant_settings_core(
    db: &AppDatabase,
) -> Result<AiAssistantSettings, AppCommandError> {
    settings::load(&db.conn)
        .await
        .map_err(AppCommandError::from)
}

pub async fn update_ai_assistant_settings_core(
    db: &AppDatabase,
    next: AiAssistantSettings,
) -> Result<AiAssistantSettings, AppCommandError> {
    settings::save(&db.conn, &next)
        .await
        .map_err(AppCommandError::from)
}

/// AI 助手现在能不能干活，以及不能的话为什么。前端据此决定置灰与 tooltip。
pub async fn get_ai_assistant_availability_core(
    db: &AppDatabase,
) -> Result<AiAvailability, AppCommandError> {
    let settings = settings::load(&db.conn).await?;
    settings::availability(&db.conn, &settings)
        .await
        .map_err(AppCommandError::from)
}

/// 用最小请求验证已保存的提供方与模型，不触碰会话或标签。
/// 测试沿用已约定的 AiClient seam，生产传入 HTTP 实现。
pub async fn test_ai_assistant_connection_core(
    db: &AppDatabase,
    client: &dyn crate::ai::client::AiClient,
) -> Result<(), AppCommandError> {
    let settings = settings::load(&db.conn).await?;
    let availability = settings::availability(&db.conn, &settings).await?;
    if !availability.is_ready() {
        return Err(to_app_error(AiFlowError::NotConfigured(availability)));
    }
    let provider = crate::ai::suggest::resolve_provider(&db.conn, &settings)
        .await
        .map_err(to_app_error)?;
    let model = settings
        .model_for(crate::ai::settings::AiTask::Tagging)
        .ok_or_else(|| to_app_error(AiFlowError::NotConfigured(AiAvailability::NoModel)))?;
    let protocol = settings.protocol();
    client
        .complete(crate::ai::client::CompletionRequest {
            protocol,
            url: crate::ai::wire::endpoint(&provider.api_url, protocol),
            headers: crate::ai::wire::auth_headers(
                protocol,
                settings.key_header,
                &provider.api_key,
            ),
            body: crate::ai::wire::request_body(protocol, model, "Reply only with OK.", 16),
            api_key: provider.api_key.clone(),
        })
        .await
        .map_err(|error| to_app_error(AiFlowError::Client(error)))?;
    Ok(())
}

/// 给一条会话提标签建议。**不写任何标签**：模型只是提议，人在确认框里点头
/// 之后才由 [`apply_suggested_tags_core`] 真正落库。
pub async fn suggest_conversation_tags_core(
    db: &AppDatabase,
    conversation_id: i32,
) -> Result<crate::ai::output::TagSuggestion, AppCommandError> {
    let client = client().map_err(to_app_error)?;
    suggest_tags(&db.conn, client, &TAG_SUGGESTIONS, conversation_id)
        .await
        .map_err(to_app_error)
}

/// 把确认过的标签打上去，来源记为 AI。
///
/// 新建标签在这里做，而不是在建议阶段：建议只是提议，创建一条标签是用户看得
/// 见的体系变更，必须等人点头。作用域校验与重名校验沿用既有实现。
pub async fn apply_suggested_tags_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    conversation_id: i32,
    existing_tag_ids: Vec<i32>,
    new_tags: Vec<NewTagRequest>,
) -> Result<DbConversationSummary, AppCommandError> {
    use crate::db::entities::conversation;
    use crate::db::service::conversation_tag_service::TagError;

    let created = db
        .conn
        .transaction::<_, _, TagError>(|txn| {
            Box::pin(async move {
                // SQLite 的 deferred 事务不能在读快照过期后升级为写；先做无活动语义
                // 的空写取得写锁，再校验与建标签。失败时整批回滚，不留下孤儿标签。
                let live = conversation::Entity::update_many()
                    .col_expr(
                        conversation::Column::Id,
                        sea_orm::sea_query::Expr::col(conversation::Column::Id).into(),
                    )
                    .filter(conversation::Column::Id.eq(conversation_id))
                    .filter(conversation::Column::DeletedAt.is_null())
                    .exec(txn)
                    .await?;
                if live.rows_affected == 0 {
                    return Err(TagError::ConversationNotFound(conversation_id));
                }
                let mut add = existing_tag_ids;
                let mut created = Vec::new();
                for new_tag in new_tags {
                    let tag = conversation_tag_service::create_tag(
                        txn,
                        new_tag.folder_id,
                        &new_tag.name,
                        &new_tag.color,
                    )
                    .await?;
                    add.push(tag.id);
                    created.push(tag);
                }
                conversation_tag_service::update_conversation_tags_with_source(
                    txn,
                    conversation_id,
                    &add,
                    &[],
                    TagSource::Ai,
                )
                .await?;
                Ok(created)
            })
        })
        .await
        .map_err(|error| match error {
            sea_orm::TransactionError::Connection(error) => {
                AppCommandError::from(crate::db::error::DbError::from(error))
            }
            sea_orm::TransactionError::Transaction(error) => AppCommandError::from(error),
        })?;

    // 只有整批提交成功才广播；客户端不能先看到一个随后回滚的标签定义。
    for tag in created {
        emit_event(
            emitter,
            CONVERSATION_TAG_CHANGED_EVENT,
            ConversationTagChange::Upsert { tag },
        );
    }

    // 与手动打标签同一条广播路径：摘要的 tag_ids 由 get_by_id 重新读，永远
    // 不可能与库里的其余部分不一致。
    let summary =
        crate::db::service::conversation_service::get_by_id(&db.conn, conversation_id).await?;
    emit_event(
        emitter,
        CONVERSATION_CHANGED_EVENT,
        ConversationChange::Upsert {
            summary: Box::new(summary.clone()),
        },
    );
    Ok(summary)
}

/// 一条待新建的标签。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTagRequest {
    pub name: String,
    /// 必须是 `#rrggbb`，服务层会再校验一次。
    pub color: String,
    /// `None` = 全局。
    pub folder_id: Option<i32>,
}

/// 为一条会话重新生成标题。
///
/// `force` 只绕过节流与"有没有新内容"，仍然尊重标题来源与手动锁定。返回
/// `None` 表示门禁不允许（这不是错误，前端不该弹提示）。
pub async fn generate_conversation_title_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    conversation_id: i32,
    force: bool,
) -> Result<Option<String>, AppCommandError> {
    let client = client().map_err(to_app_error)?;
    let outcome = generate_title(
        &db.conn,
        client,
        &TITLE_THROTTLE,
        conversation_id,
        force,
        chrono::Utc::now(),
    )
    .await
    .map_err(to_app_error)?;

    finish_title_generation(emitter, db, conversation_id, outcome).await
}

async fn finish_title_generation(
    emitter: &EventEmitter,
    db: &AppDatabase,
    conversation_id: i32,
    outcome: TitleOutcome,
) -> Result<Option<String>, AppCommandError> {
    let TitleOutcome::Generated(title) = outcome else {
        return Ok(None);
    };
    let changed = apply_generated_title(&db.conn, conversation_id, &title)
        .await
        .map_err(to_app_error)?;
    if !changed {
        // 用户可能在请求期间手动改名或切换来源；返回实际生效的值，不能把
        // 被 SQL 锁定谓词拒绝的候选标题当作已保存标题通知前端。
        return Ok(None);
    }

    // 让侧栏与详情页都看到新标题。
    let summary =
        crate::db::service::conversation_service::get_by_id(&db.conn, conversation_id).await?;
    emit_event(
        emitter,
        CONVERSATION_CHANGED_EVENT,
        ConversationChange::Upsert {
            summary: Box::new(summary),
        },
    );
    Ok(Some(title))
}

/// 每轮结束后的后台生成：共享手动请求的节流与连接池，但不阻塞 lifecycle
/// 的状态落库/委托完成；完成轮的正文快照补上尚未刷盘的尾部。
pub async fn generate_completed_title_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    client: &dyn crate::ai::client::AiClient,
    throttle: &TitleThrottle,
    conversation_id: i32,
    completed_turns: &[crate::models::message::MessageTurn],
) -> Result<Option<String>, AppCommandError> {
    let (detail, _) =
        crate::commands::conversations::get_folder_conversation_core(&db.conn, conversation_id)
            .await?;
    let turns = crate::ai::completed_turn::merge_completed_turn(detail.turns, completed_turns);
    let outcome = crate::ai::title_gen::generate_title_from_turns(
        &db.conn,
        client,
        throttle,
        conversation_id,
        &turns,
        false,
        chrono::Utc::now(),
    )
    .await
    .map_err(to_app_error)?;
    finish_title_generation(emitter, db, conversation_id, outcome).await
}

pub fn spawn_completed_title_generation(
    emitter: EventEmitter,
    conn: sea_orm::DatabaseConnection,
    conversation_id: i32,
    completed_turns: Vec<crate::models::message::MessageTurn>,
) {
    tokio::spawn(async move {
        let db = AppDatabase { conn };
        let settings = match settings::load(&db.conn).await {
            Ok(settings) => settings,
            Err(error) => {
                tracing::warn!(conversation_id, %error, "could not read automatic title settings");
                return;
            }
        };
        if settings.title_source == crate::ai::gate::TitleSource::Agent
            || !settings::availability(&db.conn, &settings)
                .await
                .is_ok_and(|status| status.is_ready())
        {
            return;
        }
        let result = match client() {
            Ok(client) => {
                generate_completed_title_core(
                    &emitter,
                    &db,
                    client,
                    &TITLE_THROTTLE,
                    conversation_id,
                    &completed_turns,
                )
                .await
            }
            Err(error) => Err(to_app_error(error)),
        };
        if let Err(error) = result {
            tracing::warn!(conversation_id, %error, "automatic session title generation failed");
            // 独立提示通道，不发 ACP Error：改标题失败不等于编码会话失败。
            emit_event(
                &emitter,
                "ai-assistant://error",
                serde_json::json!({
                    "conversationId": conversation_id,
                    "error": error,
                }),
            );
        }
    });
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn get_ai_assistant_settings(
    db: State<'_, AppDatabase>,
) -> Result<AiAssistantSettings, AppCommandError> {
    get_ai_assistant_settings_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn update_ai_assistant_settings(
    db: State<'_, AppDatabase>,
    settings: AiAssistantSettings,
) -> Result<AiAssistantSettings, AppCommandError> {
    update_ai_assistant_settings_core(&db, settings).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn get_ai_assistant_availability(
    db: State<'_, AppDatabase>,
) -> Result<AiAvailability, AppCommandError> {
    get_ai_assistant_availability_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn suggest_conversation_tags(
    db: State<'_, AppDatabase>,
    conversation_id: i32,
) -> Result<crate::ai::output::TagSuggestion, AppCommandError> {
    suggest_conversation_tags_core(&db, conversation_id).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn apply_suggested_tags(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    conversation_id: i32,
    existing_tag_ids: Vec<i32>,
    new_tags: Vec<NewTagRequest>,
) -> Result<DbConversationSummary, AppCommandError> {
    apply_suggested_tags_core(
        &EventEmitter::Tauri(app),
        &db,
        conversation_id,
        existing_tag_ids,
        new_tags,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn generate_conversation_title(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    conversation_id: i32,
    force: Option<bool>,
) -> Result<Option<String>, AppCommandError> {
    generate_conversation_title_core(
        &EventEmitter::Tauri(app),
        &db,
        conversation_id,
        force.unwrap_or(false),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn test_ai_assistant_connection(
    db: State<'_, AppDatabase>,
) -> Result<(), AppCommandError> {
    test_saved_ai_assistant_connection_core(&db).await
}

/// HTTP 与 Tauri 都复用同一个客户端连接池。
pub async fn test_saved_ai_assistant_connection_core(
    db: &AppDatabase,
) -> Result<(), AppCommandError> {
    test_ai_assistant_connection_core(db, client().map_err(to_app_error)?).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

    use super::*;
    use crate::ai::gate::TitleSource;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;
    use crate::web::event_bridge::WebEventBroadcaster;

    fn settings_with_provider(provider_id: i32) -> AiAssistantSettings {
        AiAssistantSettings {
            provider_id: Some(provider_id),
            tag_model: "gpt-4o-mini".to_string(),
            ..AiAssistantSettings::default()
        }
    }

    #[tokio::test]
    async fn settings_can_be_read_back_and_clamped() {
        let db = fresh_in_memory_db().await;

        let saved = update_ai_assistant_settings_core(
            &db,
            AiAssistantSettings {
                provider_id: Some(2),
                tag_model: "cheap".to_string(),
                context_turns: 999,
                title_min_interval_seconds: 0,
                title_source: TitleSource::Fallback,
                ..AiAssistantSettings::default()
            },
        )
        .await
        .expect("save");

        assert_eq!(saved.context_turns, 50, "clamped to the maximum");
        assert_eq!(
            saved.title_min_interval_seconds, 5,
            "clamped to the minimum"
        );
        assert_eq!(
            get_ai_assistant_settings_core(&db).await.expect("read"),
            saved
        );
    }

    #[tokio::test]
    async fn completed_title_generation_uses_unpersisted_prose_and_broadcasts_the_saved_title() {
        use crate::models::message::{ContentBlock, MessageTurn, TurnRole};
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/ai-completed-title").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let provider = crate::db::service::model_provider_service::create(
            &db.conn,
            "test".into(),
            "https://example.com/v1".into(),
            "test-key".into(),
            "codex".into(),
            None,
        )
        .await
        .unwrap();
        update_ai_assistant_settings_core(&db, settings_with_provider(provider.id))
            .await
            .unwrap();
        let before = crate::db::service::conversation_service::get_by_id(&db.conn, conv)
            .await
            .unwrap();
        let client = crate::ai::fake::FakeAiClient::replying("标题：修复未失效的标签缓存");
        let throttle = TitleThrottle::new();
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster);
        let turns = vec![MessageTurn {
            id: "new-unpersisted-prompt".into(),
            role: TurnRole::User,
            blocks: vec![ContentBlock::Text {
                text: "排查标签缓存为什么没有失效".into(),
            }],
            timestamp: chrono::Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        }];

        let title = generate_completed_title_core(&emitter, &db, &client, &throttle, conv, &turns)
            .await
            .unwrap();

        assert_eq!(title.as_deref(), Some("修复未失效的标签缓存"));
        assert!(client.prompts()[0].contains("排查标签缓存为什么没有失效"));
        let stored = crate::db::service::conversation_service::get_by_id(&db.conn, conv)
            .await
            .unwrap();
        assert_eq!(stored.title, title);
        assert!(!stored.title_locked);
        assert_eq!(stored.updated_at, before.updated_at);
        assert_eq!(
            rx.try_recv().unwrap().payload["summary"]["title"],
            "修复未失效的标签缓存"
        );
    }

    #[tokio::test]
    async fn availability_is_not_ready_before_a_provider_is_chosen() {
        let db = fresh_in_memory_db().await;

        assert_eq!(
            get_ai_assistant_availability_core(&db)
                .await
                .expect("availability"),
            AiAvailability::NoProvider
        );
    }

    #[tokio::test]
    async fn connection_test_reports_provider_authentication_failure() {
        let db = fresh_in_memory_db().await;
        let provider = crate::db::service::model_provider_service::create(
            &db.conn,
            "test".into(),
            "https://example.com/v1".into(),
            "test-key".into(),
            "codex".into(),
            None,
        )
        .await
        .unwrap();
        update_ai_assistant_settings_core(&db, settings_with_provider(provider.id))
            .await
            .unwrap();
        let client = crate::ai::fake::FakeAiClient::failing(AiError::Unauthorized);

        let error = test_ai_assistant_connection_core(&db, &client)
            .await
            .unwrap_err();

        assert!(matches!(
            error.code,
            crate::app_error::AppErrorCode::AuthenticationFailed
        ));
        assert_eq!(
            error.i18n_key.as_deref(),
            Some("aiAssistant.errorUnauthorized")
        );
    }

    /// 未配置时不该碰网络，直接返回"未配置"这一类的错。
    #[tokio::test]
    async fn suggesting_without_a_provider_fails_before_touching_the_network() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/ai-cmd-gate").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;

        let error = suggest_conversation_tags_core(&db, conv)
            .await
            .expect_err("must fail");

        assert!(matches!(
            error.code,
            crate::app_error::AppErrorCode::ConfigurationMissing
        ));
        assert_eq!(error.i18n_key.as_deref(), Some("aiAssistant.noProvider"));
    }

    #[tokio::test]
    async fn a_conversation_that_does_not_exist_is_not_a_suggestion_failure() {
        let db = fresh_in_memory_db().await;
        crate::db::service::model_provider_service::create(
            &db.conn,
            "openai".to_string(),
            "https://api.openai.com/v1".to_string(),
            "sk-test".to_string(),
            "claude_code".to_string(),
            None,
        )
        .await
        .expect("provider");
        update_ai_assistant_settings_core(&db, settings_with_provider(1))
            .await
            .expect("settings");

        let error = suggest_conversation_tags_core(&db, 424242)
            .await
            .expect_err("must fail");

        assert!(
            error.to_string().contains("424242"),
            "the error should name the conversation: {error}"
        );
    }

    /// 确认过的标签必须真的落库，并且来源是 AI——这是"撤销 AI 那批"的依据。
    #[tokio::test]
    async fn confirming_a_suggestion_writes_the_tags_as_ai() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/ai-cmd-apply").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let tag = conversation_tag_service::create_tag(&db.conn, None, "bug", "#d73a4a")
            .await
            .expect("tag");
        let emitter = EventEmitter::test_web_only(Arc::new(WebEventBroadcaster::new()));

        let summary = apply_suggested_tags_core(
            &emitter,
            &db,
            conv,
            vec![tag.id],
            vec![NewTagRequest {
                name: "性能".to_string(),
                color: "#0e8a16".to_string(),
                folder_id: None,
            }],
        )
        .await
        .expect("apply");

        assert_eq!(
            summary.tag_ids.len(),
            2,
            "both the existing and the new tag land"
        );

        // 来源是 AI。按 tag_id 排序，因为两行的写入顺序由标签名决定。
        let mut sources = crate::db::entities::conversation_tag_link::Entity::find()
            .filter(crate::db::entities::conversation_tag_link::Column::ConversationId.eq(conv))
            .all(&db.conn)
            .await
            .expect("rows")
            .into_iter()
            .map(|row| row.source)
            .collect::<Vec<_>>();
        sources.sort();
        assert_eq!(sources, vec!["ai".to_string(), "ai".to_string()]);
    }

    #[tokio::test]
    async fn a_rejected_confirmation_leaves_no_tags_or_events() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/ai-cmd-atomic").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster);

        let result = apply_suggested_tags_core(
            &emitter,
            &db,
            conv,
            vec![],
            vec![
                NewTagRequest {
                    name: "本不该留下的标签".to_string(),
                    color: "#0e8a16".to_string(),
                    folder_id: None,
                },
                NewTagRequest {
                    name: "后一个标签不合法".to_string(),
                    color: "not-a-color".to_string(),
                    folder_id: None,
                },
            ],
        )
        .await;

        assert!(result.is_err());
        assert!(conversation_tag_service::list_tags(&db.conn)
            .await
            .unwrap()
            .is_empty());
        assert!(
            crate::db::service::conversation_service::get_by_id(&db.conn, conv)
                .await
                .unwrap()
                .tag_ids
                .is_empty()
        );
        assert!(
            rx.try_recv().is_err(),
            "失败的确认不能向其他客户端发布半成品"
        );
    }

    /// 标签定义变化要广播出去，否则其他窗口的标签选择器不会出现新标签。
    #[tokio::test]
    async fn confirming_a_suggestion_broadcasts_the_new_tag_definition() {
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/ai-cmd-broadcast").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;

        apply_suggested_tags_core(
            &emitter,
            &db,
            conv,
            vec![],
            vec![NewTagRequest {
                name: "新标签".to_string(),
                color: "#0e8a16".to_string(),
                folder_id: None,
            }],
        )
        .await
        .expect("apply");

        let definition = rx.try_recv().expect("the tag definition went out");
        assert_eq!(definition.channel, CONVERSATION_TAG_CHANGED_EVENT);
        assert_eq!(definition.payload["kind"], "upsert");
        assert_eq!(definition.payload["tag"]["name"], "新标签");
    }

    /// 生成标题在门禁不允许时返回 None，而不是一个错误——"现在不该生成"是
    /// 正常路径。
    #[tokio::test]
    async fn generating_a_title_when_the_source_is_the_agent_is_a_no_op() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/ai-cmd-title-off").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let emitter = EventEmitter::test_web_only(Arc::new(WebEventBroadcaster::new()));
        update_ai_assistant_settings_core(
            &db,
            AiAssistantSettings {
                provider_id: Some(1),
                tag_model: "m".to_string(),
                title_source: TitleSource::Agent,
                ..AiAssistantSettings::default()
            },
        )
        .await
        .expect("settings");

        let outcome = generate_conversation_title_core(&emitter, &db, conv, true)
            .await
            .expect("no error, just skipped");

        assert_eq!(outcome, None);
    }

    #[tokio::test]
    async fn a_folder_scoped_new_tag_is_refused_for_a_chat_conversation() {
        use crate::db::service::folder_service;

        let db = fresh_in_memory_db().await;
        let chat = folder_service::add_chat_folder(&db.conn, "/tmp/ai-cmd-chat")
            .await
            .expect("chat folder")
            .id;
        let conv = seed_conversation(&db, chat, AgentType::ClaudeCode).await;
        let regular = seed_folder(&db, "/tmp/ai-cmd-regular").await;
        let emitter = EventEmitter::test_web_only(Arc::new(WebEventBroadcaster::new()));

        let error = apply_suggested_tags_core(
            &emitter,
            &db,
            conv,
            vec![],
            vec![NewTagRequest {
                name: "这个文件夹的标签".to_string(),
                color: "#0e8a16".to_string(),
                folder_id: Some(regular),
            }],
        )
        .await
        .expect_err("a chat conversation cannot take a folder tag");

        assert!(
            error.to_string().contains("folder"),
            "expected a scope refusal, got {error}"
        );
    }
}
