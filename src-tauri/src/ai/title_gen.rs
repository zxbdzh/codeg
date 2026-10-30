//! 会话标题的编排：门禁 → 取上下文 → 组提示词 → 问模型 → 清洗 → 写入。
//!
//! 与打标签一样拆成两半：门禁与请求都可以被确定地测试（时间点是传进来的，模型
//! 是注入的），只有"从磁盘解析出会话正文"这一小段必须靠真文件。
//!
//! 节流状态只放内存：它是省钱的启发式，重启后重新计一遍没有坏处；而把它落库
//! 会引入一个需要在多窗口之间同步、永远说不清对不对的状态。

use std::collections::{HashMap, HashSet};
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

/// 最新一轮用户正文的**身份**指纹。
///
/// 刻意不用正文字符串比较：用户连着发两句一样的"继续"是两轮不同内容，只比
/// 字符串会让第二轮永远判成"没有新内容"，标题再也不刷新。身份取 `id + 时间戳`
/// 这个组合——同一轮的重放事件两者都相同，新一轮至少时间戳不同。
///
/// `None` = 最新用户轮没有有效正文（空白、纯工具轮、还没有用户发言），调用方
/// 据此跳过：没有内容可总结。
pub fn turn_fingerprint(turns: &[MessageTurn]) -> Option<String> {
    let turn = turns.iter().rev().find(|turn| {
        matches!(turn.role, TurnRole::User)
            && text_of_turn(turn).is_some_and(|t| !t.trim().is_empty())
    })?;

    Some(format!("{}@{}", turn.id, turn.timestamp.timestamp_millis()))
}

/// 一次生成机会的全部输入。
#[derive(Debug, Clone, Copy)]
pub struct TitleAttempt<'a> {
    pub conversation_id: i32,
    pub source: TitleSource,
    pub title_locked: bool,
    pub title_is_empty: bool,
    /// 最新一轮用户正文的**身份**指纹（见 [`turn_fingerprint`]），不是正文字符串。
    pub newest_round: Option<&'a str>,
    pub force: bool,
    pub now: DateTime<Utc>,
    pub min_interval_seconds: u64,
}

/// 历史门禁测试使用的结果标记；生产请求在 reserve 时即登记尝试。
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TitleSettlement {
    /// 真的拿到标题了。
    Recorded,
    /// 请求失败或取消。也占用节流窗口，只是不更新"最新轮次"。
    Failed,
}

/// 每条会话的节流状态（内存）。
#[derive(Default)]
pub struct TitleThrottle {
    inner: Mutex<ThrottleInner>,
}

#[derive(Default)]
struct ThrottleInner {
    /// 上一次占用这条会话节流窗口的时刻。成功与失败都记——失败同样花了
    /// 一次请求机会，不能每轮重试同一轮内容。
    last_attempt: HashMap<i32, DateTime<Utc>>,
    /// 上一次已尝试的轮次指纹；成功、失败和取消后的同轮重放都跳过。
    last_round: HashMap<i32, String>,
    /// 正在生成中的会话。只在检查/登记时持短锁，不跨网络 await 持锁。
    in_flight: HashSet<i32>,
}

/// 预留结果：预留成功时持有这个守卫，`Drop` 负责释放 in-flight。
///
/// 之所以用 RAII 而不是让调用方记得 `release`：失败、提前返回、任务被取消
/// （`await` 点在取消处直接析构局部变量）都必须解除占用，靠人写代码保证不了。
pub struct TitleReservation<'a> {
    throttle: &'a TitleThrottle,
    conversation_id: i32,
}

impl Drop for TitleReservation<'_> {
    fn drop(&mut self) {
        let mut inner = self.throttle.inner.lock().expect("title throttle lock");
        inner.in_flight.remove(&self.conversation_id);
    }
}

impl TitleThrottle {
    pub fn new() -> Self {
        Self::default()
    }

    /// 这一轮该不该生成标题。
    ///
    /// 只读、不改状态，供测试与诊断用。**生产路径必须走 [`Self::reserve`]**——
    /// 先查后记是非原子的，两个并发事件会同时看到"该生成"。
    pub fn should_generate(&self, attempt: TitleAttempt<'_>) -> bool {
        let inner = self.inner.lock().expect("title throttle lock");
        self.gate_passes(&inner, attempt)
    }

    /// 门禁判断（持锁调用，纯读）。
    fn gate_passes(&self, inner: &ThrottleInner, attempt: TitleAttempt<'_>) -> bool {
        let seconds_since_last_attempt = inner
            .last_attempt
            .get(&attempt.conversation_id)
            .map(|last| (attempt.now - *last).num_seconds().max(0) as u64);

        // “有新内容”和上一次已尝试的轮次指纹比：同一轮即使被触发
        // 两次（事件重放、重复的 TurnComplete），也不该生成两次。
        let has_new_round = match (
            attempt.newest_round,
            inner.last_round.get(&attempt.conversation_id),
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
                has_new_user_text: has_new_round,
                force: attempt.force,
            },
            attempt.min_interval_seconds,
        )
    }

    /// 原子地"检查 + 占位"。
    ///
    /// 一次持锁完成门禁判断与 in-flight 登记：并发的事件重放第二个会看到
    /// in-flight 已占而直接跳过。返回守卫覆盖请求周期，析构即释放占用。
    pub fn reserve(&self, attempt: TitleAttempt<'_>) -> Option<TitleReservation<'_>> {
        let mut inner = self.inner.lock().expect("title throttle lock");

        // 同一条会话已经在生成中：重复事件不重试，force 也不重入——重入只会
        // 再烧一次 token，且两次写入会互相覆盖。
        if inner.in_flight.contains(&attempt.conversation_id) {
            return None;
        }
        if !self.gate_passes(&inner, attempt) {
            return None;
        }

        inner.in_flight.insert(attempt.conversation_id);
        inner
            .last_attempt
            .insert(attempt.conversation_id, attempt.now);
        if let Some(round) = attempt.newest_round {
            inner
                .last_round
                .insert(attempt.conversation_id, round.to_string());
        }
        Some(TitleReservation {
            throttle: self,
            conversation_id: attempt.conversation_id,
        })
    }

    /// 仅供既有门禁测试构造历史；生产必须使用原子的 reserve。
    #[cfg(test)]
    fn settle(
        &self,
        conversation_id: i32,
        newest_round: Option<&str>,
        outcome: TitleSettlement,
        now: DateTime<Utc>,
    ) {
        let mut inner = self.inner.lock().expect("title throttle lock");
        inner.last_attempt.insert(conversation_id, now);
        if outcome == TitleSettlement::Recorded {
            if let Some(round) = newest_round {
                inner.last_round.insert(conversation_id, round.to_string());
            }
        }
    }

    /// 测试中的历史状态构造，不作为生产请求入口。
    #[cfg(test)]
    fn record(&self, conversation_id: i32, newest_round: Option<&str>, now: DateTime<Utc>) {
        self.settle(
            conversation_id,
            newest_round,
            TitleSettlement::Recorded,
            now,
        );
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
    let (detail, _) = get_folder_conversation_core(conn, conversation_id)
        .await
        .map_err(|error| AiFlowError::Conversation(error.to_string()))?;
    generate_title_from_turns(
        conn,
        client,
        throttle,
        conversation_id,
        &detail.turns,
        force,
        now,
    )
    .await
}

/// 自动任务可传入“持久化历史 + 刚完成轮次”的正文；与手动刷新共用门禁和节流。
pub async fn generate_title_from_turns(
    conn: &DatabaseConnection,
    client: &dyn AiClient,
    throttle: &TitleThrottle,
    conversation_id: i32,
    turns: &[MessageTurn],
    force: bool,
    now: DateTime<Utc>,
) -> Result<TitleOutcome, AiFlowError> {
    let settings = settings::load(conn).await?;
    let summary = conversation_service::get_by_id(conn, conversation_id).await?;
    if settings.title_source == TitleSource::Agent || summary.title_locked {
        return Ok(TitleOutcome::Skipped);
    }
    let newest_round = turn_fingerprint(turns);
    let attempt = TitleAttempt {
        conversation_id,
        source: settings.title_source,
        title_locked: summary.title_locked,
        title_is_empty: summary.title.as_deref().is_none_or(|t| t.trim().is_empty()),
        newest_round: newest_round.as_deref(),
        force,
        now,
        min_interval_seconds: settings.title_min_interval_seconds,
    };
    if !throttle.should_generate(attempt) {
        return Ok(TitleOutcome::Skipped);
    }
    let availability = settings::availability(conn, &settings).await?;
    if !availability.is_ready() {
        return Err(AiFlowError::NotConfigured(availability));
    }
    let provider = resolve_provider(conn, &settings).await?;
    let context = build_context(turns, settings.context_turns, MAX_CONTEXT_CHARS);
    if context.is_empty() {
        return Err(AiFlowError::EmptyConversation);
    }
    // 最后一次门禁与登记在同一锁内完成；失败或任务取消也已消费本轮请求机会。
    let Some(_reservation) = throttle.reserve(attempt) else {
        return Ok(TitleOutcome::Skipped);
    };
    let title = request_title(
        client,
        &settings,
        &provider,
        &context,
        summary.title.as_deref(),
    )
    .await?;
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
            newest_round: Some("u1@100"),
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
        throttle.record(1, Some("u1@100"), at(0));
        assert!(
            !throttle.should_generate(attempt(at(10))),
            "10s < the 30s minimum"
        );
        // 31 秒过了间隔，但这一轮还是同一个指纹：没有新内容就不该再生成。
        assert!(
            !throttle.should_generate(attempt(at(31))),
            "the same user round is not new content"
        );
        assert!(
            throttle.should_generate(TitleAttempt {
                newest_round: Some("u2@200"),
                ..attempt(at(31))
            }),
            "31s plus a new user round clears both checks"
        );
    }

    #[test]
    fn replaying_the_same_user_turn_does_not_generate_again() {
        let throttle = TitleThrottle::new();
        throttle.record(1, Some("u1@100"), at(0));

        let same_turn = TitleAttempt {
            newest_round: Some("u1@100"),
            now: at(600),
            ..attempt(at(600))
        };
        let next_turn = TitleAttempt {
            newest_round: Some("u2@200"),
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
        throttle.record(1, Some("u1@100"), at(0));

        let forced = TitleAttempt {
            force: true,
            now: at(5),
            ..attempt(at(5))
        };

        assert!(throttle.should_generate(forced));
    }

    // ---- 原子预留 ----

    /// 预留之后守卫还活着时，同一条会话再来一次必须拿不到预留——包括 force。
    /// 这正是"should_generate + record 分离"漏掉的那种并发重复请求。
    #[test]
    fn a_reserved_conversation_refuses_a_second_request_even_when_forced() {
        let throttle = TitleThrottle::new();

        let first = throttle.reserve(attempt(at(0))).expect("first reserves");
        assert!(
            throttle.reserve(attempt(at(0))).is_none(),
            "the same round replayed while one request is running must not retry"
        );
        assert!(
            throttle
                .reserve(TitleAttempt {
                    force: true,
                    ..attempt(at(0))
                })
                .is_none(),
            "force re-enters neither: two concurrent requests would race on the write"
        );

        // 守卫析构后 in-flight 才释放（30s 未过，同轮指纹也没变，所以此刻
        // 仍然不该放行——这里只证明释放本身发生了）。
        drop(first);
        assert!(
            throttle
                .reserve(TitleAttempt {
                    force: true,
                    ..attempt(at(0))
                })
                .is_some(),
            "dropping the reservation releases the in-flight slot for explicit refresh"
        );
    }

    /// 取消/失败也必须释放 in-flight：`await` 点上被取消时局部守卫直接析构，
    /// 这正是用 RAII 而不是手写 release 的原因。
    #[test]
    fn a_cancelled_request_releases_the_in_flight_slot() {
        let throttle = TitleThrottle::new();

        {
            let _reserved = throttle.reserve(attempt(at(0))).expect("reserves");
        }

        assert!(
            throttle
                .reserve(TitleAttempt {
                    newest_round: Some("next@40"),
                    ..attempt(at(40))
                })
                .is_some(),
            "a dropped reservation frees the slot for the next round"
        );
    }

    /// 失败也要占节流窗口：否则每一轮结束都会对着同一轮内容重试一次。
    #[test]
    fn a_failure_occupies_the_window_and_blocks_automatic_replay() {
        let throttle = TitleThrottle::new();
        let reserved = throttle.reserve(attempt(at(0))).expect("reserves");
        throttle.settle(1, Some("u1@100"), TitleSettlement::Failed, at(0));
        drop(reserved);

        assert!(
            !throttle.should_generate(attempt(at(10))),
            "a failed request still spent the attempt"
        );
        assert!(
            !throttle.should_generate(attempt(at(30))),
            "a failed round replay still must not spend another request"
        );
        assert!(throttle.should_generate(TitleAttempt {
            newest_round: Some("next@31"),
            ..attempt(at(31))
        }));
    }

    /// 成功后同轮指纹被记住，重放跳过。
    #[test]
    fn a_recorded_round_is_not_tried_again() {
        let throttle = TitleThrottle::new();
        let reserved = throttle.reserve(attempt(at(0))).expect("reserves");
        throttle.settle(1, Some("u1@100"), TitleSettlement::Recorded, at(0));
        drop(reserved);

        assert!(!throttle.should_generate(attempt(at(600))));
        assert!(throttle.should_generate(TitleAttempt {
            newest_round: Some("u2@200"),
            ..attempt(at(600))
        }));
    }

    #[tokio::test]
    async fn completed_round_requests_are_throttled_even_after_failure_and_equal_words_are_new_rounds(
    ) {
        use crate::db::service::model_provider_service;
        use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
        use crate::models::AgentType;
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/title-flow-rounds").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;
        let provider = model_provider_service::create(
            &db.conn,
            "test".into(),
            "https://example.com/v1".into(),
            "test-key".into(),
            "codex".into(),
            None,
        )
        .await
        .unwrap();
        settings::save(
            &db.conn,
            &AiAssistantSettings {
                provider_id: Some(provider.id),
                tag_model: "test".into(),
                ..AiAssistantSettings::default()
            },
        )
        .await
        .unwrap();
        let throttle = TitleThrottle::new();
        let client =
            FakeAiClient::with_replies(vec![Err(AiError::Unauthorized), Ok("新的标题".into())]);
        let first = vec![user_round("first", at(0), "继续")];
        assert!(
            generate_title_from_turns(&db.conn, &client, &throttle, id, &first, false, at(0))
                .await
                .is_err()
        );
        assert_eq!(
            generate_title_from_turns(&db.conn, &client, &throttle, id, &first, false, at(60))
                .await
                .unwrap(),
            TitleOutcome::Skipped,
            "失败也处理过此轮，重放不能自动再次计费"
        );
        let second = vec![user_round("second", at(61), "继续")];
        assert_eq!(
            generate_title_from_turns(&db.conn, &client, &throttle, id, &second, false, at(61))
                .await
                .unwrap(),
            TitleOutcome::Generated("新的标题".into())
        );
        conversation_service::update_title(&db.conn, id, "用户手选".into())
            .await
            .unwrap();
        assert_eq!(
            generate_title_from_turns(&db.conn, &client, &throttle, id, &second, true, at(120))
                .await
                .unwrap(),
            TitleOutcome::Skipped
        );
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

    // ---- 轮次身份 ----

    fn turn(id: &str, role: TurnRole, at: DateTime<Utc>, text: &str) -> MessageTurn {
        MessageTurn {
            id: id.to_string(),
            role,
            blocks: vec![crate::models::message::ContentBlock::Text {
                text: text.to_string(),
            }],
            timestamp: at,
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        }
    }

    fn at_secs(seconds: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(1_800_000_000 + seconds, 0).unwrap()
    }

    fn user_round(id: &str, at: DateTime<Utc>, text: &str) -> MessageTurn {
        turn(id, TurnRole::User, at, text)
    }

    /// 同一句话在两次不同轮次里必须算两轮：用 id + 时间戳做身份，而不是比较
    /// 正文字符串——否则连着两句"继续"会让第二轮永远刷不出标题。
    #[test]
    fn the_same_words_in_two_turns_are_two_rounds() {
        let first = turn_fingerprint(&[user_round("u1", at_secs(10), "继续")]);
        let second = turn_fingerprint(&[user_round("u2", at_secs(20), "继续")]);

        assert!(first.is_some());
        assert_ne!(first, second, "同样的正文、不同的轮次身份，必须是新的一轮");
    }

    /// 重复事件重放同一轮：身份必须稳定，节流据此跳过而不是再烧一次 token。
    #[test]
    fn replaying_one_round_keeps_the_same_fingerprint() {
        let turns = [user_round("u1", at_secs(10), "继续")];

        assert_eq!(
            turn_fingerprint(&turns).as_deref(),
            Some("u1@1800000010000"),
            "同轮身份由消息 id 和发送时刻确定，不能退化成正文比较"
        );
    }

    /// 没有用户正文（只有空正文或工具轮）时没有指纹：无内容可总结。
    #[test]
    fn a_round_without_user_prose_has_no_fingerprint() {
        let blank = turn("u1", TurnRole::User, at_secs(10), "   ");
        let tool_only = MessageTurn {
            id: "a1".to_string(),
            role: TurnRole::Assistant,
            blocks: vec![crate::models::message::ContentBlock::ToolUse {
                tool_use_id: Some("t".to_string()),
                tool_name: "Bash".to_string(),
                input_preview: None,
                status: None,
                meta: None,
            }],
            timestamp: at_secs(11),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        };

        assert_eq!(turn_fingerprint(&[blank]), None);
        assert_eq!(turn_fingerprint(&[tool_only]), None);
        assert_eq!(turn_fingerprint(&[]), None);
    }

    /// 指纹只认最后一条用户轮：中间夹一轮助手回复不该改变"最新用户正文"的口径。
    #[test]
    fn the_fingerprint_names_the_last_user_round() {
        let mut turns = vec![user_round("u1", at_secs(10), "第一句")];
        turns.push(turn("a1", TurnRole::Assistant, at_secs(11), "回答"));

        assert_eq!(
            turn_fingerprint(&turns),
            turn_fingerprint(&[user_round("u1", at_secs(10), "第一句")])
        );
    }
}
