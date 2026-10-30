//! 把模型的自由回答收成结构化结果。
//!
//! 模型只承诺"只返回 JSON"，实际经常带围栏、带解释、带半句话。这里的策略是
//! **能救就救、救不了就报失败**：绝不猜一个标签出来——一个猜错的标签会污染
//! 用户的标签体系，而一次失败只是多按一次快捷键。

use serde::{Deserialize, Serialize};

/// 一次建议最多给几条。十条没人读得完，而且会诱导用户无脑全选。
pub const MAX_SUGGESTED_TAGS: usize = 5;

/// 标题的字符上限。侧栏一行放不下更长的东西。
pub const MAX_TITLE_CHARS: usize = 80;

/// 建议标签里"已有池内的那一条"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestedTag {
    pub name: String,
    /// 为什么建议它。只给人看，不落库。
    #[serde(default)]
    pub reason: String,
}

/// 建议新建的标签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestedNewTag {
    pub name: String,
    /// 建议颜色，`#rrggbb`。`None` 交给确认框给个默认色。
    #[serde(default)]
    pub color: Option<String>,
}

/// 一次标签建议的全部产物。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagSuggestion {
    #[serde(default)]
    pub tags: Vec<SuggestedTag>,
    #[serde(default)]
    pub new_tags: Vec<SuggestedNewTag>,
}

impl TagSuggestion {
    pub fn is_empty(&self) -> bool {
        self.tags.is_empty() && self.new_tags.is_empty()
    }
}

/// 解析标签建议。`None` = 这段回答根本不是我们约定的形状，调用方应当报失败。
pub fn parse_tag_suggestion(raw: &str) -> Option<TagSuggestion> {
    let json = extract_json_object(raw)?;
    let parsed: TagSuggestion = serde_json::from_str(&json).ok()?;

    // 名字两端的空白、空名字、重复名字都在这里清掉；模型很爱返回
    // `"name": " bug "`，或者同一件事给两个大小写不同的写法。
    let mut seen: Vec<String> = Vec::new();
    let tags = parsed
        .tags
        .into_iter()
        .filter_map(|tag| {
            let name = tag.name.trim();
            if name.is_empty() {
                return None;
            }
            let key = name.to_lowercase();
            if seen.contains(&key) {
                return None;
            }
            seen.push(key);
            Some(SuggestedTag {
                name: name.to_string(),
                reason: tag.reason.trim().to_string(),
            })
        })
        .take(MAX_SUGGESTED_TAGS)
        .collect();

    let mut seen_new: Vec<String> = Vec::new();
    let new_tags = parsed
        .new_tags
        .into_iter()
        .filter_map(|tag| {
            let name = tag.name.trim();
            if name.is_empty() {
                return None;
            }
            let key = name.to_lowercase();
            if seen_new.contains(&key) {
                return None;
            }
            seen_new.push(key);
            Some(SuggestedNewTag {
                name: name.to_string(),
                color: tag
                    .color
                    .map(|c| c.trim().to_string())
                    .filter(|c| !c.is_empty()),
            })
        })
        .take(MAX_SUGGESTED_TAGS)
        .collect();

    Some(TagSuggestion { tags, new_tags })
}

/// 从一段回答里抠出第一个 JSON 对象：整体就是 JSON 最好，否则取第一对花括号。
/// 宁可只取到第一个对象，也不去修一段断掉的 JSON。
fn extract_json_object(raw: &str) -> Option<String> {
    let unfenced = strip_code_fences(raw);
    let trimmed = unfenced.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('{') && serde_json::from_str::<serde_json::Value>(trimmed).is_ok() {
        return Some(trimmed.to_string());
    }
    let start = trimmed.find('{')?;
    let end = trimmed.rfind('}')?;
    if end <= start {
        return None;
    }
    let candidate = &trimmed[start..=end];
    serde_json::from_str::<serde_json::Value>(candidate)
        .ok()
        .map(|_| candidate.to_string())
}

/// 去掉 Markdown 代码围栏，保留围栏里的正文。
fn strip_code_fences(raw: &str) -> String {
    let mut lines = raw.lines();
    let Some(first) = lines.next() else {
        return String::new();
    };
    if !first.trim_start().starts_with("```") {
        return raw.to_string();
    }
    let mut body: Vec<&str> = Vec::new();
    for line in lines {
        if line.trim_start().starts_with("```") {
            break;
        }
        body.push(line);
    }
    body.join("\n")
}

/// 把模型给的标题洗成一行、够短、没有花架子。`None` = 它什么都没给。
pub fn clean_title(raw: &str) -> Option<String> {
    let unfenced = strip_code_fences(raw);
    // 只要第一行有内容：模型有时会把标题写成"第一行标题，第二行解释"。
    let first_line = unfenced
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;

    let mut title = first_line.trim_start_matches(['#', '-', '*', '>']).trim();

    // `标题: xxx` / `Title: xxx` / `标题：xxx`。
    for prefix in ["标题", "title", "Title", "TITLE"] {
        if let Some(rest) = title.strip_prefix(prefix) {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('：').or_else(|| rest.strip_prefix(':')) {
                title = rest.trim();
                break;
            }
        }
    }

    title = title.trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | '`' | '「' | '」' | '“' | '”' | '‘' | '’' | '《' | '》' | '*'
        )
    });

    let collapsed = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(MAX_TITLE_CHARS).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_json_answer_is_read_as_is() {
        let suggestion = parse_tag_suggestion(
            r#"{"tags":[{"name":"bug","reason":"在排查缺陷"},{"name":"性能","reason":"讨论响应时间"}],"new_tags":[]}"#,
        )
        .expect("bare json");

        assert_eq!(
            suggestion.tags,
            vec![
                SuggestedTag {
                    name: "bug".to_string(),
                    reason: "在排查缺陷".to_string()
                },
                SuggestedTag {
                    name: "性能".to_string(),
                    reason: "讨论响应时间".to_string()
                },
            ]
        );
        assert!(suggestion.new_tags.is_empty());
    }

    #[test]
    fn a_fenced_json_answer_is_unwrapped() {
        let raw = "```json\n{\"tags\":[{\"name\":\"重构\",\"reason\":\"大范围改名\"}]}\n```";

        let suggestion = parse_tag_suggestion(raw).expect("fenced json");

        assert_eq!(suggestion.tags.len(), 1);
        assert_eq!(suggestion.tags[0].name, "重构");
    }

    #[test]
    fn json_buried_in_prose_is_still_found() {
        let raw = "我看了这段对话，建议这样：{\"tags\":[{\"name\":\"部署\",\"reason\":\"在改流水线\"}]} 希望有帮助。";

        let suggestion = parse_tag_suggestion(raw).expect("embedded json");

        assert_eq!(suggestion.tags[0].name, "部署");
    }

    #[test]
    fn an_answer_that_is_not_json_is_a_failure() {
        assert_eq!(parse_tag_suggestion("我觉得应该打上 bug 标签"), None);
        assert_eq!(parse_tag_suggestion(""), None);
        assert_eq!(parse_tag_suggestion("{ 这不是 json }"), None);
    }

    #[test]
    fn a_valid_but_empty_answer_is_an_empty_suggestion() {
        let suggestion = parse_tag_suggestion("{\"tags\":[],\"new_tags\":[]}").expect("empty");

        assert!(suggestion.is_empty());
    }

    #[test]
    fn names_are_trimmed_deduped_and_capped() {
        let raw = r#"{
            "tags": [
                {"name": " bug ", "reason": "空格"},
                {"name": "BUG", "reason": "重复"},
                {"name": "   ", "reason": "空名字"},
                {"name": "t1"}, {"name": "t2"}, {"name": "t3"}, {"name": "t4"}, {"name": "t5"}
            ],
            "new_tags": [{"name": "新标签", "color": " #0e8a16 "}]
        }"#;

        let suggestion = parse_tag_suggestion(raw).expect("messy json");

        let names: Vec<&str> = suggestion.tags.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["bug", "t1", "t2", "t3", "t4"]);
        assert_eq!(
            suggestion.new_tags,
            vec![SuggestedNewTag {
                name: "新标签".to_string(),
                color: Some("#0e8a16".to_string())
            }]
        );
    }

    #[test]
    fn a_title_comes_back_as_one_clean_line() {
        assert_eq!(
            clean_title("```\n修复侧栏标签不刷新\n```"),
            Some("修复侧栏标签不刷新".to_string())
        );
        assert_eq!(
            clean_title("标题：给会话加 AI 打标签\n（说明：这里还有一段解释）"),
            Some("给会话加 AI 打标签".to_string())
        );
        assert_eq!(
            clean_title("  \"重构  上下文提取\"  "),
            Some("重构 上下文提取".to_string())
        );
        assert_eq!(clean_title("# 部署流水线修复"), Some("部署流水线修复".to_string()));
    }

    #[test]
    fn a_long_title_is_cut_to_the_limit() {
        let long = "标".repeat(200);

        let title = clean_title(&long).expect("title");

        assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn an_empty_answer_is_no_title() {
        assert_eq!(clean_title(""), None);
        assert_eq!(clean_title("   \n  \n"), None);
        assert_eq!(clean_title("Title:"), None);
    }
}
