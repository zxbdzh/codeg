//! 什么时候该重新生成会话标题。
//!
//! 这个判断被单拎出来是因为它是整条链路上唯二"会花钱"的地方（另一处是标签
//! 建议）。把它写成纯函数，就能把每一条会改变行为的条件都钉在测试里：来源、
//! 手动锁定、有没有新内容、够不够间隔。

use serde::{Deserialize, Serialize};

/// 谁负责这条会话的标题。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    /// Codeg 自己生成。默认值——这就是"接管"。
    #[default]
    Codeg,
    /// 被聚合的智能体 CLI 写的标题。本功能整体关闭。
    Agent,
    /// 只在同伴没给标题时补一个。
    Fallback,
}

/// 两次生成之间的最小间隔默认值。太短会让每轮对话都烧一次 token。
pub const DEFAULT_MIN_INTERVAL_SECONDS: u64 = 30;

/// 最小间隔允许的下限：再小就等于没有节流。
pub const MIN_ALLOWED_INTERVAL_SECONDS: u64 = 5;

/// 最小间隔允许的上限：一小时。
pub const MAX_ALLOWED_INTERVAL_SECONDS: u64 = 3600;

/// 一次生成机会的输入。
#[derive(Debug, Clone, Copy)]
pub struct TitleGate {
    pub source: TitleSource,
    /// 用户亲手改过标题。它压过一切自动来源。
    pub title_locked: bool,
    /// 标题为空或空白。
    pub title_is_empty: bool,
    /// 距上一次为这条会话生成过了多少秒。`None` = 从没生成过。
    pub seconds_since_last_attempt: Option<u64>,
    /// 上次之后出现过新的用户正文。
    pub has_new_user_text: bool,
    /// 用户手动点了刷新。
    pub force: bool,
}

/// 这一轮该不该生成标题。
pub fn should_generate_title(gate: TitleGate, min_interval_seconds: u64) -> bool {
    // 来源是同伴时本功能整体关闭；手动刷新也不能越过这条——那是用户自己选的。
    if gate.source == TitleSource::Agent {
        return false;
    }
    // 手动锁定优先于一切自动来源，包括 force。
    if gate.title_locked {
        return false;
    }
    // "仅在缺失时补"不接管已有标题，force 也不行。
    if gate.source == TitleSource::Fallback && !gate.title_is_empty {
        return false;
    }

    // force 绕过节流与"有没有新内容"，因为这两条都是省钱的启发式，而用户
    // 已经明确表示"现在就要"。
    if gate.force {
        return true;
    }

    let interval_elapsed = match gate.seconds_since_last_attempt {
        Some(seconds) => seconds >= min_interval_seconds,
        // 从没生成过：没有节流可欠。
        None => true,
    };

    interval_elapsed && gate.has_new_user_text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> TitleGate {
        TitleGate {
            source: TitleSource::Codeg,
            title_locked: false,
            title_is_empty: false,
            seconds_since_last_attempt: Some(120),
            has_new_user_text: true,
            force: false,
        }
    }

    #[test]
    fn a_new_turn_after_the_interval_generates() {
        assert!(should_generate_title(gate(), DEFAULT_MIN_INTERVAL_SECONDS));
    }

    #[test]
    fn the_first_ever_title_generates_without_waiting() {
        let gate = TitleGate {
            seconds_since_last_attempt: None,
            ..gate()
        };

        assert!(should_generate_title(gate, DEFAULT_MIN_INTERVAL_SECONDS));
    }

    #[test]
    fn too_soon_after_the_last_attempt_does_nothing() {
        let gate = TitleGate {
            seconds_since_last_attempt: Some(10),
            ..gate()
        };

        assert!(!should_generate_title(gate, DEFAULT_MIN_INTERVAL_SECONDS));
    }

    #[test]
    fn no_new_user_text_means_nothing_to_retitle() {
        let gate = TitleGate {
            has_new_user_text: false,
            ..gate()
        };

        assert!(!should_generate_title(gate, DEFAULT_MIN_INTERVAL_SECONDS));
    }

    #[test]
    fn a_manually_locked_title_is_never_touched() {
        let gate = TitleGate {
            title_locked: true,
            force: true,
            ..gate()
        };

        assert!(!should_generate_title(gate, DEFAULT_MIN_INTERVAL_SECONDS));
    }

    #[test]
    fn the_agent_source_disables_the_feature_entirely() {
        let gate = TitleGate {
            source: TitleSource::Agent,
            force: true,
            seconds_since_last_attempt: None,
            ..gate()
        };

        assert!(!should_generate_title(gate, DEFAULT_MIN_INTERVAL_SECONDS));
    }

    #[test]
    fn fallback_only_fills_a_missing_title() {
        let with_title = TitleGate {
            source: TitleSource::Fallback,
            force: true,
            ..gate()
        };
        let without_title = TitleGate {
            source: TitleSource::Fallback,
            title_is_empty: true,
            ..gate()
        };

        assert!(!should_generate_title(with_title, DEFAULT_MIN_INTERVAL_SECONDS));
        assert!(should_generate_title(without_title, DEFAULT_MIN_INTERVAL_SECONDS));
    }

    #[test]
    fn force_skips_the_interval_and_the_new_text_check() {
        let gate = TitleGate {
            seconds_since_last_attempt: Some(0),
            has_new_user_text: false,
            force: true,
            ..gate()
        };

        assert!(should_generate_title(gate, DEFAULT_MIN_INTERVAL_SECONDS));
    }
}
