//! 打标签的编排：取上下文 → 组提示词 → 问模型 → 收成结构化建议。
//!
//! 拆成"取数"与"请求"两半是刻意的：会话正文要从磁盘上的会话文件解析，只有真
//! 文件才能端到端跑通；而所有会出错的判断（可用性、池子过滤、缓存、失败降级）
//! 都在 [`request_suggestion`] 里，它可以被假客户端确定地驱动。

use std::collections::HashMap;
use std::sync::Mutex;

use sea_orm::DatabaseConnection;
use sha2::{Digest, Sha256};

use crate::ai::client::{AiClient, AiError, CompletionRequest};
use crate::ai::context::{build_tag_context, MAX_CONTEXT_CHARS};
use crate::ai::output::{
    parse_tag_suggestion, SuggestedNewTag, SuggestedTag, TagSuggestion, MAX_SUGGESTED_TAGS,
};
use crate::ai::settings::{self, AiAssistantSettings, AiAvailability, AiTask};
use crate::ai::wire;
use crate::commands::conversations::get_folder_conversation_core;
use crate::db::entities::model_provider;
use crate::db::error::DbError;
use crate::db::service::{conversation_tag_service, model_provider_service};
use crate::models::ConversationTagDetail;

/// 一次建议为什么没做成。每一种都对应前端的一句人话。
#[derive(Debug, thiserror::Error)]
pub enum AiFlowError {
    #[error("the ai assistant is not available: {0:?}")]
    NotConfigured(AiAvailability),
    #[error("the conversation could not be read: {0}")]
    Conversation(String),
    #[error("the conversation has no prose to read")]
    EmptyConversation,
    #[error("the model's answer could not be used: {0}")]
    Malformed(String),
    #[error(transparent)]
    Client(#[from] AiError),
    #[error(transparent)]
    Db(#[from] DbError),
}

/// 建议器的输入：已经取好的上下文与允许挑的标签池。
#[derive(Debug, Clone)]
pub struct SuggestionInput {
    pub context: String,
    pub available: Vec<ConversationTagDetail>,
}

/// 拼提示词。池子的名字要原样给模型看——它会照着这些名字回答，我们再按名字
/// 把它们映射回 id，所以名字必须与库里完全一致。
pub fn build_tag_prompt(context: &str, available: &[ConversationTagDetail]) -> String {
    let mut prompt = String::new();
    prompt.push_str("你在帮用户给一条编码会话打标签。\n");
    prompt.push_str(&format!(
        "先判断会话整体主线，再从「可选标签」里挑最多 {MAX_SUGGESTED_TAGS} 个最贴切的；如果都不合适，可以在 new_tags 里提议新标签。\n"
    ));
    prompt.push_str(
        "标签选择规则：优先描述会话正在处理的主题、领域或具体对象，例如“数字人”“MCP”“电商主图”。\n",
    );
    prompt.push_str(
        "只有当用户明确把某个工作动作本身当作主要目标时，才建议动作标签，例如“自动化集成”“功能规划”“部署”。\n",
    );
    prompt.push_str(
        "不要因为这是编码任务、出现 API 或脚本，就推断出“开发”“优化”“自动化集成”等泛动作标签；如果主题明确，主题标签排在动作标签前。\n",
    );
    prompt.push_str("没有足够证据的标签不要猜。每条建议理由要指出会话中的主题证据，不能只说“这是一个开发任务”。\n");
    prompt.push_str("每条建议给一句简短理由。不要解释你的思路，只返回 JSON：\n");
    prompt.push_str(
        r##"{"tags":[{"name":"标签名","reason":"为什么"}],"new_tags":[{"name":"新标签名","color":"#rrggbb"}]}"##,
    );
    prompt.push_str("\n\n<可选标签>\n");
    if available.is_empty() {
        prompt.push_str("（这个会话还没有任何可用标签，只能提 new_tags）\n");
    } else {
        for tag in available {
            prompt.push_str("- ");
            prompt.push_str(&tag.name);
            prompt.push('\n');
        }
    }
    prompt.push_str("</可选标签>\n\n<对话>\n");
    prompt.push_str(context);
    prompt.push_str("\n</对话>");
    prompt
}

/// 上下文指纹。内容不变就不必再问一次模型——同一个会话连点两下，第二下应当
/// 是免费且相同的。
pub fn context_fingerprint(context: &str, available: &[ConversationTagDetail]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(context.as_bytes());
    hasher.update([0u8]);
    // 标签池也是模型输出的输入；池子变化时必须重新窄化缓存结果。
    for tag in available {
        hasher.update(tag.id.to_le_bytes());
        hasher.update(tag.name.as_bytes());
        hasher.update([0u8]);
    }
    format!("{:x}", hasher.finalize())
}

/// 每个会话最近一次建议的小缓存。
///
/// 刻意做成有界 + 手动管理而不是无界 HashMap：这是一个纯为了省钱的缓存，没有
/// 任何东西应该因为它而无限增长。
pub struct SuggestionCache {
    inner: Mutex<CacheInner>,
}

struct CacheInner {
    capacity: usize,
    /// 插入顺序，最旧的在前面。
    order: Vec<i32>,
    entries: HashMap<i32, (String, TagSuggestion)>,
}

impl SuggestionCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(CacheInner {
                capacity: capacity.max(1),
                order: Vec::new(),
                entries: HashMap::new(),
            }),
        }
    }

    /// 只有指纹一致才算命中：会话又长了一轮就必须重新问。
    pub fn get(&self, conversation_id: i32, fingerprint: &str) -> Option<TagSuggestion> {
        let inner = self.inner.lock().expect("suggestion cache lock");
        let (stored, suggestion) = inner.entries.get(&conversation_id)?;
        if stored == fingerprint {
            Some(suggestion.clone())
        } else {
            None
        }
    }

    pub fn put(&self, conversation_id: i32, fingerprint: &str, suggestion: TagSuggestion) {
        let mut inner = self.inner.lock().expect("suggestion cache lock");
        if !inner.entries.contains_key(&conversation_id) {
            inner.order.push(conversation_id);
        }
        inner
            .entries
            .insert(conversation_id, (fingerprint.to_string(), suggestion));
        while inner.order.len() > inner.capacity {
            let oldest = inner.order.remove(0);
            inner.entries.remove(&oldest);
        }
    }

    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("suggestion cache lock")
            .entries
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// 只留下池子里真有的标签，并把名字改回库里的写法。
///
/// 模型经常把大小写或空格写歪（`" Bug "`），直接拿它去查 id 会查不到，用户就
/// 会看到一个"打不上的建议"。新标签里与池子重名的也要剔掉，否则会在确认框里
/// 变成"新建一个已经存在的标签"。
fn narrow_to_pool(suggestion: TagSuggestion, available: &[ConversationTagDetail]) -> TagSuggestion {
    let pool: HashMap<String, &str> = available
        .iter()
        .map(|tag| (tag.name.to_lowercase(), tag.name.as_str()))
        .collect();

    let tags: Vec<SuggestedTag> = suggestion
        .tags
        .into_iter()
        .filter_map(|tag| {
            let canonical = pool.get(&tag.name.to_lowercase())?;
            Some(SuggestedTag {
                name: (*canonical).to_string(),
                reason: tag.reason,
            })
        })
        .take(MAX_SUGGESTED_TAGS)
        .collect();

    let new_tags: Vec<SuggestedNewTag> = suggestion
        .new_tags
        .into_iter()
        .filter(|tag| !pool.contains_key(&tag.name.to_lowercase()))
        .take(MAX_SUGGESTED_TAGS)
        .collect();

    TagSuggestion { tags, new_tags }
}

/// 真正发请求那一步。可用性与提供方由调用方先解析好，这里只管拼、发、收。
pub async fn request_suggestion(
    client: &dyn AiClient,
    settings: &AiAssistantSettings,
    provider: &model_provider::Model,
    input: &SuggestionInput,
) -> Result<TagSuggestion, AiFlowError> {
    let model = settings
        .model_for(AiTask::Tagging)
        .ok_or(AiFlowError::NotConfigured(AiAvailability::NoModel))?;
    let protocol = settings.protocol();
    let prompt = build_tag_prompt(&input.context, &input.available);

    let request = CompletionRequest {
        protocol,
        url: wire::endpoint(&provider.api_url, protocol),
        headers: wire::auth_headers(protocol, settings.key_header, &provider.api_key),
        body: wire::request_body(protocol, model, &prompt, wire::MAX_SUGGESTION_OUTPUT_TOKENS),
        api_key: provider.api_key.clone(),
    };

    let raw = client.complete(request).await?;
    let suggestion = parse_tag_suggestion(&raw)
        .ok_or_else(|| AiFlowError::Malformed(raw.chars().take(200).collect()))?;
    Ok(narrow_to_pool(suggestion, &input.available))
}

/// 给一条会话提标签建议。命中缓存时不发请求、不计费。
pub async fn suggest_tags(
    conn: &DatabaseConnection,
    client: &dyn AiClient,
    cache: &SuggestionCache,
    conversation_id: i32,
    force: bool,
) -> Result<TagSuggestion, AiFlowError> {
    let settings = settings::load(conn).await?;
    let availability = settings::availability(conn, &settings).await?;
    if !availability.is_ready() {
        return Err(AiFlowError::NotConfigured(availability));
    }
    let provider = resolve_provider(conn, &settings).await?;

    let (detail, _) = get_folder_conversation_core(conn, conversation_id)
        .await
        .map_err(|error| {
            AiFlowError::Conversation(format!("conversation {conversation_id}: {error}"))
        })?;
    let context = build_tag_context(&detail.turns, settings.context_turns, MAX_CONTEXT_CHARS);
    if context.is_empty() {
        return Err(AiFlowError::EmptyConversation);
    }

    let available =
        conversation_tag_service::available_tags_for_conversation(conn, conversation_id)
            .await
            .map_err(|error| {
                AiFlowError::Conversation(format!("conversation {conversation_id}: {error}"))
            })?;
    let fingerprint = context_fingerprint(&context, &available);
    // force = 用户点了「换一批」：同一份上下文也重新问一次模型，
    // 否则缓存会把上一次的答案原样还回去。
    if !force {
        if let Some(hit) = cache.get(conversation_id, &fingerprint) {
            return Ok(hit);
        }
    }
    let input = SuggestionInput { context, available };

    let suggestion = request_suggestion(client, &settings, &provider, &input).await?;
    cache.put(conversation_id, &fingerprint, suggestion.clone());
    Ok(suggestion)
}

/// 设置里的提供方 id 一定能解析出一条行——可用性检查已经回表确认过了，这里
/// 只是取出来。
pub(crate) async fn resolve_provider(
    conn: &DatabaseConnection,
    settings: &AiAssistantSettings,
) -> Result<model_provider::Model, AiFlowError> {
    let provider_id = settings
        .provider_id
        .ok_or(AiFlowError::NotConfigured(AiAvailability::NoProvider))?;
    model_provider_service::get_by_id(conn, provider_id)
        .await?
        .ok_or(AiFlowError::NotConfigured(AiAvailability::ProviderMissing))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::fake::FakeAiClient;

    fn tag(id: i32, name: &str) -> ConversationTagDetail {
        ConversationTagDetail {
            id,
            folder_id: None,
            name: name.to_string(),
            color: "#d73a4a".to_string(),
            sort_order: 0,
        }
    }

    fn settings_with_model(model: &str) -> AiAssistantSettings {
        AiAssistantSettings {
            provider_id: Some(1),
            tag_model: model.to_string(),
            ..AiAssistantSettings::default()
        }
    }

    fn provider(api_url: &str) -> model_provider::Model {
        model_provider::Model {
            id: 1,
            name: "openai".to_string(),
            api_url: api_url.to_string(),
            api_key: "sk-test".to_string(),
            agent_types_json: "[]".to_string(),
            agent_type: "claude_code".to_string(),
            model: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn input() -> SuggestionInput {
        SuggestionInput {
            context: "User: 侧栏标签不刷新\nAssistant: 因为没广播更新事件".to_string(),
            available: vec![tag(1, "bug"), tag(2, "性能")],
        }
    }

    #[test]
    fn the_prompt_carries_the_pool_and_the_conversation() {
        let prompt = build_tag_prompt(&input().context, &input().available);

        assert!(prompt.contains("- bug"), "the pool must be listed by name");
        assert!(prompt.contains("- 性能"));
        assert!(
            prompt.contains("侧栏标签不刷新"),
            "the conversation must be in it"
        );
        assert!(
            prompt.contains("new_tags"),
            "the answer shape must be stated"
        );
        assert!(prompt.contains("优先描述会话正在处理的主题"));
        assert!(prompt.contains("只有当用户明确把某个工作动作本身当作主要目标时"));
        assert!(prompt.contains("不要因为这是编码任务、出现 API 或脚本"));
    }

    #[test]
    fn the_prompt_says_what_to_do_when_nothing_is_available() {
        let prompt = build_tag_prompt("User: 你好", &[]);

        assert!(prompt.contains("只能提 new_tags"));
    }

    #[test]
    fn the_fingerprint_tracks_the_text_and_tag_pool() {
        assert_eq!(
            context_fingerprint("abc", &[]),
            context_fingerprint("abc", &[])
        );
        assert_ne!(
            context_fingerprint("abc", &[]),
            context_fingerprint("abd", &[])
        );
        assert_ne!(
            context_fingerprint("abc", &[tag(1, "bug")]),
            context_fingerprint("abc", &[tag(2, "bug")])
        );
    }

    #[tokio::test]
    async fn a_suggestion_outside_the_pool_is_dropped_and_names_are_canonicalized() {
        let client = FakeAiClient::replying(
            r##"{"tags":[{"name":" BUG ","reason":"在排查缺陷"},{"name":"不存在的标签","reason":"胡说"}],
                "new_tags":[{"name":"性能","color":"#0e8a16"},{"name":"部署","color":null}]}"##,
        );

        let suggestion = request_suggestion(
            &client,
            &settings_with_model("m"),
            &provider("https://api.openai.com/v1"),
            &input(),
        )
        .await
        .expect("suggestion");

        assert_eq!(
            suggestion.tags,
            vec![SuggestedTag {
                name: "bug".to_string(),
                reason: "在排查缺陷".to_string()
            }],
            "only pool tags survive, spelled the way the pool spells them"
        );
        assert_eq!(
            suggestion.new_tags,
            vec![SuggestedNewTag {
                name: "部署".to_string(),
                color: None
            }],
            "a new tag that already exists in the pool is not proposed again"
        );
    }

    #[tokio::test]
    async fn the_request_goes_to_the_protocol_endpoint_with_the_right_headers() {
        let client = FakeAiClient::replying(r#"{"tags":[],"new_tags":[]}"#);

        request_suggestion(
            &client,
            &settings_with_model("gpt-4o-mini"),
            &provider("https://api.openai.com/v1"),
            &input(),
        )
        .await
        .expect("suggestion");

        assert_eq!(
            client.urls(),
            vec!["https://api.openai.com/v1/chat/completions".to_string()]
        );
        assert_eq!(
            client.header_names(),
            vec![vec!["authorization".to_string()]],
            "an openai provider sends the key as a bearer token"
        );
        assert!(client.prompts()[0].contains("- bug"));
    }

    #[tokio::test]
    async fn an_unusable_answer_is_a_failure_and_writes_nothing() {
        let client = FakeAiClient::replying("我觉得可以打 bug 标签");

        let error = request_suggestion(
            &client,
            &settings_with_model("m"),
            &provider("https://api.openai.com/v1"),
            &input(),
        )
        .await
        .expect_err("must fail");

        assert!(matches!(error, AiFlowError::Malformed(_)));
    }

    #[tokio::test]
    async fn a_provider_error_is_reported_as_itself() {
        let client = FakeAiClient::failing(AiError::Unauthorized);

        let error = request_suggestion(
            &client,
            &settings_with_model("m"),
            &provider("https://api.openai.com/v1"),
            &input(),
        )
        .await
        .expect_err("must fail");

        assert!(matches!(error, AiFlowError::Client(AiError::Unauthorized)));
    }

    #[tokio::test]
    async fn a_missing_model_name_never_reaches_the_network() {
        let client = FakeAiClient::replying(r#"{"tags":[],"new_tags":[]}"#);

        let error = request_suggestion(
            &client,
            &settings_with_model("  "),
            &provider("https://api.openai.com/v1"),
            &input(),
        )
        .await
        .expect_err("must fail");

        assert!(matches!(
            error,
            AiFlowError::NotConfigured(AiAvailability::NoModel)
        ));
        assert_eq!(client.request_count(), 0);
    }

    #[test]
    fn the_cache_only_hits_on_the_same_context() {
        let cache = SuggestionCache::new(4);
        cache.put(7, "abc", TagSuggestion::default());

        assert!(cache.get(7, "abc").is_some());
        assert!(cache.get(7, "abd").is_none(), "a new turn must miss");
        assert!(
            cache.get(8, "abc").is_none(),
            "different conversation, no hit"
        );
    }

    #[test]
    fn the_cache_is_bounded() {
        let cache = SuggestionCache::new(2);
        cache.put(1, "a", TagSuggestion::default());
        cache.put(2, "a", TagSuggestion::default());
        cache.put(3, "a", TagSuggestion::default());

        assert_eq!(cache.len(), 2);
        assert!(cache.get(1, "a").is_none(), "the oldest entry makes room");
        assert!(cache.get(3, "a").is_some());
    }

    #[test]
    fn storing_the_same_conversation_again_does_not_grow_the_cache() {
        let cache = SuggestionCache::new(4);
        cache.put(1, "a", TagSuggestion::default());
        cache.put(1, "b", TagSuggestion::default());

        assert_eq!(cache.len(), 1);
        assert!(cache.get(1, "b").is_some(), "the newest answer wins");
    }
}
