use std::time::Duration;

use crate::acp::manager::ConnectionManager;
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

use super::admission::Frozen;
use super::state::{self, AppUpdateStateHandle};

pub const COUNTDOWN: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct IdleCountdown {
    idle_since: Option<(u64, tokio::time::Instant)>,
}

impl IdleCountdown {
    pub fn observe(&mut self, revision: u64, busy: bool, now: tokio::time::Instant) -> Option<u8> {
        if busy {
            self.idle_since = None;
            return None;
        }
        let (previous_revision, since) = self.idle_since.get_or_insert((revision, now));
        if *previous_revision != revision {
            *previous_revision = revision;
            *since = now;
        }
        Some(
            COUNTDOWN
                .saturating_sub(now.duration_since(*since))
                .as_secs_f64()
                .ceil() as u8,
        )
    }
}

/// 等待属于后端进程而非页面，关闭设置页或 Web 断线不会丢掉已确认的等待意图。
pub async fn wait_until_ready(
    handle: &AppUpdateStateHandle,
    emitter: &EventEmitter,
    generation: u64,
    manager: &ConnectionManager,
    db: &AppDatabase,
) -> Option<Frozen> {
    let mut countdown = IdleCountdown::default();
    loop {
        if !state::is_waiting(handle, generation) {
            return None;
        }
        let observation = super::idle::readiness(manager, db).await;
        let (revision, reasons) = match observation {
            Ok(check) => (check.revision, check.wait_reasons),
            Err(_) => (0, vec!["unknown".into()]),
        };
        let seconds = countdown.observe(revision, !reasons.is_empty(), tokio::time::Instant::now());
        if !state::update_idle_wait(handle, emitter, generation, reasons, seconds) {
            return None;
        }
        if seconds == Some(0) {
            match super::idle::prepare_restart_at_revision(manager, db, revision).await {
                Ok(frozen) => return Some(frozen),
                Err(_) => {
                    countdown = IdleCountdown::default();
                    if !state::update_idle_wait(
                        handle,
                        emitter,
                        generation,
                        vec!["new_work".into()],
                        None,
                    ) {
                        return None;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_work_and_uncertainty_restart_the_whole_countdown() {
        let now = tokio::time::Instant::now();
        let mut timer = IdleCountdown::default();
        assert_eq!(timer.observe(1, false, now), Some(10));
        assert_eq!(
            timer.observe(1, false, now + Duration::from_secs(9)),
            Some(1)
        );
        assert_eq!(
            timer.observe(2, false, now + Duration::from_secs(10)),
            Some(10)
        );
        assert_eq!(timer.observe(2, true, now + Duration::from_secs(15)), None);
        assert_eq!(
            timer.observe(2, false, now + Duration::from_secs(20)),
            Some(10)
        );
        assert_eq!(
            timer.observe(2, false, now + Duration::from_secs(30)),
            Some(0)
        );
    }
}
