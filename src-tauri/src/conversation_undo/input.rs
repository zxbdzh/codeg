use std::io::Write;
use std::path::Path;

use crate::acp::types::PromptInputBlock;
use crate::app_error::AppCommandError;
use crate::models::{ContentBlock, MessageTurn};
use base64::{engine::general_purpose::STANDARD, Engine};

pub(super) fn from_turn(prompt: &MessageTurn) -> Vec<PromptInputBlock> {
    prompt
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(PromptInputBlock::Text { text: text.clone() }),
            ContentBlock::Image {
                data, mime_type, ..
            } => Some(PromptInputBlock::Image {
                data: data.clone(),
                mime_type: mime_type.clone(),
                uri: None,
            }),
            _ => None,
        })
        .collect()
}

pub(super) fn snapshot(
    data_dir: &Path,
    blocks: Vec<PromptInputBlock>,
) -> Result<Vec<PromptInputBlock>, AppCommandError> {
    let root = data_dir.join("uploads").join("conversation-undo");
    std::fs::create_dir_all(&root).map_err(AppCommandError::io)?;
    blocks
        .into_iter()
        .map(|mut block| {
            let asset = match &block {
                PromptInputBlock::Image {
                    data, mime_type, ..
                } => Some((
                    STANDARD
                        .decode(data)
                        .map_err(|_| AppCommandError::invalid_input("Original image is damaged"))?,
                    mime_type.clone(),
                    false,
                )),
                PromptInputBlock::Resource {
                    blob: Some(blob),
                    mime_type,
                    ..
                } => Some((
                    STANDARD.decode(blob).map_err(|_| {
                        AppCommandError::invalid_input("Original attachment is damaged")
                    })?,
                    mime_type.clone().unwrap_or_default(),
                    false,
                )),
                PromptInputBlock::Resource {
                    text: Some(text),
                    mime_type,
                    ..
                } => Some((
                    text.as_bytes().to_vec(),
                    mime_type.clone().unwrap_or_default(),
                    true,
                )),
                _ => None,
            };
            if let Some((bytes, mime, is_text)) = asset {
                if bytes.len() as u64 > crate::web::handlers::files::UPLOAD_MAX_BYTES {
                    return Err(AppCommandError::invalid_input(
                        "Original attachment exceeds the upload limit",
                    ));
                }
                let name = match &block {
                    PromptInputBlock::Resource { uri, .. } => uri
                        .rsplit('/')
                        .next()
                        .filter(|name| !name.is_empty())
                        .unwrap_or("attachment.bin")
                        .to_owned(),
                    _ => format!(
                        "image.{}",
                        mime.strip_prefix("image/")
                            .unwrap_or("bin")
                            .replace('/', "_")
                    ),
                };
                let name = name
                    .chars()
                    .map(|ch| {
                        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                            ch
                        } else {
                            '_'
                        }
                    })
                    .collect::<String>();
                let bucket = root.join(uuid::Uuid::new_v4().to_string());
                std::fs::create_dir(&bucket).map_err(AppCommandError::io)?;
                let path = bucket.join(name);
                let mut file = std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&path)
                    .map_err(AppCommandError::io)?;
                file.write_all(&bytes).map_err(AppCommandError::io)?;
                file.sync_all().map_err(AppCommandError::io)?;
                let canonical = std::fs::canonicalize(path).map_err(AppCommandError::io)?;
                let uri =
                    url::Url::from_file_path(crate::paths::simplify_verbatim_path(&canonical))
                        .map_err(|_| {
                            AppCommandError::invalid_input("Invalid restored attachment path")
                        })?
                        .to_string();
                match &mut block {
                    PromptInputBlock::Image { uri: target, .. } => *target = Some(uri),
                    PromptInputBlock::Resource {
                        uri: target,
                        text,
                        blob,
                        ..
                    } => {
                        *target = uri;
                        // 附件使用私有副本的小体积发送标记，发送入口再读取原始字节，避免大文件挤爆 HTTP 请求。
                        if is_text {
                            *text = Some(String::new());
                        } else {
                            *blob = Some(String::new());
                        }
                    }
                    _ => {}
                }
            }
            Ok(block)
        })
        .collect()
}
