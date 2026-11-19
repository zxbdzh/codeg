use std::{process::Stdio, time::Duration};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
    ego_session::{ImportFailure, SessionData},
    session_import::EgoSourceProfile,
};

const MAX_OUTPUT: u64 = 2 * 1024 * 1024;
const SOURCE_SCRIPT: &str = include_str!("ego_session_source.js");

async fn request(input: Value) -> Result<Value, ImportFailure> {
    let mut command = crate::process::tokio_command("ego-browser");
    command
        .arg("nodejs")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Ego 2.2 的脚本结果走 stderr；两个管道均只在本机解析，不能转入日志。
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| ImportFailure::Unavailable)?;
    let script = format!("const request = {};\n{}", input, SOURCE_SCRIPT);
    let mut stdin = child.stdin.take().ok_or(ImportFailure::Unavailable)?;
    let stdout = child.stdout.take().ok_or(ImportFailure::Unavailable)?;
    let stderr = child.stderr.take().ok_or(ImportFailure::Unavailable)?;
    let work = async {
        stdin
            .write_all(script.as_bytes())
            .await
            .map_err(|_| ImportFailure::Unavailable)?;
        drop(stdin);
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        let mut stdout = stdout.take(MAX_OUTPUT + 1);
        let mut stderr = stderr.take(MAX_OUTPUT + 1);
        tokio::try_join!(
            stdout.read_to_end(&mut output),
            stderr.read_to_end(&mut diagnostics),
        )
        .map_err(|_| ImportFailure::Unavailable)?;
        if (output.len() + diagnostics.len()) as u64 > MAX_OUTPUT {
            return Err(ImportFailure::Unsupported);
        }
        output.push(b'\n');
        output.extend(diagnostics);
        let status = child.wait().await.map_err(|_| ImportFailure::Unavailable)?;
        if !status.success() {
            return Err(ImportFailure::Unavailable);
        }
        let text = std::str::from_utf8(&output).map_err(|_| ImportFailure::Unavailable)?;
        let answer = text
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str::<Value>(line).ok())
            .ok_or(ImportFailure::Unavailable)?;
        match answer.get("error").and_then(Value::as_str) {
            Some("source_missing") => Err(ImportFailure::SourceMissing),
            Some("unsupported") => Err(ImportFailure::Unsupported),
            Some(_) => Err(ImportFailure::Unavailable),
            None => Ok(answer),
        }
    };
    tokio::time::timeout(Duration::from_secs(40), work)
        .await
        .map_err(|_| ImportFailure::Unavailable)?
}

pub async fn profiles() -> Result<Vec<EgoSourceProfile>, ImportFailure> {
    let mut answer = request(serde_json::json!({"mode":"profiles"})).await?;
    let profiles: Vec<EgoSourceProfile> = serde_json::from_value(answer["profiles"].take())
        .map_err(|_| ImportFailure::Unavailable)?;
    if profiles.len() > 128
        || profiles.iter().any(|profile| {
            profile.id.is_empty() || profile.id.len() > 256 || profile.name.len() > 640
        })
    {
        return Err(ImportFailure::Unsupported);
    }
    Ok(profiles)
}

pub async fn read(profile_id: &str, url: &str) -> Result<SessionData, ImportFailure> {
    let answer = request(serde_json::json!({
        "mode":"read", "profileId":profile_id, "url":url
    }))
    .await?;
    serde_json::from_value(answer).map_err(|_| ImportFailure::Unsupported)
}
