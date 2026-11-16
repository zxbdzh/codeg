use std::sync::Arc;

use axum::{
    body::Body,
    extract::Extension,
    http::{header, HeaderValue},
    response::Response,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::io::ReaderStream;

use crate::{app_error::AppCommandError, app_state::AppState, ego::api};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamParams {
    session_id: i32,
    tab_id: String,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
}

pub async fn ego_stream(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<StreamParams>,
) -> Result<Response, AppCommandError> {
    api::project_root(&state.db, params.session_id)
        .await
        .map_err(AppCommandError::invalid_input)?;
    let response = crate::ego::EgoService::shared(&state.data_dir)
        .stream(
            json!({"method": "stream", "sessionId": params.session_id, "tabId": params.tab_id,
            "clientId": params.client_id,
            "format": match params.format.as_deref() { Some("video") => "video", Some("pixels") => "pixels", _ => "jpeg" }}),
        )
        .await
        .map_err(AppCommandError::invalid_input)?;
    // 不聚合正文：接收一帧转发一帧，浏览器取消 fetch 会释放上游观察者。
    let video = response
        .headers()
        .get(header::CONTENT_TYPE)
        .is_some_and(|value| value == "video/mp4");
    let mut output = Response::new(Body::from_stream(response.bytes_stream()));
    output.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(if video {
            "video/mp4"
        } else {
            "application/x-ndjson"
        }),
    );
    output
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    output
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(output)
}

#[derive(Deserialize)]
pub struct CommandParams {
    request: Value,
}

pub async fn ego_browser(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CommandParams>,
) -> Result<Json<Value>, AppCommandError> {
    api::command(&state.db, &state.data_dir, params.request)
        .await
        .map(Json)
        .map_err(AppCommandError::invalid_input)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadParams {
    session_id: i32,
    download_id: String,
}

pub async fn ego_download(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DownloadParams>,
) -> Result<Response, AppCommandError> {
    let (filename, name) = api::download(
        &state.db,
        &state.data_dir,
        params.session_id,
        &params.download_id,
    )
    .await
    .map_err(AppCommandError::invalid_input)?;
    let file = tokio::fs::File::open(filename)
        .await
        .map_err(|error| AppCommandError::invalid_input(error.to_string()))?;
    let encoded: String = name
        .as_bytes()
        .iter()
        .map(|byte| format!("%{byte:02X}"))
        .collect();
    let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename*=UTF-8''{encoded}")) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}
