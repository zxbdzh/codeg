//! 将刚完成的正文快照接到持久化历史之后，避免标题生成读到上一轮。
use crate::models::message::{MessageTurn, TurnRole};

/// transcript 已记录当前 prompt 时，截掉它及其未完成回复，再用完成快照补齐。
/// 这里只重建发给标题模型的上下文，不修改真正的会话历史。
pub fn merge_completed_turn(
    mut persisted: Vec<MessageTurn>,
    completed: &[MessageTurn],
) -> Vec<MessageTurn> {
    let Some(user) = completed
        .iter()
        .find(|turn| matches!(turn.role, TurnRole::User))
    else {
        return persisted;
    };
    let text = crate::ai::context::text_of_turn(user);
    if let Some(index) = persisted.iter().position(|turn| {
        matches!(turn.role, TurnRole::User)
            && (turn.id == user.id
                || (turn.timestamp >= user.timestamp
                    && crate::ai::context::text_of_turn(turn) == text))
    }) {
        // 新一轮可能已开始落盘；本次任务只观察此完成事件所对应的轮次。
        persisted.truncate(index);
    }
    persisted.extend_from_slice(completed);
    persisted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::message::ContentBlock;
    use chrono::{TimeZone, Utc};

    fn turn(id: &str, role: TurnRole, text: &str, second: i64) -> MessageTurn {
        MessageTurn {
            id: id.into(),
            role,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            timestamp: Utc.timestamp_opt(1_800_000_000 + second, 0).unwrap(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        }
    }

    #[test]
    fn a_persisted_partial_reply_is_replaced_without_duplicating_the_current_prompt() {
        let persisted = vec![
            turn("old-u", TurnRole::User, "旧问题", 0),
            turn("old-a", TurnRole::Assistant, "旧回答", 1),
            turn("parser-u", TurnRole::User, "新问题", 10),
            turn("parser-a", TurnRole::Assistant, "只写了一半", 11),
        ];
        let completed = vec![
            turn("live-u", TurnRole::User, "新问题", 10),
            turn("live-a", TurnRole::Assistant, "完整回答", 12),
        ];

        let merged = merge_completed_turn(persisted, &completed);

        assert_eq!(
            merged.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            vec!["old-u", "old-a", "live-u", "live-a"]
        );
    }
}
