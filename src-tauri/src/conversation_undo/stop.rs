use std::time::Duration;

use crate::acp::manager::ConnectionManager;
use crate::acp::session_state::SessionState;
use crate::acp::types::ConnectionStatus;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::AppDatabase;
use crate::models::AgentType;

fn has_work(state: &SessionState) -> bool {
    state.turn_in_flight
        || state.agent_initiated_turn
        || matches!(
            state.status,
            ConnectionStatus::Prompting | ConnectionStatus::Connecting
        )
        || state.live_message.is_some()
        || !state.active_tool_calls.is_empty()
        || !state.active_delegations.is_empty()
        || !state.delegated_children.is_empty()
        || state.background_outstanding > 0
        || state.pending_permission.is_some()
        || state.pending_question.is_some()
        || state.pending_plan_approval.is_some()
        || state.remote_control.is_some()
        || state
            .async_tasks
            .values()
            .any(|task| !crate::acp::types::async_task_state_is_terminal(&task.state))
}

fn stop_failed(detail: impl Into<String>) -> AppCommandError {
    AppCommandError::new(
        AppErrorCode::TurnInProgress,
        "The session work could not be stopped; conversation history has been kept",
    )
    .with_detail(detail)
}

pub(super) async fn session_tasks(
    manager: &ConnectionManager,
    agent_type: AgentType,
    session_id: &str,
) -> Vec<super::UndoTask> {
    let states = {
        let connections = manager.connections.lock().await;
        connections
            .values()
            .map(|connection| (connection.id.clone(), connection.state.clone()))
            .collect::<Vec<_>>()
    };
    let mut tasks = Vec::new();
    for (connection_id, state) in states {
        let state = state.read().await;
        if state.agent_type != agent_type || state.external_id.as_deref() != Some(session_id) {
            continue;
        }
        if state.turn_in_flight
            || state.agent_initiated_turn
            || state.live_message.is_some()
            || matches!(
                state.status,
                ConnectionStatus::Prompting | ConnectionStatus::Connecting
            )
            || state.pending_permission.is_some()
            || state.pending_question.is_some()
            || state.pending_plan_approval.is_some()
        {
            tasks.push(super::UndoTask {
                id: format!("{connection_id}:turn"),
                kind: "turn".into(),
                label: None,
            });
        }
        let mut seen = std::collections::BTreeSet::new();
        for task in state
            .async_tasks
            .values()
            .filter(|task| !crate::acp::types::async_task_state_is_terminal(&task.state))
        {
            seen.insert(task.task_id.clone());
            tasks.push(super::UndoTask {
                id: format!("{connection_id}:{}", task.task_id),
                kind: "background".into(),
                label: Some(task.name.clone()),
            });
        }
        for task in &state.background_outstanding_tasks {
            if seen.insert(task.task_id.clone()) {
                tasks.push(super::UndoTask {
                    id: format!("{connection_id}:{}", task.task_id),
                    kind: "background".into(),
                    label: task.description.clone(),
                });
            }
        }
        for task in state.active_delegations.values() {
            tasks.push(super::UndoTask {
                id: format!("{connection_id}:delegate:{}", task.child_connection_id),
                kind: "delegation".into(),
                label: Some(format!("{}: {}", task.agent_type, task.task_preview)),
            });
        }
        for child in &state.delegated_children {
            if state
                .active_delegations
                .values()
                .any(|task| &task.child_connection_id == child)
            {
                continue;
            }
            // 没有匹配到工具卡片的委托同样会回写结果，不能从确认范围中漏掉。
            tasks.push(super::UndoTask {
                id: format!("{connection_id}:delegate:{child}"),
                kind: "delegation".into(),
                label: Some(format!("Delegated task {child}")),
            });
        }
        if state.background_outstanding > 0
            && seen.is_empty()
            && state.active_delegations.is_empty()
        {
            tasks.push(super::UndoTask {
                id: format!("{connection_id}:background"),
                kind: "background".into(),
                label: None,
            });
        }
        if state.remote_control.is_some() {
            tasks.push(super::UndoTask {
                id: format!("{connection_id}:remote"),
                kind: "background".into(),
                label: Some("Remote Control".into()),
            });
        }
    }
    tasks
}

pub(super) async fn stop_work(
    db: &AppDatabase,
    manager: &ConnectionManager,
    agent_type: AgentType,
    session_id: &str,
) -> Result<(), AppCommandError> {
    let entries = {
        let connections = manager.connections.lock().await;
        connections
            .values()
            .map(|connection| (connection.id.clone(), connection.state.clone()))
            .collect::<Vec<_>>()
    };
    for (connection_id, state) in entries {
        let snapshot = state.read().await;
        // 任务归属只看智能体和原生会话身份，同目录的其他会话不属于停止范围。
        if snapshot.agent_type != agent_type
            || snapshot.external_id.as_deref() != Some(session_id)
            || !has_work(&snapshot)
        {
            continue;
        }
        if snapshot.remote_control.is_some() {
            return Err(stop_failed("Turn Remote Control off before Undo"));
        }
        let tasks = snapshot
            .async_tasks
            .values()
            .filter(|task| !crate::acp::types::async_task_state_is_terminal(&task.state))
            .map(|task| task.task_id.clone())
            .collect::<Vec<_>>();
        let mut child_ids = snapshot.delegated_children.clone();
        child_ids.extend(
            snapshot
                .active_delegations
                .values()
                .map(|task| task.child_connection_id.clone()),
        );
        drop(snapshot);
        let mut children = Vec::new();
        let mut visited = std::collections::BTreeSet::from([connection_id.clone()]);
        while let Some(child_id) = child_ids.pop_first() {
            if !visited.insert(child_id.clone()) {
                continue;
            }
            let child = {
                let connections = manager.connections.lock().await;
                connections
                    .get(&child_id)
                    .map(|child| (child.state.clone(), child.child_pid.clone()))
            };
            if let Some((state, pid)) = child {
                let child = state.read().await;
                child_ids.extend(child.delegated_children.iter().cloned());
                child_ids.extend(
                    child
                        .active_delegations
                        .values()
                        .map(|task| task.child_connection_id.clone()),
                );
                drop(child);
                children.push((state, pid));
            }
        }
        let stopped = tokio::time::timeout(Duration::from_secs(5), async {
            for task_id in tasks {
                let accepted = manager
                    .stop_async_task(&connection_id, &task_id)
                    .await
                    .map_err(|error| stop_failed(error.to_string()))?;
                if !accepted {
                    // 原生适配器明确拒绝停止时，不能用稍后的空闲状态冒充全部停止成功。
                    return Err(stop_failed(format!("Task {task_id} refused to stop")));
                }
            }
            manager
                .cancel(&db.conn, &connection_id)
                .await
                .map_err(|error| stop_failed(error.to_string()))?;
            loop {
                let busy = {
                    let snapshot = state.read().await;
                    has_work(&snapshot)
                };
                let mut children_busy = false;
                for (state, pid) in &children {
                    let snapshot = state.read().await;
                    // 委托结束事件可能早于进程回收；保留 PID 单元，直到真实退出后才允许改原生历史。
                    if pid.load(std::sync::atomic::Ordering::SeqCst) != 0 || has_work(&snapshot) {
                        children_busy = true;
                        break;
                    }
                }
                if !busy && !children_busy {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            Ok::<_, AppCommandError>(())
        })
        .await
        .map_err(|_| stop_failed("Stopping the session work timed out"))?;
        stopped?;
    }
    Ok(())
}
