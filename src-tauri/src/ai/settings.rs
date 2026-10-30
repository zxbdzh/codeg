//! AI 助手的设置与可用性。
//!
//! 刻意**不保存密钥**：这里只记"用哪一条 AI 提供方"，地址与密钥在调用时从
//! 提供方表里读。这样用户不必把同一个 key 填两遍，也避免两份密钥各自过期。

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::provider_models::{KeyHeader, ModelsProtocol};
use crate::ai::gate::{TitleSource, DEFAULT_MIN_INTERVAL_SECONDS};
use crate::db::error::DbError;
use crate::db::service::{app_metadata_service, model_provider_service};

/// `app_metadata` 里的键。一个 JSON 对象装下 AI 助手的全部设置。
pub const AI_ASSISTANT_SETTINGS_KEY: &str = "ai_assistant_settings";

/// 「最近 N 轮」的默认值。
pub const DEFAULT_CONTEXT_TURNS: usize = 6;

/// 「最近 N 轮」允许的范围。上限不是为了省钱，而是为了让"最近 N 轮"仍然
/// 是"最近"；再多的上下文该靠摘要而不是靠堆原文。
pub const MIN_ALLOWED_CONTEXT_TURNS: usize = 1;
pub const MAX_ALLOWED_CONTEXT_TURNS: usize = 50;

/// AI 助手服务的那两件事。两件事各自可以选模型，因为它们对模型的要求不同：
/// 标题只要便宜听话，标签要能读懂代码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiTask {
    Tagging,
    Title,
}

/// AI 助手的一次完整配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiAssistantSettings {
    /// 复用哪一条 AI 提供方。`None` = 还没配。
    pub provider_id: Option<i32>,
    /// 该提供方说什么协议。`None` 按 OpenAI 兼容处理——那是覆盖面最广的一种。
    pub protocol: Option<ModelsProtocol>,
    /// 密钥怎么走。`None` = 按协议的惯例。
    pub key_header: Option<KeyHeader>,
    /// 打标签用哪个模型名。
    pub tag_model: String,
    /// 生成标题用哪个模型名；留空表示跟标签用同一个。
    pub title_model: String,
    /// 标题归谁管。
    pub title_source: TitleSource,
    /// 两次标题生成之间的最小间隔（秒）。
    pub title_min_interval_seconds: u64,
    /// 「最近 N 轮」，标签与标题共用。
    pub context_turns: usize,
    /// 自动建议标签。第一版只占位，默认关闭。
    pub auto_suggest_tags: bool,
}

impl Default for AiAssistantSettings {
    fn default() -> Self {
        Self {
            provider_id: None,
            protocol: None,
            key_header: None,
            tag_model: String::new(),
            title_model: String::new(),
            title_source: TitleSource::default(),
            title_min_interval_seconds: DEFAULT_MIN_INTERVAL_SECONDS,
            context_turns: DEFAULT_CONTEXT_TURNS,
            auto_suggest_tags: false,
        }
    }
}

impl AiAssistantSettings {
    /// 协议，未指定时按 OpenAI 兼容。
    pub fn protocol(&self) -> ModelsProtocol {
        self.protocol.unwrap_or(ModelsProtocol::Openai)
    }

    /// 某个任务实际要用的模型名。标题没单填时回落标签那一个。
    pub fn model_for(&self, task: AiTask) -> Option<&str> {
        let raw = match task {
            AiTask::Tagging => &self.tag_model,
            AiTask::Title => {
                if self.title_model.trim().is_empty() {
                    &self.tag_model
                } else {
                    &self.title_model
                }
            }
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    }

    /// 把越界的数值夹回允许范围。设置是用户能手改的 JSON，不能假设它合理。
    pub fn normalized(mut self) -> Self {
        self.context_turns = self
            .context_turns
            .clamp(MIN_ALLOWED_CONTEXT_TURNS, MAX_ALLOWED_CONTEXT_TURNS);
        self.title_min_interval_seconds = self.title_min_interval_seconds.clamp(
            crate::ai::gate::MIN_ALLOWED_INTERVAL_SECONDS,
            crate::ai::gate::MAX_ALLOWED_INTERVAL_SECONDS,
        );
        self
    }
}

/// 从 `app_metadata` 读到的原始值解析设置。缺失、空白、坏 JSON 一律回落默认
/// 值——一条写坏的行不该让整个 AI 助手变成打不开的报错。
pub fn parse_settings(raw: Option<&str>) -> AiAssistantSettings {
    let Some(raw) = raw else {
        return AiAssistantSettings::default();
    };
    if raw.trim().is_empty() {
        return AiAssistantSettings::default();
    }
    serde_json::from_str::<AiAssistantSettings>(raw)
        .unwrap_or_default()
        .normalized()
}

pub async fn load(conn: &DatabaseConnection) -> Result<AiAssistantSettings, DbError> {
    let raw = app_metadata_service::get_value(conn, AI_ASSISTANT_SETTINGS_KEY).await?;
    Ok(parse_settings(raw.as_deref()))
}

pub async fn save(
    conn: &DatabaseConnection,
    settings: &AiAssistantSettings,
) -> Result<AiAssistantSettings, DbError> {
    let settings = settings.clone().normalized();
    let raw = serde_json::to_string(&settings)
        .map_err(|e| DbError::Validation(format!("ai assistant settings not serializable: {e}")))?;
    app_metadata_service::upsert_value(conn, AI_ASSISTANT_SETTINGS_KEY, &raw).await?;
    Ok(settings)
}

/// AI 助手能不能干活，以及不能的话为什么。前端据此置灰入口并给一句话。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AiAvailability {
    Ready,
    /// 还没选提供方。
    NoProvider,
    /// 选过，但那条提供方已经被删掉了。
    ProviderMissing,
    /// 提供方在，但没有填模型名。
    NoModel,
    /// 提供方协议存在，但本版尚未实现对应的生成请求。
    UnsupportedProtocol,
}

impl AiAvailability {
    /// 前端把这句话显示在 tooltip 里，指向设置页。
    pub fn reason_i18n_key(&self) -> &'static str {
        match self {
            AiAvailability::Ready => "aiAssistant.ready",
            AiAvailability::NoProvider => "aiAssistant.noProvider",
            AiAvailability::ProviderMissing => "aiAssistant.providerMissing",
            AiAvailability::NoModel => "aiAssistant.noModel",
            AiAvailability::UnsupportedProtocol => "aiAssistant.unsupportedProtocol",
        }
    }

    pub fn is_ready(&self) -> bool {
        *self == AiAvailability::Ready
    }
}

/// 解析可用性。提供方被删掉之后设置里那一行仍然指着它，所以这里必须回表确认，
/// 而不是只看 `provider_id.is_some()`。
pub async fn availability(
    conn: &DatabaseConnection,
    settings: &AiAssistantSettings,
) -> Result<AiAvailability, DbError> {
    let Some(provider_id) = settings.provider_id else {
        return Ok(AiAvailability::NoProvider);
    };
    if model_provider_service::get_by_id(conn, provider_id)
        .await?
        .is_none()
    {
        return Ok(AiAvailability::ProviderMissing);
    }
    if settings.model_for(AiTask::Tagging).is_none() {
        return Ok(AiAvailability::NoModel);
    }
    if settings.protocol() == ModelsProtocol::Gemini {
        return Ok(AiAvailability::UnsupportedProtocol);
    }
    Ok(AiAvailability::Ready)
}

/// 只有已配好生成能力时才接管；未配置的新安装继续使用同伴的标题，避免
/// 默认值 Codeg 让升级后的用户突然失去所有自动命名。
pub async fn codeg_owns_titles(conn: &DatabaseConnection) -> Result<bool, DbError> {
    let settings = load(conn).await?;
    Ok(settings.title_source == TitleSource::Codeg
        && availability(conn, &settings).await?.is_ready())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    #[tokio::test]
    async fn an_unsupported_generation_protocol_is_not_reported_ready() {
        let db = fresh_in_memory_db().await;
        let provider = model_provider_service::create(
            &db.conn,
            "gemini".into(),
            "https://example.com".into(),
            "test-key".into(),
            "gemini".into(),
            None,
        )
        .await
        .unwrap();
        let settings = AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "gemini-test".into(),
            protocol: Some(ModelsProtocol::Gemini),
            ..AiAssistantSettings::default()
        };

        let status = availability(&db.conn, &settings).await.unwrap();

        assert!(
            !status.is_ready(),
            "不支持的协议不能让入口启用并误发到 messages"
        );
    }

    #[test]
    fn nothing_saved_means_defaults() {
        let settings = parse_settings(None);

        assert_eq!(settings, AiAssistantSettings::default());
        assert_eq!(settings.context_turns, 6);
        assert_eq!(settings.title_min_interval_seconds, 30);
        assert_eq!(settings.title_source, TitleSource::Codeg);
        assert_eq!(settings.protocol(), ModelsProtocol::Openai);
        assert!(!settings.auto_suggest_tags);
        assert_eq!(settings.provider_id, None);
    }

    #[test]
    fn a_broken_row_falls_back_to_defaults_instead_of_erroring() {
        assert_eq!(
            parse_settings(Some("{ not json")),
            AiAssistantSettings::default()
        );
        assert_eq!(parse_settings(Some("   ")), AiAssistantSettings::default());
    }

    #[test]
    fn a_partial_row_keeps_what_it_says_and_defaults_the_rest() {
        let settings = parse_settings(Some(r#"{"providerId":7,"tagModel":"gpt-4o-mini"}"#));

        assert_eq!(settings.provider_id, Some(7));
        assert_eq!(settings.tag_model, "gpt-4o-mini");
        assert_eq!(settings.context_turns, 6);
        assert_eq!(settings.title_source, TitleSource::Codeg);
    }

    #[test]
    fn an_unknown_field_is_ignored() {
        let settings = parse_settings(Some(
            r#"{"providerId":1,"tagModel":"m","futureField":true}"#,
        ));

        assert_eq!(settings.provider_id, Some(1));
        assert_eq!(settings.tag_model, "m");
    }

    #[test]
    fn out_of_range_numbers_are_clamped_to_something_usable() {
        let settings = parse_settings(Some(
            r#"{"contextTurns":0,"titleMinIntervalSeconds":99999}"#,
        ));

        assert_eq!(settings.context_turns, 1);
        assert_eq!(settings.title_min_interval_seconds, 3600);

        let settings = parse_settings(Some(r#"{"contextTurns":999,"titleMinIntervalSeconds":0}"#));

        assert_eq!(settings.context_turns, 50);
        assert_eq!(settings.title_min_interval_seconds, 5);
    }

    #[test]
    fn the_title_model_falls_back_to_the_tag_model() {
        let settings = parse_settings(Some(r#"{"tagModel":"cheap","titleModel":""}"#));

        assert_eq!(settings.model_for(AiTask::Tagging), Some("cheap"));
        assert_eq!(settings.model_for(AiTask::Title), Some("cheap"));
    }

    #[test]
    fn a_blank_model_name_means_no_model() {
        let settings = parse_settings(Some(r#"{"tagModel":"  ","titleModel":"  "}"#));

        assert_eq!(settings.model_for(AiTask::Tagging), None);
        assert_eq!(settings.model_for(AiTask::Title), None);
    }

    #[tokio::test]
    async fn settings_round_trip_through_app_metadata() {
        let db = fresh_in_memory_db().await;
        let settings = AiAssistantSettings {
            provider_id: Some(3),
            tag_model: "cheap".to_string(),
            title_model: "cheaper".to_string(),
            title_source: TitleSource::Fallback,
            title_min_interval_seconds: 90,
            context_turns: 4,
            auto_suggest_tags: true,
            ..AiAssistantSettings::default()
        };

        let saved = save(&db.conn, &settings).await.expect("save");
        let loaded = load(&db.conn).await.expect("load");

        assert_eq!(loaded, saved);
        assert_eq!(loaded.provider_id, Some(3));
        assert_eq!(loaded.title_source, TitleSource::Fallback);
        assert_eq!(loaded.context_turns, 4);
    }

    #[tokio::test]
    async fn a_never_configured_assistant_reports_no_provider() {
        let db = fresh_in_memory_db().await;
        let settings = load(&db.conn).await.expect("load");

        assert_eq!(
            availability(&db.conn, &settings)
                .await
                .expect("availability"),
            AiAvailability::NoProvider
        );
    }

    #[tokio::test]
    async fn a_deleted_provider_is_reported_separately_from_never_chosen() {
        let db = fresh_in_memory_db().await;
        let provider = model_provider_service::create(
            &db.conn,
            "openai".to_string(),
            "https://api.openai.com/v1".to_string(),
            "sk-secret".to_string(),
            "claude_code".to_string(),
            None,
        )
        .await
        .expect("seed provider");
        let settings = AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "gpt-4o-mini".to_string(),
            ..AiAssistantSettings::default()
        };
        save(&db.conn, &settings).await.expect("save");
        model_provider_service::delete(&db.conn, provider.id)
            .await
            .expect("delete provider");

        assert_eq!(
            availability(&db.conn, &settings)
                .await
                .expect("availability"),
            AiAvailability::ProviderMissing
        );
    }

    #[tokio::test]
    async fn a_provider_without_a_model_name_is_not_ready() {
        let db = fresh_in_memory_db().await;
        let provider = model_provider_service::create(
            &db.conn,
            "openai".to_string(),
            "https://api.openai.com/v1".to_string(),
            "sk-secret".to_string(),
            "claude_code".to_string(),
            None,
        )
        .await
        .expect("seed provider");
        let settings = AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "  ".to_string(),
            ..AiAssistantSettings::default()
        };

        assert_eq!(
            availability(&db.conn, &settings)
                .await
                .expect("availability"),
            AiAvailability::NoModel
        );
    }

    #[tokio::test]
    async fn a_configured_assistant_is_ready() {
        let db = fresh_in_memory_db().await;
        let provider = model_provider_service::create(
            &db.conn,
            "openai".to_string(),
            "https://api.openai.com/v1".to_string(),
            "sk-secret".to_string(),
            "claude_code".to_string(),
            None,
        )
        .await
        .expect("seed provider");
        let settings = AiAssistantSettings {
            provider_id: Some(provider.id),
            tag_model: "gpt-4o-mini".to_string(),
            ..AiAssistantSettings::default()
        };

        assert_eq!(
            availability(&db.conn, &settings)
                .await
                .expect("availability"),
            AiAvailability::Ready
        );
    }
}
