//! 从会话轮次里抽出喂给模型的那段上下文。
//!
//! 口径只有一条：**只要人和助手写下的正文**。工具调用、工具结果、思考过程、
//! 错误文本都属于"日志"而不是"话题"，把它们喂进去只会让模型去总结一堆命令
//! 输出，同时把字符预算烧光。

use crate::models::message::{ContentBlock, MessageTurn, TurnRole};

/// 「最近 N 轮」的默认值。一轮 = 一问一答，所以一串消息条目里大约两倍于此。
pub const DEFAULT_CONTEXT_ROUNDS: usize = 6;

/// 上下文的字符上限（按 `char` 计，中文算一个）。超过就从**最旧**的一侧丢，
/// 保住最新的话题——会话后半段才是用户现在关心的事。
pub const MAX_CONTEXT_CHARS: usize = 12_000;

/// 谁说的话。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Speaker {
    User,
    Assistant,
}

impl Speaker {
    /// 喂给模型时用的前缀，刻意用英文：它只是格式标记，不该把中文会话的中文
    /// 语境搅乱，也方便两个任务共用同一段拼装逻辑。
    fn label(self) -> &'static str {
        match self {
            Speaker::User => "User",
            Speaker::Assistant => "Assistant",
        }
    }
}

/// 一条可喂给模型的发言。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextEntry {
    pub speaker: Speaker,
    pub text: String,
}

/// 从一轮里取第一段非空正文。图片、工具调用、思考块都不算正文。
pub fn text_of_turn(turn: &MessageTurn) -> Option<&str> {
    turn.blocks.iter().find_map(|block| match block {
        ContentBlock::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
        _ => None,
    })
}

/// 把轮次列表压成有序的发言列表，跳过系统轮与没有正文的轮。
pub fn collect_entries(turns: &[MessageTurn]) -> Vec<ContextEntry> {
    turns
        .iter()
        .filter_map(|turn| {
            let speaker = match turn.role {
                TurnRole::User => Speaker::User,
                TurnRole::Assistant => Speaker::Assistant,
                TurnRole::System => return None,
            };
            text_of_turn(turn).map(|text| ContextEntry {
                speaker,
                text: text.trim().to_string(),
            })
        })
        .collect()
}

/// 拼出一段可喂给模型的上下文。
pub fn build_context(turns: &[MessageTurn], rounds: usize, max_chars: usize) -> String {
    if rounds == 0 {
        return String::new();
    }
    let entries = collect_entries(turns);
    if entries.is_empty() {
        return String::new();
    }

    // 一轮按两条发言估算；窗口始终从最新往回取。
    let window = rounds.saturating_mul(2);
    let start = entries.len().saturating_sub(window);
    let mut kept: Vec<&ContextEntry> = entries[start..].iter().collect();

    // 超预算就从最旧的一侧整条丢，但至少留一条：最新那条哪怕自己就超预算，
    // 也必须是模型看到的内容，否则这段上下文什么都没说。
    while kept.len() > 1 && total_chars(&kept) > max_chars {
        kept.remove(0);
    }

    kept.iter()
        .map(|entry| format!("{}: {}", entry.speaker.label(), entry.text))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 为标签建议保留会话主线：最早一条有效用户请求，加上最近的对话窗口。
///
/// 标题只需要描述当前窗口，标签则需要知道这条会话长期在做什么；两者不能共用
/// 同一个“只取最近 N 轮”的裁剪口径。
pub fn build_tag_context(turns: &[MessageTurn], rounds: usize, max_chars: usize) -> String {
    if rounds == 0 {
        return String::new();
    }
    let entries = collect_entries(turns);
    if entries.is_empty() {
        return String::new();
    }

    let window = rounds.saturating_mul(2);
    let recent_start = entries.len().saturating_sub(window);
    let first_user = entries
        .iter()
        .position(|entry| entry.speaker == Speaker::User);
    let anchor_is_recent = first_user.is_some_and(|index| index >= recent_start);

    let mut selected: Vec<&ContextEntry> = Vec::new();
    if let Some(index) = first_user.filter(|_| !anchor_is_recent) {
        selected.push(&entries[index]);
    }
    selected.extend(entries[recent_start..].iter());

    while selected.len() > 2 && total_chars(&selected) > max_chars {
        // 保留主线和最新发言，只从中间的旧窗口开始裁剪。
        selected.remove(1);
    }

    let has_anchor = first_user.is_some() && !anchor_is_recent;
    let recent_offset = usize::from(has_anchor);
    let recent = &selected[recent_offset..];
    let mut output = String::new();
    if has_anchor {
        output.push_str("<会话主线>\n");
        output.push_str(&format_entry(selected[0]));
        output.push_str("\n</会话主线>\n\n");
    }
    output.push_str("<最近对话>\n");
    output.push_str(
        &recent
            .iter()
            .map(|entry| format_entry(entry))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    output.push_str("\n</最近对话>");
    output
}

fn format_entry(entry: &ContextEntry) -> String {
    format!("{}: {}", entry.speaker.label(), entry.text)
}

/// 目前保留的发言一共多少字符（含标签，因为它确实占预算）。
fn total_chars(entries: &[&ContextEntry]) -> usize {
    entries
        .iter()
        .map(|entry| entry.speaker.label().chars().count() + 2 + entry.text.chars().count())
        .sum()
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;

    fn turn(id: &str, role: TurnRole, blocks: Vec<ContentBlock>) -> MessageTurn {
        MessageTurn {
            id: id.to_string(),
            role,
            blocks,
            timestamp: Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        }
    }

    fn text(value: &str) -> ContentBlock {
        ContentBlock::Text {
            text: value.to_string(),
        }
    }

    fn thinking(value: &str) -> ContentBlock {
        ContentBlock::Thinking {
            text: value.to_string(),
        }
    }

    fn tool_use() -> ContentBlock {
        ContentBlock::ToolUse {
            tool_use_id: Some("t1".to_string()),
            tool_name: "Bash".to_string(),
            input_preview: Some("cargo test".to_string()),
            status: None,
            meta: None,
        }
    }

    fn tool_result() -> ContentBlock {
        ContentBlock::ToolResult {
            tool_use_id: Some("t1".to_string()),
            output_preview: Some("100 tests passed".to_string()),
            is_error: false,
            agent_stats: None,
            images: Vec::new(),
            exit_code: Some(0),
        }
    }

    /// 话题在正文里，噪声不该进上下文。
    #[test]
    fn only_prose_reaches_the_model() {
        let turns = vec![
            turn("t1", TurnRole::User, vec![text("为什么侧栏的标签不刷新？")]),
            turn(
                "t2",
                TurnRole::Assistant,
                vec![
                    thinking("先看看 sidebar 的更新链路"),
                    tool_use(),
                    tool_result(),
                    text("因为更新事件没有广播出去。"),
                ],
            ),
        ];

        assert_eq!(
            build_context(&turns, DEFAULT_CONTEXT_ROUNDS, MAX_CONTEXT_CHARS),
            "User: 为什么侧栏的标签不刷新？\nAssistant: 因为更新事件没有广播出去。"
        );
    }

    /// 系统轮与没有正文的轮（纯工具调用）不占窗口。
    #[test]
    fn system_and_prose_less_turns_are_skipped() {
        let turns = vec![
            turn("t1", TurnRole::System, vec![text("会话已恢复")]),
            turn("t2", TurnRole::User, vec![text("跑一下测试")]),
            turn("t3", TurnRole::Assistant, vec![tool_use()]),
            turn("t4", TurnRole::Assistant, vec![text("全部通过。")]),
        ];

        assert_eq!(
            build_context(&turns, DEFAULT_CONTEXT_ROUNDS, MAX_CONTEXT_CHARS),
            "User: 跑一下测试\nAssistant: 全部通过。"
        );
    }

    /// 窗口只留最近 N 轮，更早的整条丢掉。
    #[test]
    fn keeps_only_the_last_n_rounds() {
        let turns = vec![
            turn("t1", TurnRole::User, vec![text("第一轮的问题")]),
            turn("t2", TurnRole::Assistant, vec![text("第一轮的回答")]),
            turn("t3", TurnRole::User, vec![text("第二轮的问题")]),
            turn("t4", TurnRole::Assistant, vec![text("第二轮的回答")]),
        ];

        assert_eq!(
            build_context(&turns, 1, MAX_CONTEXT_CHARS),
            "User: 第二轮的问题\nAssistant: 第二轮的回答"
        );
    }

    /// 超预算时从最旧一侧整条丢。
    #[test]
    fn the_oldest_entry_goes_first_when_over_budget() {
        let turns = vec![
            turn("t1", TurnRole::User, vec![text("aaaaaaaaaa")]),
            turn("t2", TurnRole::Assistant, vec![text("bbbbbbbbbb")]),
            turn("t3", TurnRole::User, vec![text("cccccccccc")]),
        ];

        // 三条各占 6+10=16 字符，共 48；给 40 个字符只能装下两条。
        let context = build_context(&turns, DEFAULT_CONTEXT_ROUNDS, 40);

        assert_eq!(context, "Assistant: bbbbbbbbbb\nUser: cccccccccc");
    }

    /// 最新一条哪怕自己超预算也要留下，否则上下文等于没说话。
    #[test]
    fn the_newest_entry_is_never_dropped() {
        let turns = vec![turn(
            "t1",
            TurnRole::User,
            vec![text("x".repeat(50).as_str())],
        )];

        let context = build_context(&turns, DEFAULT_CONTEXT_ROUNDS, 10);

        assert_eq!(context, format!("User: {}", "x".repeat(50)));
    }

    /// 没有被喂任何轮次时给空串，而不是一个空标签。
    #[test]
    fn nothing_to_say_yields_nothing() {
        assert_eq!(
            build_context(&[], DEFAULT_CONTEXT_ROUNDS, MAX_CONTEXT_CHARS),
            ""
        );
        assert_eq!(
            build_context(&[turn("t1", TurnRole::User, vec![text("   ")])], 6, 100),
            ""
        );
        assert_eq!(
            build_context(&[turn("t1", TurnRole::User, vec![text("有正文")])], 0, 100),
            ""
        );
    }

    /// 单轮里出现多段正文时取第一段，避免把一条长回复整个搬进上下文。
    #[test]
    fn only_the_first_prose_block_per_turn_is_used() {
        let turns = vec![turn(
            "t1",
            TurnRole::Assistant,
            vec![
                text("先说结论：是缓存没失效。"),
                text("再补充一段很长的解释……"),
            ],
        )];

        assert_eq!(
            build_context(&turns, DEFAULT_CONTEXT_ROUNDS, MAX_CONTEXT_CHARS),
            "Assistant: 先说结论：是缓存没失效。"
        );
    }

    #[test]
    fn tag_context_keeps_the_first_user_request_and_recent_window() {
        let turns = vec![
            turn("t1", TurnRole::User, vec![text("我要做一个数字人产品")]),
            turn(
                "t2",
                TurnRole::Assistant,
                vec![text("先梳理数字人的能力边界")],
            ),
            turn("t3", TurnRole::User, vec![text("再看输入框交互")]),
            turn("t4", TurnRole::Assistant, vec![text("可以先修复收藏按钮")]),
        ];

        assert_eq!(
            build_tag_context(&turns, 1, MAX_CONTEXT_CHARS),
            "<会话主线>\nUser: 我要做一个数字人产品\n</会话主线>\n\n<最近对话>\nUser: 再看输入框交互\nAssistant: 可以先修复收藏按钮\n</最近对话>"
        );
    }
}
