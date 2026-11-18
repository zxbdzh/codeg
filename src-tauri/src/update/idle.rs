use crate::acp::manager::ConnectionManager;
use crate::db::AppDatabase;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};

use super::admission::{self, Frozen};

#[derive(Debug)]
pub struct Readiness {
    pub revision: u64,
    pub blockers: Vec<String>,
    pub wait_reasons: Vec<String>,
}

pub async fn readiness(manager: &ConnectionManager, db: &AppDatabase) -> Result<Readiness, String> {
    let before = admission::global().snapshot()?;
    let mut blockers = manager.update_blockers().await;
    let mut wait_reasons = Vec::new();
    if !blockers.is_empty() {
        wait_reasons.push("agent".into());
    }
    let terminal_blockers = crate::terminal::idle::blockers();
    if !terminal_blockers.is_empty() {
        wait_reasons.push("terminal".into());
        blockers.extend(terminal_blockers);
    }
    use crate::db::entities::{automation_run, work_task};
    let active_automations = automation_run::Entity::find()
        .filter(automation_run::Column::Status.eq(automation_run::AutomationRunStatus::Running))
        .count(&db.conn)
        .await
        .map_err(|error| error.to_string())?;
    if active_automations != 0 {
        wait_reasons.push("automation".into());
        blockers.push(format!("{active_automations} active automation runs"));
    }
    // review 可能仍在做验收或等待合并；不能单凭 Agent 已回合结束就退出。
    let active_tasks = work_task::Entity::find()
        .filter(work_task::Column::Status.is_in([
            work_task::WorkTaskStatus::Queued,
            work_task::WorkTaskStatus::Preparing,
            work_task::WorkTaskStatus::Running,
            work_task::WorkTaskStatus::AwaitingInput,
            work_task::WorkTaskStatus::Review,
            work_task::WorkTaskStatus::Merging,
        ]))
        .count(&db.conn)
        .await
        .map_err(|error| error.to_string())?;
    if active_tasks != 0 {
        wait_reasons.push("work_task".into());
        blockers.push(format!("{active_tasks} unfinished work tasks"));
    }
    let after = admission::global().snapshot()?;
    blockers.extend(after.active.iter().map(|kind| format!("admitting {kind}")));
    if !after.active.is_empty() || before.revision != after.revision {
        wait_reasons.push("new_work".into());
    }
    if before.revision != after.revision {
        blockers.push("new work arrived during the idle check".into());
    }
    Ok(Readiness {
        revision: after.revision,
        blockers,
        wait_reasons,
    })
}

pub async fn prepare_restart(
    manager: &ConnectionManager,
    db: &AppDatabase,
) -> Result<Frozen, String> {
    let first = readiness(manager, db).await?;
    if !first.blockers.is_empty() {
        return Err(first.blockers.join("; "));
    }
    freeze_and_recheck(manager, db, first.revision).await
}

pub async fn prepare_restart_at_revision(
    manager: &ConnectionManager,
    db: &AppDatabase,
    revision: u64,
) -> Result<Frozen, String> {
    let first = readiness(manager, db).await?;
    if first.revision != revision || !first.blockers.is_empty() {
        return Err("Work changed during the restart countdown; keep waiting".into());
    }
    freeze_and_recheck(manager, db, revision).await
}

async fn freeze_and_recheck(
    manager: &ConnectionManager,
    db: &AppDatabase,
    revision: u64,
) -> Result<Frozen, String> {
    let frozen = admission::global().freeze(revision)?;
    // 关闭准入之后再次看实际状态；失败时凭据自动释放，现有任务继续工作。
    let final_check = readiness(manager, db).await?;
    if !final_check.blockers.is_empty() {
        return Err(final_check.blockers.join("; "));
    }
    Ok(frozen)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::models::agent::AgentType;
    use crate::terminal::manager::{SpawnOptions, TerminalManager};
    use crate::web::event_bridge::EventEmitter;
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};

    struct TerminalCleanup(TerminalManager);

    impl Drop for TerminalCleanup {
        fn drop(&mut self) {
            self.0.kill_all();
        }
    }

    async fn wait_idle(manager: &ConnectionManager, db: &AppDatabase) {
        let started = Instant::now();
        loop {
            let check = readiness(manager, db).await.unwrap();
            if check.blockers.is_empty() {
                return;
            }
            assert!(
                started.elapsed() < Duration::from_secs(12),
                "{:?}",
                check.blockers
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }

    fn spawn(terminal: &TerminalManager, shell: &str, id: &str, cwd: &str) {
        terminal
            .spawn_with_id(
                SpawnOptions {
                    terminal_id: id.into(),
                    working_dir: cwd.into(),
                    owner_window_label: "idle-acceptance".into(),
                    shell: Some(shell.into()),
                    initial_command: None,
                    extra_env: None,
                    temp_files: Vec::new(),
                },
                EventEmitter::Noop,
            )
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "独立验收会短暂冻结本测试进程的全局准入，须单独运行 --ignored --test-threads=1"]
    async fn idle_update_acceptance_real_terminals_and_admission() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let manager = ConnectionManager::new();
        let terminals = TerminalManager::new();
        let _cleanup = TerminalCleanup(terminals.clone_ref());
        let directory = tempfile::Builder::new()
            .prefix("idle-update-")
            .tempdir_in("F:/tmp/ego")
            .unwrap();
        let cwd = directory.path().to_str().unwrap();
        let source = "idle-acceptance-connection";
        manager
            .insert_test_connection(source, AgentType::Codex, None, EventEmitter::Noop)
            .await;
        spawn(
            &terminals,
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            "idle-pwsh",
            cwd,
        );
        wait_idle(&manager, &db).await;
        terminals
            .write("idle-pwsh", b"Start-Sleep -Seconds 1\r")
            .unwrap();
        assert!(!readiness(&manager, &db).await.unwrap().blockers.is_empty());
        assert!(prepare_restart(&manager, &db).await.is_err());
        wait_idle(&manager, &db).await;

        let frozen = prepare_restart(&manager, &db).await.unwrap();
        let denied_file = directory.path().join("denied.txt");
        let write = format!(
            "'not allowed' | Set-Content -LiteralPath '{}'\r",
            denied_file.display()
        );
        assert!(terminals.write("idle-pwsh", write.as_bytes()).is_err());
        let prompt_error = manager
            .send_prompt(
                source,
                vec![crate::acp::types::PromptInputBlock::Text {
                    text: "must not run".into(),
                }],
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(
            prompt_error.contains("preparing an update"),
            "{prompt_error}"
        );
        let spawn_error = manager
            .spawn_agent(
                AgentType::Codex,
                None,
                None,
                BTreeMap::new(),
                "idle-acceptance".into(),
                EventEmitter::Noop,
                None,
                BTreeMap::new(),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(spawn_error.contains("preparing an update"), "{spawn_error}");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            !denied_file.exists(),
            "blocked input still reached the real shell"
        );
        drop(frozen);
        let resumed = directory.path().join("resumed.txt");
        terminals
            .write(
                "idle-pwsh",
                format!(
                    "'resumed' | Set-Content -LiteralPath '{}'\r",
                    resumed.display()
                )
                .as_bytes(),
            )
            .unwrap();
        wait_idle(&manager, &db).await;
        assert_eq!(std::fs::read_to_string(&resumed).unwrap().trim(), "resumed");
        terminals.write("idle-pwsh", b"exit\r").unwrap();
        wait_idle(&manager, &db).await;

        spawn(&terminals, r"C:\Windows\System32\cmd.exe", "idle-cmd", cwd);
        wait_idle(&manager, &db).await;
        terminals.write("idle-cmd", b"start /b \"\" \"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -NoLogo -NoProfile -Command Start-Sleep -Seconds 3 & exit\r").unwrap();
        tokio::time::sleep(Duration::from_millis(350)).await;
        let check = readiness(&manager, &db).await.unwrap();
        assert!(
            check
                .blockers
                .iter()
                .any(|reason| reason.contains("background processes")),
            "{:?}",
            check.blockers
        );
        assert!(prepare_restart(&manager, &db).await.is_err());
        wait_idle(&manager, &db).await;
        drop(prepare_restart(&manager, &db).await.unwrap());
        assert!(admission::admit("acceptance_complete").is_ok());
        println!("IDLE_UPDATE_REAL_ACCEPTANCE_PASSED: no installer or application restart invoked");
    }
}
