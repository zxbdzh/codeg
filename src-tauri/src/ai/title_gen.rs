//! 会话标题的编排：门禁 → 取上下文 → 组提示词 → 问模型 → 清洗 → 写入。
//!
//! 与打标签一样拆成两半：门禁与请求都可以被确定地测试（时间点是传进来的，模型
//! 是注入的），只有"从磁盘解析出会话正文"这一小段必须靠真文件。
//!
//! 节流状态只放内存：它是省钱的启发式，重启后重新计一遍没有坏处；而把它落库
//! 会引入一个需要在多窗口之间同步、永远说不清对不对的状态。

use std::collections::HashMap;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;

use crate::ai::client::{AiClient, CompletionRequest};
use crate::ai::context::{build_context, text_of_turn, MAX_CONTEXT_CHARS};
use crate::ai::gate::{should_generate_title, TitleGate, TitleSource};
use crate::ai::output::clean_title;
use crate::ai::settings::{self, AiAssistantSettings, AiAvailability, AiTask};
use crate::ai::suggest::{resolve_provider, AiFlowError};
use crate::ai::wire;
use crate::commands::conversations::get_folder_conversation_core;
use crate::db::entities::model_provider;
use crate::db::service::conversation_service;
use crate::models::message::{MessageTurn, TurnRole};

/// 拼标题提示词。
///
/// 已经有标题时要把当前标题一起给模型，并要求"话题没大变就保持相近"——否则
/// 每轮都会得到一个措辞不同但意思一样的新标题，侧栏看起来像在抽搐。
pub fn build_title_prompt(context: &str, current_title: Option<&str>) -> String {
    let mut prompt = String::new();
    prompt.push_str("为下面的对话生成一个简短、具体的会话标题。\n");
    prompt.push_str("只返回标题本身，不要解释、引号、Markdown 或前缀。\n");
    prompt.push_str("使用对话的主要语言，最多 12 个词。\n");
    if let Some(title) = current_title.map(str::trim).filter(|t| !t.is_empty()) {
        prompt.push_str(&format!(
            "当前标题：{title}（除非话题明显变化，否则保持相近）\n"
        ));
    }
    prompt.push_str("\n<对话>\n");
    prompt.push_str(context);
    prompt.push_str("\n</对话>");
    prompt
}

/// 这条会话最近一轮用户说了什么——用来判断"有没有新内容"。
pub fn newest_user_text(turns: &[MessageTurn]) -> Option<&str> {
    turns
        .iter()
        .rev()
        .filter(|turn| matches!(turn.role, TurnRole::User))
        .find_map(text_of_turn)
}

/// 一次生成机会的全部输入。
#[derive(Debug, Clone, Copy)]
pub struct TitleAttempt<'a> {
    pub conversation_id: i32,
    pub source: TitleSource,
    pub title_locked: bool,
    pub title_is_empty: bool,
    pub newest_user_turn: Option<&'a str>,
    pub force: bool,
    pub now: DateTime<Utc>,
    pub min_interval_seconds: u64,
}

/// 每条会话的节流状态（内存）。
#[derive(Default)]
pub struct TitleThrottle {
    inner: Mutex<ThrottleInner>,
}

#[derive(Default)]
struct ThrottleInner {
    last_attempt: HashMap<i32, DateTime<Utc>>,
    last_user_turn: HashMap<i32, String>,
}

impl TitleThrottle {
    pub fn new() -> Self {
        Self::default()
    }

    /// 这一轮该不该生成标题。
    pub fn should_generate(&self, attempt: TitleAttempt<'_>) -> bool {
        let inner = self.inner.lock().expect("title throttle lock");

        let seconds_since_last_attempt = inner
            .last_attempt
            .get(&attempt.conversation_id)
            .map(|last| (attempt.now - *last).num_seconds().max(0) as u64);

        // "有新内容"是和上一次真正生成时的最后一轮用户发言比的：同一轮即使被
        // 触发两次（比如事件重放），也不该生成两次。
        let has_new_user_text = match (
            attempt.newest_user_turn,
            inner.last_user_turn.get(&attempt.conversation_id),
        ) {
            (Some(current), Some(previous)) => current != previous,
            (Some(_), None) => true,
            (None, _) => false,
        };

        should_generate_title(
            TitleGate {
                source: attempt.source,
                title_locked: attempt.title_locked,
                title_is_empty: attempt.title_is_empty,
                seconds_since_last_attempt,
                has_new_user_text,
                force: attempt.force,
            },
            attempt.min_interval_seconds,
        )
    }

    /// 记下一次真的发出去的生成。
    pub fn record(&self, conversation_id: i32, newest_user_turn: Option<&str>, now: DateTime<Utc>) {
        let mut inner = self.inner.lock().expect("title throttle lock");
        inner.last_attempt.insert(conversation_id, now);
        if let Some(text) = newest_user_turn {
            inner
                .last_user_turn
                .insert(conversation_id, text.to_string());
        }
    }
}

/// 一次标题生成的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TitleOutcome {
    /// 生成了新标题。
    Generated(String),
    /// 门禁不允许（来源、锁定、节流、没新内容）。
    Skipped,
}

/// 真正发请求那一步。空回答按失败处理——"什么都没写"不是一个标题。
pub async fn request_title(
    client: &dyn AiClient,
    settings: &AiAssistantSettings,
    provider: &model_provider::Model,
    context: &str,
    current_title: Option<&str>,
) -> Result<String, AiFlowError> {
    let model = settings
        .model_for(AiTask::Title)
        .ok_or(AiFlowError::NotConfigured(AiAvailability::NoModel))?;
    let protocol = settings.protocol();
    let prompt = build_title_prompt(context, current_title);

    let request = CompletionRequest {
        protocol,
        url: wire::endpoint(&provider.api_url, protocol),
        headers: wire::auth_headers(protocol, settings.key_header, &provider.api_key),
        body: wire::request_body(protocol, model, &prompt, wire::MAX_TITLE_OUTPUT_TOKENS),
        api_key: provider.api_key.clone(),
    };

    let raw = client.complete(request).await?;
    clean_title(&raw)
        .ok_or_else(|| AiFlowError::Malformed("the model returned no title".to_string()))
}

/// 给一条会话重新生成标题。不写库——写入与广播留给命令层，因为它还要通知前端。
pub async fn generate_title(
    conn: &DatabaseConnection,
    client: &dyn AiClient,
    throttle: &TitleThrottle,
    conversation_id: i32,
    force: bool,
    now: DateTime<Utc>,
) -> Result<TitleOutcome, AiFlowError> {
    let settings = settings::load(conn).await?;

    let (detail, _) = get_folder_conversation_core(conn, conversation_id)
        .await
        .map_err(|error| AiFlowError::Conversation(error.to_string()))?;

    let newest_user_turn = newest_user_text(&detail.turns);
    let current_title = detail.summary.title.clone();

    let allowed = throttle.should_generate(TitleAttempt {
        conversation_id,
        source: settings.title_source,
        title_locked: detail.summary.title_locked,
        title_is_empty: current_title.as_deref().is_none_or(|t| t.trim().is_empty()),
        newest_user_turn,
        force,
        now,
        min_interval_seconds: settings.title_min_interval_seconds,
    });
    if !allowed {
        return Ok(TitleOutcome::Skipped);
    }

    // 门禁通过之后才去查可用性与正文：来源被设为"同伴"的会话不该因为一次
    // 误触而背上一次未配置的报错。
    let availability = settings::availability(conn, &settings).await?;
    if !availability.is_ready() {
        return Err(AiFlowError::NotConfigured(availability));
    }
    let provider = resolve_provider(conn, &settings).await?;

    let context = build_context(&detail.turns, settings.context_turns, MAX_CONTEXT_CHARS);
    if context.is_empty() {
        return Err(AiFlowError::EmptyConversation);
    }

    let title = request_title(
        client,
        &settings,
        &provider,
        &context,
        current_title.as_deref(),
    )
    .await?;
    // 只有真的发出去了才记节流：读不到会话或未配置不该消耗用户的等待窗口。
    throttle.record(conversation_id, newest_user_turn, now);
    Ok(TitleOutcome::Generated(title))
}

/// 把生成好的标题写回去。
///
/// 复用既有的自动标题刷新语义：值变化才写、不置 `title_locked`、不动
/// `updated_at`——标题是元数据，不该把会话顶到侧栏顶部冒充用户活动。
pub async fn apply_generated_title(
    conn: &DatabaseConnection,
    conversation_id: i32,
    title: &str,
) -> Result<bool, AiFlowError> {
    // 请求可能运行数十秒：写回前重新读取来源，防止用户期间切回同伴标题。
    // 兜底模式还必须由 SQL 再检查“仍为空”，而不是相信生成前的那次快照。
    match settings::load(conn).await?.title_source {
        TitleSource::Agent => Ok(false),
        TitleSource::Fallback => Ok(conversation_service::seed_auto_title_if_empty(
            conn,
            conversation_id,
            title.to_string(),
        )
        .await?),
        TitleSource::Codeg => {
            Ok(
                conversation_service::refresh_auto_title(conn, conversation_id, title.to_string())
                    .await?,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::client::AiError;
    use crate::ai::fake::FakeAiClient;
    use chrono::TimeZone;

    fn settings_with_model(model: &str) -> AiAssistantSettings {
        AiAssistantSettings {
            provider_id: Some(1),
            protocol: Some(crate::acp::provider_models::ModelsProtocol::Anthropic),
            tag_model: model.to_string(),
            ..AiAssistantSettings::default()
        }
    }

    fn provider() -> model_provider::Model {
        model_provider::Model {
            id: 1,
            name: "anthropic".to_string(),
            api_url: "https://api.anthropic.com".to_string(),
            api_key: "sk-ant".to_string(),
            agent_types_json: "[]".to_string(),
            agent_type: "claude_code".to_string(),
            model: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn at(seconds: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(1_800_000_000 + seconds, 0).unwrap()
    }

    fn attempt(now: DateTime<Utc>) -> TitleAttempt<'static> {
        TitleAttempt {
            conversation_id: 1,
            source: TitleSource::Codeg,
            title_locked: false,
            title_is_empty: false,
            newest_user_turn: Some("继续"),
            force: false,
            now,
            min_interval_seconds: 30,
        }
    }

    #[test]
    fn the_prompt_asks_for_one_short_line_in_the_conversations_language() {
        let prompt = build_title_prompt("User: 修一下标签刷新", None);

        assert!(prompt.contains("最多 12 个词"));
        assert!(prompt.contains("使用对话的主要语言"));
        assert!(prompt.contains("修一下标签刷新"));
        assert!(
            !prompt.contains("当前标题"),
            "a titleless conversation has nothing to stay close to"
        );
    }

    #[test]
    fn an_existing_title_is_handed_to_the_model_to_keep_it_stable() {
        let prompt = build_title_prompt("User: 继续", Some("修复标签刷新"));

        assert!(prompt.contains("当前标题：修复标签刷新"));
        assert!(prompt.contains("保持相近"));
    }

    #[test]
    fn the_throttle_lets_the_first_attempt_through_and_holds_the_next_one_back() {
        let throttle = TitleThrottle::new();

        assert!(throttle.should_generate(attempt(at(0))), "no attempt yet");
        throttle.record(1, Some("继续"), at(0));
        assert!(
            !throttle.should_generate(attempt(at(10))),
            "10s < the 30s minimum"
        );
        // 31 秒过了间隔，但这一轮用户还是那句"继续"：没有新内容就不该再生成。
        assert!(
            !throttle.should_generate(attempt(at(31))),
            "the same user turn is not new content"
        );
        assert!(
            throttle.should_generate(TitleAttempt {
                newest_user_turn: Some("再想想别的"),
                ..attempt(at(31))
            }),
            "31s plus a new user turn clears both checks"
        );
    }

    #[test]
    fn replaying_the_same_user_turn_does_not_generate_again() {
        let throttle = TitleThrottle::new();
        throttle.record(1, Some("继续"), at(0));

        let same_turn = TitleAttempt {
            newest_user_turn: Some("继续"),
            now: at(600),
            ..attempt(at(600))
        };
        let next_turn = TitleAttempt {
            newest_user_turn: Some("再换个思路"),
            now: at(600),
            ..attempt(at(600))
        };

        assert!(!throttle.should_generate(same_turn));
        assert!(throttle.should_generate(next_turn));
    }

    #[test]
    fn a_locked_title_and_the_agent_source_both_stop_generation() {
        let throttle = TitleThrottle::new();

        let locked = TitleAttempt {
            title_locked: true,
            force: true,
            ..attempt(at(0))
        };
        let agent = TitleAttempt {
            source: TitleSource::Agent,
            force: true,
            ..attempt(at(0))
        };

        assert!(!throttle.should_generate(locked));
        assert!(!throttle.should_generate(agent));
    }

    #[test]
    fn force_skips_the_interval_but_still_needs_a_configured_attempt() {
        let throttle = TitleThrottle::new();
        throttle.record(1, Some("继续"), at(0));

        let forced = TitleAttempt {
            force: true,
            now: at(5),
            ..attempt(at(5))
        };

        assert!(throttle.should_generate(forced));
    }

    #[tokio::test]
    async fn the_title_request_uses_the_anthropic_shape_and_cleans_the_answer() {
        let client = FakeAiClient::replying("```\n标题：修复标签刷新\n```");

        let title = request_title(
            &client,
            &settings_with_model("claude-haiku"),
            &provider(),
            "User: 修一下",
            None,
        )
        .await
        .expect("title");

        assert_eq!(title, "修复标签刷新");
        assert_eq!(
            client.urls(),
            vec!["https://api.anthropic.com/v1/messages".to_string()]
        );
        assert_eq!(
            client.header_names(),
            vec![vec![
                "x-api-key".to_string(),
                "anthropic-version".to_string()
            ]]
        );
    }

    #[tokio::test]
    async fn fallback_does_not_replace_a_title_that_arrived_during_generation() {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
        use crate::models::AgentType;

        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/ai-title-fallback-race").await;
        let conv = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        settings::save(
            &db.conn,
            &AiAssistantSettings {
                title_source: TitleSource::Fallback,
                ..AiAssistantSettings::default()
            },
        )
        .await
        .unwrap();
        conversation_service::refresh_auto_title(&db.conn, conv, "同伴先写入的标题".into())
            .await
            .unwrap();

        let changed = apply_generated_title(&db.conn, conv, "迟到的 AI 标题")
            .await
            .unwrap();

        assert!(!changed);
        assert_eq!(
            conversation_service::get_by_id(&db.conn, conv)
                .await
                .unwrap()
                .title
                .as_deref(),
            Some("同伴先写入的标题")
        );
    }

    #[tokio::test]
    async fn an_empty_title_is_a_failure_rather_than_an_empty_rename() {
        let client = FakeAiClient::replying("   ");

        let error = request_title(
            &client,
            &settings_with_model("m"),
            &provider(),
            "User: 修一下",
            None,
        )
        .await
        .expect_err("must fail");

        assert!(matches!(error, AiFlowError::Malformed(_)));
    }

    #[tokio::test]
    async fn a_provider_error_reaches_the_caller_intact() {
        let client = FakeAiClient::failing(AiError::Transport("timed out".to_string()));

        let error = request_title(
            &client,
            &settings_with_model("m"),
            &provider(),
            "User: 修一下",
            None,
        )
        .await
        .expect_err("must fail");

        assert!(matches!(error, AiFlowError::Client(_)));
    }
}
