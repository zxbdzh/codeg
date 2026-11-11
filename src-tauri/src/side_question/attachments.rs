use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::acp::types::PromptInputBlock;
use crate::app_error::AppCommandError;

const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 32_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Attachment {
    Image {
        name: String,
        mime_type: String,
        data: String,
    },
    Text {
        name: String,
        mime_type: String,
        text: String,
    },
}

pub struct PreparedAttachments {
    pub images: Vec<PromptInputBlock>,
    pub text_files: Vec<Value>,
}

pub fn prepare(attachments: &[Attachment]) -> Result<PreparedAttachments, AppCommandError> {
    if attachments.len() > 4 {
        return Err(AppCommandError::invalid_input(
            "Attach at most 4 files to a side question",
        ));
    }
    let mut images = Vec::new();
    let mut text_files = Vec::new();
    let mut total_bytes = 0;
    let mut text_chars = 0;
    for attachment in attachments {
        let (name, bytes) = match attachment {
            Attachment::Image {
                name,
                mime_type,
                data,
            } => {
                if data.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
                    return Err(AppCommandError::invalid_input(
                        "Side-question attachment exceeds 4 MiB",
                    ));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|_| {
                        AppCommandError::invalid_input("Invalid image attachment encoding")
                    })?;
                let format = image::guess_format(&bytes).map_err(|_| {
                    AppCommandError::invalid_input("The attachment is not a supported image")
                })?;
                let expected_mime = match format {
                    image::ImageFormat::Png => "image/png",
                    image::ImageFormat::Jpeg => "image/jpeg",
                    image::ImageFormat::Gif => "image/gif",
                    image::ImageFormat::WebP => "image/webp",
                    _ => {
                        return Err(AppCommandError::invalid_input(
                            "Use PNG, JPEG, GIF or WebP images",
                        ))
                    }
                };
                if mime_type != expected_mime {
                    return Err(AppCommandError::invalid_input(
                        "The image type does not match its contents",
                    ));
                }
                // 只读尺寸，不解压图片；限制像素数，避免将畸形或超大图像交给供应商。
                let (width, height) =
                    image::ImageReader::with_format(std::io::Cursor::new(&bytes), format)
                        .into_dimensions()
                        .map_err(|_| {
                            AppCommandError::invalid_input("The image attachment is damaged")
                        })?;
                if width == 0
                    || height == 0
                    || width > 8192
                    || height > 8192
                    || u64::from(width) * u64::from(height) > 32_000_000
                {
                    return Err(AppCommandError::invalid_input(
                        "The image attachment dimensions are too large",
                    ));
                }
                images.push(PromptInputBlock::Image {
                    data: data.clone(),
                    mime_type: mime_type.clone(),
                    uri: None,
                });
                (name, bytes.len())
            }
            Attachment::Text {
                name,
                mime_type,
                text,
            } => {
                if !(mime_type.starts_with("text/")
                    || matches!(
                        mime_type.as_str(),
                        "application/json"
                            | "application/yaml"
                            | "application/xml"
                            | "application/toml"
                    ))
                    || text.contains('\0')
                {
                    return Err(AppCommandError::invalid_input(
                        "Use UTF-8 text or code files",
                    ));
                }
                text_chars += text.chars().count();
                if text_chars > MAX_TEXT_CHARS {
                    return Err(AppCommandError::invalid_input(
                        "Text attachments exceed 32000 characters",
                    ));
                }
                text_files.push(json!({ "name": name, "mimeType": mime_type, "text": text }));
                (name, text.len())
            }
        };
        if name.is_empty() || name.chars().count() > 256 || name.chars().any(char::is_control) {
            return Err(AppCommandError::invalid_input(
                "Invalid attachment file name",
            ));
        }
        total_bytes += bytes;
        if bytes > MAX_FILE_BYTES || total_bytes > MAX_TOTAL_BYTES {
            return Err(AppCommandError::invalid_input(
                "Use files up to 4 MiB each and 8 MiB in total",
            ));
        }
    }
    Ok(PreparedAttachments { images, text_files })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";

    #[test]
    fn images_stay_native_blocks_and_text_stays_quoted_data() {
        let result = prepare(&[
            Attachment::Image {
                name: "shot.png".into(),
                mime_type: "image/png".into(),
                data: PNG.into(),
            },
            Attachment::Text {
                name: "code.rs".into(),
                mime_type: "text/rust".into(),
                text: "fn main() {}".into(),
            },
        ])
        .unwrap();
        assert!(
            matches!(&result.images[0], PromptInputBlock::Image { data, uri: None, .. } if data == PNG)
        );
        assert_eq!(result.text_files[0]["text"], "fn main() {}");
    }

    #[test]
    fn mismatched_images_binary_text_and_oversized_batches_are_rejected() {
        assert!(prepare(&[Attachment::Image {
            name: "shot.jpg".into(),
            mime_type: "image/jpeg".into(),
            data: PNG.into()
        }])
        .is_err());
        assert!(prepare(&[Attachment::Image {
            name: "shot.png".into(),
            mime_type: "image/png".into(),
            data: "not base64".into()
        }])
        .is_err());
        let text = Attachment::Text {
            name: "x.txt".into(),
            mime_type: "text/plain".into(),
            text: "x".repeat(MAX_TEXT_CHARS + 1),
        };
        assert!(prepare(&[text]).is_err());
        let empty = Attachment::Text {
            name: "x.txt".into(),
            mime_type: "text/plain".into(),
            text: String::new(),
        };
        assert!(prepare(&vec![empty; 5]).is_err());
    }
}
