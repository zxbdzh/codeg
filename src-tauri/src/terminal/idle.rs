//! 终端空闲证据：读行信号、尚未处理的输入及 Windows Job 中的全部进程。

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use portable_pty::CommandBuilder;

static TERMINALS: LazyLock<Mutex<HashMap<String, Arc<TerminalIdle>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Default, Debug)]
pub(crate) struct ShellActivity {
    marker: Vec<u8>,
    buffered: Vec<u8>,
    initialized: bool,
    pending_lines: usize,
    draft: bool,
    uncertain: bool,
    jobs: bool,
}

impl ShellActivity {
    pub(crate) fn new(nonce: &str) -> Self {
        Self {
            marker: format!("\x1b]633;P;CodegIdle={nonce}:").into_bytes(),
            ..Self::default()
        }
    }

    pub(crate) fn input(&mut self, bytes: &[u8]) {
        let mut previous_cr = false;
        for byte in bytes {
            match byte {
                b'\r' | b'\n' => {
                    if *byte != b'\n' || !previous_cr {
                        self.pending_lines = self.pending_lines.saturating_add(1);
                    }
                    self.draft = false;
                }
                0x20..=0xff => self.draft = true,
                // 控制编辑及续行不能可靠重建时，宁可继续等待。
                _ => self.uncertain = true,
            }
            previous_cr = *byte == b'\r';
        }
    }

    pub(crate) fn output(&mut self, bytes: &[u8]) {
        self.buffered.extend_from_slice(bytes);
        while let Some(offset) = self
            .buffered
            .windows(self.marker.len())
            .position(|part| part == self.marker)
        {
            let start = offset + self.marker.len();
            let tail = &self.buffered[start..];
            let bell = tail
                .iter()
                .position(|byte| *byte == 7)
                .map(|position| (position, 1));
            let st = tail
                .windows(2)
                .position(|part| part == b"\x1b\\")
                .map(|position| (position, 2));
            let Some((end, terminator)) = bell.into_iter().chain(st).min_by_key(|entry| entry.0)
            else {
                break;
            };
            let signal = self.buffered[start..start + end].to_vec();
            self.buffered.drain(..start + end + terminator);
            if signal != b"ready" && signal != b"jobs" {
                continue;
            }
            self.jobs = signal == b"jobs";
            if self.initialized {
                self.pending_lines = self.pending_lines.saturating_sub(1);
            } else {
                // 启动提示不能确认在它出现前已经排队的输入。
                self.initialized = true;
            }
        }
        if self.buffered.len() > 8192 {
            let keep = self.marker.len() + 64;
            self.buffered.drain(..self.buffered.len() - keep);
        }
    }

    pub(crate) fn blocker(&self) -> Option<&'static str> {
        if !self.initialized || self.uncertain {
            Some("terminal state is unknown")
        } else if self.pending_lines != 0 || self.draft {
            Some("terminal has a running command or pending input")
        } else if self.jobs {
            Some("terminal has background jobs")
        } else {
            None
        }
    }
}

pub(crate) struct TerminalIdle {
    terminal_id: String,
    activity: Mutex<ShellActivity>,
    #[cfg(windows)]
    process_job: Mutex<Option<windows::ProcessJob>>,
    #[cfg(windows)]
    startup: Option<windows::StartSignal>,
    trusted_startup: bool,
}

impl TerminalIdle {
    pub(crate) fn prepare(
        command: &mut CommandBuilder,
        shell: &str,
        initial_command: Option<&str>,
        terminal_id: &str,
    ) -> Arc<Self> {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        #[cfg(windows)]
        let startup = if initial_command.is_none()
            && super::shell_flavor::shell_basename(shell).starts_with("pwsh")
        {
            windows::StartSignal::new(&nonce).ok()
        } else {
            None
        };
        #[cfg(windows)]
        if initial_command.is_none() {
            match super::shell_flavor::classify_shell_family(shell) {
                super::shell_flavor::ShellFamily::Cmd => {
                    let original = command
                        .get_env("PROMPT")
                        .map(|value| value.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "$P$G ".into());
                    command.env(
                        "PROMPT",
                        format!("{original}$E]633;P;CodegIdle={nonce}:ready$E\\"),
                    );
                }
                super::shell_flavor::ShellFamily::PowerShell if startup.is_some() => {
                    use base64::Engine;
                    let script = include_str!("shell-idle.ps1");
                    #[cfg(test)]
                    let script =
                        format!("Set-PSReadLineOption -HistorySaveStyle SaveNothing\n{script}");
                    let encoded: Vec<_> =
                        script.encode_utf16().flat_map(u16::to_le_bytes).collect();
                    command.get_argv_mut().truncate(1);
                    command.args(["-NoLogo", "-NoProfile", "-NoExit", "-EncodedCommand"]);
                    command.arg(base64::engine::general_purpose::STANDARD.encode(encoded));
                    command.env("CODEG_IDLE_NONCE", &nonce);
                    command.env("CODEG_IDLE_EVENT", &startup.as_ref().unwrap().name);
                }
                _ => {}
            }
        }
        #[cfg(not(windows))]
        let _ = (command, shell, initial_command);
        #[cfg(windows)]
        let trusted_startup = initial_command.is_none()
            && (matches!(
                super::shell_flavor::shell_basename(shell).as_str(),
                "cmd" | "cmd.exe"
            ) || startup.is_some());
        #[cfg(not(windows))]
        let trusted_startup = false;
        Arc::new(Self {
            terminal_id: terminal_id.into(),
            activity: Mutex::new(ShellActivity::new(&nonce)),
            #[cfg(windows)]
            process_job: Mutex::new(None),
            #[cfg(windows)]
            startup,
            trusted_startup,
        })
    }

    pub(crate) fn attach(self: &Arc<Self>, child: &dyn portable_pty::Child) {
        #[cfg(windows)]
        {
            let job = child
                .as_raw_handle()
                .and_then(|handle| windows::ProcessJob::attach(handle as _).ok());
            if let Ok(mut slot) = self.process_job.lock() {
                *slot = job;
            }
            // 即使观测注册失败，也放行终端；它保持未知，不妨碍用户工作。
            if let Some(signal) = &self.startup {
                signal.release();
            }
        }
        #[cfg(not(windows))]
        let _ = child;
        if let Ok(mut terminals) = TERMINALS.lock() {
            terminals.retain(|_, terminal| !terminal.finished());
            terminals.insert(uuid::Uuid::new_v4().to_string(), self.clone());
        }
    }

    pub(crate) fn input(&self, bytes: &[u8]) {
        if let Ok(mut state) = self.activity.lock() {
            state.input(bytes);
        }
    }

    pub(crate) fn output(&self, bytes: &[u8]) {
        if let Ok(mut state) = self.activity.lock() {
            state.output(bytes);
        }
    }

    fn blocker(&self) -> Result<Option<String>, ()> {
        if !self.trusted_startup {
            return Err(());
        }
        #[cfg(windows)]
        {
            let job = self.process_job.lock().map_err(|_| ())?;
            let (active, root_live) = job.as_ref().ok_or(())?.active().ok_or(())?;
            if active == 0 {
                return Ok(None);
            }
            if !root_live || active > 1 {
                return Ok(Some(
                    "terminal has child or detached background processes".into(),
                ));
            }
        }
        #[cfg(not(windows))]
        return Err(());
        #[cfg(windows)]
        Ok(self
            .activity
            .lock()
            .map_err(|_| ())?
            .blocker()
            .map(str::to_string))
    }

    fn finished(&self) -> bool {
        #[cfg(windows)]
        if self.trusted_startup {
            return self
                .process_job
                .lock()
                .ok()
                .and_then(|job| job.as_ref().and_then(windows::ProcessJob::active))
                .is_some_and(|(active, _)| active == 0);
        }
        false
    }
}

pub(crate) fn blockers() -> Vec<String> {
    let Ok(terminals) = TERMINALS.lock() else {
        return vec!["terminal registry is unknown".into()];
    };
    terminals
        .values()
        .filter_map(|terminal| match terminal.blocker() {
            Ok(None) => None,
            Ok(Some(reason)) => Some(format!("{}: {reason}", terminal.terminal_id)),
            Err(()) => Some(format!(
                "{}: terminal state is unknown",
                terminal.terminal_id
            )),
        })
        .collect()
}

#[cfg(windows)]
mod windows {
    use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        QueryInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    };
    use windows_sys::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

    pub(super) struct StartSignal {
        pub name: String,
        handle: OwnedHandle,
    }

    impl StartSignal {
        pub fn new(nonce: &str) -> Result<Self, ()> {
            let name = format!("Local\\CodegIdle-{nonce}");
            let wide: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
            let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, wide.as_ptr()) };
            if handle.is_null() {
                return Err(());
            }
            Ok(Self {
                name,
                handle: unsafe { OwnedHandle::from_raw_handle(handle as _) },
            })
        }

        pub fn release(&self) {
            unsafe {
                SetEvent(self.handle.as_raw_handle() as _);
            }
        }
    }

    pub(super) struct ProcessJob {
        job: OwnedHandle,
        root: OwnedHandle,
    }

    impl ProcessJob {
        pub fn attach(process: HANDLE) -> Result<Self, ()> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(());
            }
            let owned_job = unsafe { OwnedHandle::from_raw_handle(handle as _) };
            let root = unsafe { BorrowedHandle::borrow_raw(process as _) }
                .try_clone_to_owned()
                .map_err(|_| ())?;
            let job = Self {
                job: owned_job,
                root,
            };
            if unsafe { AssignProcessToJobObject(handle, process) } == 0 {
                return Err(());
            }
            Ok(job)
        }

        pub fn active(&self) -> Option<(u32, bool)> {
            unsafe {
                let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                let result = QueryInformationJobObject(
                    self.job.as_raw_handle() as _,
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut _,
                    std::mem::size_of_val(&accounting) as u32,
                    std::ptr::null_mut(),
                );
                let root_live = match WaitForSingleObject(self.root.as_raw_handle() as _, 0) {
                    WAIT_OBJECT_0 => false,
                    WAIT_TIMEOUT => true,
                    _ => return None,
                };
                (result != 0).then_some((accounting.ActiveProcesses, root_live))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_input_and_unacknowledged_lines_block_restart() {
        let mut state = ShellActivity::new("fixture");
        state.input(b"first\rsecond\r");
        state.output(b"\x1b]633;P;CodegIdle=fixture:ready\x07");
        state.output(b"\x1b]633;P;CodegIdle=fixture:ready\x07");
        assert!(state.blocker().is_some());
        state.output(b"\x1b]633;P;CodegIdle=fixture:ready\x07");
        assert!(state.blocker().is_none());
        state.input(b"\x1b[A");
        state.output(b"\x1b]633;P;CodegIdle=fixture:ready\x07");
        assert!(state.blocker().is_some());
    }

    #[test]
    fn split_and_unrelated_markers_do_not_lose_pending_input() {
        let mut state = ShellActivity::new("fixture");
        for byte in b"\x1b]633;P;CodegIdle=fixture:ready\x1b\\" {
            state.output(&[*byte]);
        }
        assert!(state.blocker().is_none());
        state.input(b"sleep\r");
        state.output(b"\x1b]633;P;CodegIdle=other:ready\x07");
        assert!(state.blocker().is_some());
    }
}
