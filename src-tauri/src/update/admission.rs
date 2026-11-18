//! 更新前的任务准入。所有实例共享进程级门禁，测试可创建独立门禁。

use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock, Mutex};

pub const WAIT_MESSAGE: &str =
    "Codeg is preparing an update; wait for it to finish or cancel the update";

static GLOBAL: LazyLock<AdmissionGate> = LazyLock::new(AdmissionGate::default);

#[derive(Default, Debug)]
struct State {
    revision: u64,
    active: BTreeMap<&'static str, usize>,
    frozen: bool,
}

#[derive(Clone, Default, Debug)]
pub struct AdmissionGate(Arc<Mutex<State>>);

/// 允许将准入凭据交给取消保护的后台任务，直到最后一个持有者退出才释放。
#[derive(Clone)]
pub struct Admission(Arc<Lease>);

struct Lease {
    gate: AdmissionGate,
    kind: &'static str,
}

pub struct Frozen(AdmissionGate);

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub revision: u64,
    pub active: Vec<String>,
}

pub fn global() -> &'static AdmissionGate {
    &GLOBAL
}

pub fn admit(kind: &'static str) -> Result<Admission, String> {
    global().enter(kind)
}

impl AdmissionGate {
    pub fn enter(&self, kind: &'static str) -> Result<Admission, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Task admission state is unknown")?;
        if state.frozen {
            return Err(WAIT_MESSAGE.into());
        }
        state.revision = state
            .revision
            .checked_add(1)
            .ok_or("Task revision overflow")?;
        *state.active.entry(kind).or_default() += 1;
        Ok(Admission(Arc::new(Lease {
            gate: self.clone(),
            kind,
        })))
    }

    pub fn snapshot(&self) -> Result<Snapshot, String> {
        let state = self
            .0
            .lock()
            .map_err(|_| "Task admission state is unknown")?;
        Ok(Snapshot {
            revision: state.revision,
            active: state.active.keys().map(|kind| kind.to_string()).collect(),
        })
    }

    pub fn freeze(&self, expected_revision: u64) -> Result<Frozen, String> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| "Task admission state is unknown")?;
        if state.frozen || !state.active.is_empty() || state.revision != expected_revision {
            return Err("Tasks changed or are still being admitted; keep waiting".into());
        }
        // 同一临界区内检查版本并关闭准入，消除“空闲检查后又启动任务”的空档。
        state.frozen = true;
        Ok(Frozen(self.clone()))
    }
}

impl Admission {
    pub fn kind(&self) -> &'static str {
        self.0.kind
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.gate.0.lock() {
            if let Some(count) = state.active.get_mut(self.kind) {
                *count -= 1;
                if *count == 0 {
                    state.active.remove(self.kind);
                }
            }
        }
    }
}

impl Drop for Frozen {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0 .0.lock() {
            state.frozen = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelled_caller_cannot_hide_detached_work() {
        let gate = AdmissionGate::default();
        let caller = gate.enter("link").unwrap();
        let detached = caller.clone();
        drop(caller);
        assert!(gate.freeze(gate.snapshot().unwrap().revision).is_err());
        drop(detached);
        assert!(gate.freeze(gate.snapshot().unwrap().revision).is_ok());
    }

    #[test]
    fn completed_task_invalidates_a_stale_idle_snapshot() {
        let gate = AdmissionGate::default();
        let revision = gate.snapshot().unwrap().revision;
        drop(gate.enter("web").unwrap());
        assert!(gate.freeze(revision).is_err());
    }

    #[test]
    fn freeze_blocks_new_work_and_drop_reopens_admission() {
        let gate = AdmissionGate::default();
        let frozen = gate.freeze(gate.snapshot().unwrap().revision).unwrap();
        assert!(gate.enter("terminal").is_err());
        drop(frozen);
        assert!(gate.enter("terminal").is_ok());
    }
}
