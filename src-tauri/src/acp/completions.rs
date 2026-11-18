use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub(crate) const COMPLETION_WINDOW: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Default)]
pub(crate) struct RecentCompletions {
    entries: VecDeque<(Instant, i32)>,
}

impl RecentCompletions {
    pub(crate) fn record(&mut self, conversation_id: i32, now: Instant) {
        self.prune(now);
        self.entries.push_back((now, conversation_id));
    }

    pub(crate) fn conversation_ids(&mut self, now: Instant) -> Vec<i32> {
        self.prune(now);
        self.entries.iter().map(|(_, id)| *id).collect()
    }

    fn prune(&mut self, now: Instant) {
        // 使用单调时钟，系统校时不会让完成数突然增加或长期无法过期。
        self.entries
            .retain(|(finished, _)| now.saturating_duration_since(*finished) < COMPLETION_WINDOW);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completions_expire_at_the_fifteen_minute_boundary() {
        let start = Instant::now();
        let mut history = RecentCompletions::default();
        history.record(1, start);
        history.record(2, start + Duration::from_secs(1));

        assert_eq!(
            history.conversation_ids(start + COMPLETION_WINDOW - Duration::from_millis(1)),
            vec![1, 2]
        );
        assert_eq!(history.conversation_ids(start + COMPLETION_WINDOW), vec![2]);
        assert!(history
            .conversation_ids(start + COMPLETION_WINDOW + Duration::from_secs(1))
            .is_empty());
    }

    #[test]
    fn separate_completed_turns_of_one_conversation_are_counted() {
        let start = Instant::now();
        let mut history = RecentCompletions::default();
        history.record(7, start);
        history.record(7, start + Duration::from_secs(5));

        assert_eq!(
            history.conversation_ids(start + Duration::from_secs(6)),
            vec![7, 7]
        );
    }
}
