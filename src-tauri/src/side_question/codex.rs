//! Codex 旁问直连当前提供方：不创建 ACP 会话，也没有工具执行循环。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::ConversationModel;
use crate::acp::one_shot::OneShotError;
use crate::db::AppDatabase;
use crate::models::AgentType;

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

struct Endpoint {
    url: Url,
    headers: HeaderMap,
}

fn unavailable(message: &str) -> OneShotError {
    OneShotError::Unavailable(message.to_owned())
}

fn failure(message: &str) -> OneShotError {
    OneShotError::Failed(message.to_owned())
}

fn nonempty(text: &str) -> Option<&str> {
    let text = text.trim();
    (!text.is_empty()).then_some(text)
}

fn env_value(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    env.get(key).cloned().or_else(|| std::env::var(key).ok())
}

fn routing_override(raw: Option<&str>) -> bool {
    raw.and_then(nonempty).is_some_and(|raw| {
        serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|value| value.as_object().cloned())
            .is_none_or(|overrides| {
                overrides.keys().any(|key| {
                    matches!(
                        key.split('.').next(),
                        Some(
                            "model_provider"
                                | "model_providers"
                                | "profile"
                                | "profiles"
                                | "openai_base_url"
                                | "cli_auth_credentials_store"
                        )
                    )
                })
            })
    })
}

fn disk_api_key(home: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(home.join("auth.json")).ok()?;
    let auth: Value = serde_json::from_str(&raw).ok()?;
    // 只复用明确的 API key；订阅登录的 token 不能发往自定义提供方。
    if auth
        .get("auth_mode")
        .and_then(Value::as_str)
        .is_some_and(|mode| !matches!(mode, "apikey" | "api_key"))
        || auth.get("tokens").is_some_and(|tokens| !tokens.is_null())
    {
        return None;
    }
    crate::acp::codex_catalog_commit::auth_api_key(&raw)
}

fn set_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), OneShotError> {
    let name = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| unavailable("The Codex provider has an invalid HTTP header name"))?;
    if matches!(
        name.as_str(),
        "host" | "content-length" | "transfer-encoding" | "connection"
    ) {
        return Err(unavailable(
            "The Codex provider uses an unsupported transport header",
        ));
    }
    let mut value = HeaderValue::from_str(value)
        .map_err(|_| unavailable("The Codex provider has an invalid HTTP header value"))?;
    value.set_sensitive(true);
    headers.insert(name, value);
    Ok(())
}

fn resolve_endpoint(
    home: &Path,
    config: &toml::Table,
    env: &BTreeMap<String, String>,
) -> Result<Endpoint, OneShotError> {
    let field = |name| {
        config
            .get(name)
            .and_then(toml::Value::as_str)
            .and_then(nonempty)
    };
    if field("profile").is_some()
        || routing_override(env_value(env, "CODEX_CONFIG").as_deref())
        || env_value(env, "CODEX_PROFILE")
            .as_deref()
            .and_then(nonempty)
            .is_some()
    {
        return Err(unavailable("This Codex profile overrides provider routing; its side-question endpoint cannot be verified"));
    }
    let provider_id = field("model_provider").unwrap_or("openai");
    let mut headers = HeaderMap::new();
    let (base_url, key, query) = if provider_id == "openai" {
        let base_url = env_value(env, "OPENAI_BASE_URL")
            .filter(|value| nonempty(value).is_some())
            .or_else(|| field("openai_base_url").map(str::to_owned))
            .unwrap_or_else(|| "https://api.openai.com/v1".into());
        let key = env_value(env, "OPENAI_API_KEY")
            .filter(|value| nonempty(value).is_some())
            .or_else(|| disk_api_key(home));
        (base_url, key, None)
    } else {
        let provider = config
            .get("model_providers")
            .and_then(|value| value.get(provider_id))
            .and_then(toml::Value::as_table)
            .ok_or_else(|| {
                unavailable("The current Codex provider has no direct API configuration")
            })?;
        let string = |name| {
            provider
                .get(name)
                .and_then(toml::Value::as_str)
                .and_then(nonempty)
        };
        if string("wire_api").is_some_and(|wire| wire != "responses")
            || provider.contains_key("auth")
        {
            return Err(unavailable(
                "This Codex provider does not expose a supported Responses API credential",
            ));
        }
        if let Some(values) = provider.get("http_headers").and_then(toml::Value::as_table) {
            for (name, value) in values {
                if let Some(value) = value.as_str() {
                    set_header(&mut headers, name, value)?;
                }
            }
        }
        if let Some(values) = provider
            .get("env_http_headers")
            .and_then(toml::Value::as_table)
        {
            for (name, key) in values {
                if let Some(value) = key.as_str().and_then(|key| env_value(env, key)) {
                    if let Some(value) = nonempty(&value) {
                        set_header(&mut headers, name, value)?;
                    }
                }
            }
        }
        let key = if let Some(key_name) = string("env_key") {
            Some(
                env_value(env, key_name)
                    .filter(|value| nonempty(value).is_some())
                    .ok_or_else(|| {
                        unavailable(
                            "The current Codex provider's API key environment variable is missing",
                        )
                    })?,
            )
        } else if let Some(key) = string("experimental_bearer_token") {
            Some(key.to_owned())
        } else if provider
            .get("requires_openai_auth")
            .and_then(toml::Value::as_bool)
            == Some(true)
        {
            disk_api_key(home)
        } else {
            None
        };
        let base_url = string("base_url").ok_or_else(|| {
            unavailable("The current Codex provider has no direct Responses API endpoint")
        })?;
        (
            base_url.to_owned(),
            key,
            provider.get("query_params").and_then(toml::Value::as_table),
        )
    };
    if let Some(key) = key {
        set_header(
            &mut headers,
            AUTHORIZATION.as_str(),
            &format!("Bearer {}", key.trim()),
        )?;
    } else if !headers.contains_key(AUTHORIZATION)
        && !headers.contains_key("x-openai-actor-authorization")
    {
        return Err(unavailable("The current Codex provider needs an API key for side questions; subscription login alone is not supported"));
    }
    let mut url = Url::parse(base_url.trim())
        .map_err(|_| unavailable("The Codex provider URL is invalid"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(unavailable(
            "The Codex provider URL is not a supported HTTP endpoint",
        ));
    }
    let path = url.path().trim_end_matches('/');
    if !path.ends_with("/responses") {
        // Codex 的自定义 base_url 已包含网关路径，只补资源名，不擅自插入 /v1。
        url.set_path(&format!("{path}/responses"));
    }
    if let Some(query) = query {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query {
            if let Some(value) = value.as_str() {
                pairs.append_pair(name, value);
            }
        }
    }
    Ok(Endpoint { url, headers })
}

fn request_body(
    model: &ConversationModel,
    prompt: String,
    images: &[crate::acp::types::PromptInputBlock],
) -> Value {
    let mut content = vec![json!({ "type": "input_text", "text": prompt })];
    content.extend(images.iter().filter_map(|block| match block {
        crate::acp::types::PromptInputBlock::Image { data, mime_type, .. } =>
            Some(json!({ "type": "input_image", "image_url": format!("data:{mime_type};base64,{data}") })),
        _ => None,
    }));
    let mut body = json!({
        "model": model.id,
        "input": [{ "role": "user", "content": content }],
        "tools": [],
        "tool_choice": "none",
        "store": false,
    });
    if let Some(effort) = model.effort.as_ref() {
        body["reasoning"] = json!({ "effort": effort });
    }
    body
}

fn response_text(body: &Value) -> Result<String, OneShotError> {
    if body["status"] != "completed" {
        return Err(failure(
            "The Codex provider did not complete the side question",
        ));
    }
    let output = body["output"]
        .as_array()
        .ok_or_else(|| failure("The Codex provider returned no text response"))?;
    let mut text = Vec::new();
    for item in output {
        match item["type"].as_str() {
            Some("reasoning") => {}
            Some("message") if item["role"] == "assistant" => {
                if let Some(parts) = item["content"].as_array() {
                    text.extend(parts.iter().filter_map(|part| {
                        (part["type"] == "output_text")
                            .then(|| part["text"].as_str())
                            .flatten()
                    }));
                }
            }
            // 无工具回答不能把调用或其结果当成普通文本。
            _ => {
                return Err(failure(
                    "The Codex provider returned unsupported non-text output",
                ))
            }
        }
    }
    let text = text.join("\n");
    if text.trim().is_empty() {
        Err(failure("The Codex provider returned no text response"))
    } else {
        Ok(text)
    }
}

async fn complete(endpoint: Endpoint, body: Value) -> Result<String, OneShotError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| failure("Could not initialize the Codex side-question HTTP client"))?;
    let mut response = client
        .post(endpoint.url)
        .headers(endpoint.headers)
        .json(&body)
        .send()
        .await
        .map_err(|_| failure("Could not reach the current Codex provider for a side question"))?;
    let status = response.status();
    if !status.is_success() {
        // 网关错误正文可能回显凭据或原问题，只暴露 HTTP 状态码。
        return Err(OneShotError::Failed(format!(
            "The current Codex provider rejected the side question (HTTP {status})"
        )));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| failure("Could not read the Codex side-question response"))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(failure("The Codex side-question response is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = serde_json::from_slice(&bytes)
        .map_err(|_| failure("The Codex provider returned an invalid Responses payload"))?;
    response_text(&body)
}

pub(super) async fn run(
    db: &AppDatabase,
    data_dir: &Path,
    model: &ConversationModel,
    prompt: String,
    images: &[crate::acp::types::PromptInputBlock],
    cancel: &CancellationToken,
) -> Result<String, OneShotError> {
    let env = crate::commands::acp::build_session_runtime_env(db, AgentType::Codex, None, data_dir)
        .await
        .map_err(|_| unavailable("Could not resolve the current Codex provider settings"))?;
    let home = env
        .get("CODEX_HOME")
        .and_then(|value| nonempty(value))
        .map(PathBuf::from)
        .unwrap_or_else(crate::commands::acp::codex_home_dir);
    let endpoint = tokio::task::spawn_blocking(move || {
        let config = match std::fs::read_to_string(home.join("config.toml")) {
            Ok(raw) => raw
                .parse::<toml::Table>()
                .map_err(|_| unavailable("Could not parse Codex provider settings"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => toml::Table::new(),
            Err(_) => return Err(unavailable("Could not read Codex provider settings")),
        };
        resolve_endpoint(&home, &config, &env)
    })
    .await
    .map_err(|_| unavailable("Could not resolve the current Codex provider"))??;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(OneShotError::Cancelled),
        answer = complete(endpoint, request_body(model, prompt, images)) => answer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn codex_side_question_uses_active_gateway_and_model_without_tools() {
        use axum::{routing::post, Json, Router};
        let home = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = Router::new().route("/gateway/v1/responses", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(headers[AUTHORIZATION], "Bearer fixture-key");
            assert_eq!(body["model"], "routing/current-model");
            assert_eq!(body["reasoning"]["effort"], "high");
            assert_eq!(body["tools"], json!([]));
            assert_eq!(body["tool_choice"], "none");
            assert_eq!(body["store"], false);
            assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
            assert_eq!(body["input"][0]["content"][1]["type"], "input_image");
            assert_eq!(body["input"][0]["content"][1]["image_url"], "data:image/png;base64,fixture-image");
            assert!(body.get("previous_response_id").is_none());
            assert!(body.get("conversation").is_none());
            Json(json!({"status":"completed","output":[
                {"type":"reasoning"},
                {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Independent reply"}]}
            ]}))
        }));
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let config = format!(
            r#"
            model_provider = "fixture"
            [model_providers.fixture]
            base_url = "http://{addr}/gateway/v1"
            wire_api = "responses"
            experimental_bearer_token = "fixture-key"
        "#
        )
        .parse()
        .unwrap();
        let env = BTreeMap::from([
            ("CODEX_CONFIG".to_owned(), "{}".to_owned()),
            ("CODEX_PROFILE".to_owned(), "".to_owned()),
        ]);
        let endpoint = resolve_endpoint(home.path(), &config, &env).unwrap();
        let model = ConversationModel {
            agent: AgentType::Codex,
            id: "routing/current-model".into(),
            name: "Current".into(),
            effort: Some("high".into()),
            config: BTreeMap::new(),
        };
        let images = vec![crate::acp::types::PromptInputBlock::Image {
            data: "fixture-image".into(),
            mime_type: "image/png".into(),
            uri: None,
        }];
        let result = complete(
            endpoint,
            request_body(&model, "side question".into(), &images),
        )
        .await;
        server.abort();
        assert_eq!(result, Ok("Independent reply".into()));
    }

    #[test]
    fn subscription_tokens_and_tool_outputs_are_never_used() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("auth.json"), r#"{"auth_mode":"chatgpt","tokens":{"access_token":"fixture"},"OPENAI_API_KEY":"stale"}"#).unwrap();
        assert!(disk_api_key(home.path()).is_none());
        assert!(routing_override(Some(
            r#"{"model_providers.fixture.base_url":"https://example.test"}"#
        )));
        assert!(response_text(
            &json!({"status":"completed","output":[{"type":"function_call","name":"tool"}]})
        )
        .is_err());
    }
}
