use super::*;

impl ConnectionManager {
    /// 更新检查覆盖全部连接，包括未绑定会话的启动中连接及人工待处理项。
    pub(crate) async fn update_blockers(&self) -> Vec<String> {
        let (states, live): (Vec<_>, std::collections::HashSet<String>) = {
            let connections = self.connections.lock().await;
            (
                connections
                    .iter()
                    .map(|(id, connection)| (id.clone(), connection.state.clone()))
                    .collect(),
                connections.keys().cloned().collect(),
            )
        };
        let now = chrono::Utc::now();
        let mut blockers = Vec::new();
        {
            let mut draining = self.draining.lock().await;
            prune_reaped(&mut draining);
            if !draining.is_empty() {
                blockers.push("agent processes are still shutting down".into());
            }
        }
        for (id, state) in states {
            let state = state.read().await;
            let reason = if state.pending_question.is_some() {
                Some("pending question".to_string())
            } else if state.pending_plan_approval.is_some() {
                Some("pending plan approval".to_string())
            } else if state.pending_permission.is_some() {
                Some("pending permission".to_string())
            } else if state.turn_in_flight || state.status == ConnectionStatus::Prompting {
                Some("active turn".to_string())
            } else if state.goal_active {
                Some("active goal".to_string())
            } else if state.cli_run.is_some() {
                Some("CLI run is still attached".to_string())
            } else if state.background_outstanding != 0
                || state
                    .async_tasks
                    .values()
                    .any(|task| !crate::acp::types::async_task_state_is_terminal(&task.state))
            {
                // idle sweep 的超时只用于回收连接；更新不能把过期的运行声明当作完成。
                Some("background work is running or its completion is unknown".to_string())
            } else if let Some(reason) = teardown_blocker(&state, now, |child| live.contains(child))
            {
                Some(format!("{reason:?}"))
            } else if state.status == ConnectionStatus::Connecting {
                Some("agent is connecting".to_string())
            } else {
                None
            };
            if let Some(reason) = reason {
                blockers.push(format!("{id}: {reason}"));
            }
        }
        blockers
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::plan_approval::PendingPlanApprovalState;
    use crate::acp::question::PendingQuestionState;

    #[tokio::test]
    async fn idle_update_keeps_questions_approvals_and_turns_busy() {
        let manager = ConnectionManager::new();
        manager
            .insert_test_connection("idle-check", AgentType::Codex, None, EventEmitter::Noop)
            .await;
        let state = manager
            .connections
            .lock()
            .await
            .get("idle-check")
            .unwrap()
            .state
            .clone();
        assert!(manager.update_blockers().await.is_empty());
        state.write().await.pending_question = Some(PendingQuestionState {
            question_id: "pending".into(),
            questions: Vec::new(),
            created_at: chrono::Utc::now(),
        });
        assert!(manager
            .update_blockers()
            .await
            .iter()
            .any(|reason| reason.contains("pending question")));
        {
            let mut state = state.write().await;
            state.pending_question = None;
            state.pending_plan_approval = Some(PendingPlanApprovalState {
                approval_id: "plan".into(),
                tool_call_id: "tool".into(),
                plan_markdown: "plan".into(),
                created_at: chrono::Utc::now(),
            });
        }
        assert!(manager
            .update_blockers()
            .await
            .iter()
            .any(|reason| reason.contains("pending plan approval")));
        {
            let mut state = state.write().await;
            state.pending_plan_approval = None;
            state.turn_in_flight = true;
        }
        assert!(manager
            .update_blockers()
            .await
            .iter()
            .any(|reason| reason.contains("active turn")));
        assert!(
            state.read().await.turn_in_flight,
            "inspection must not cancel the turn"
        );
        {
            let mut state = state.write().await;
            state.turn_in_flight = false;
            state.goal_active = true;
        }
        assert!(manager
            .update_blockers()
            .await
            .iter()
            .any(|reason| reason.contains("active goal")));
        {
            let mut state = state.write().await;
            state.goal_active = false;
            state.status = ConnectionStatus::Connecting;
        }
        assert!(manager
            .update_blockers()
            .await
            .iter()
            .any(|reason| reason.contains("connecting")));
        {
            let mut state = state.write().await;
            state.status = ConnectionStatus::Connected;
            state.background_outstanding = 1;
            state.background_activity_at = Some(chrono::Utc::now() - chrono::Duration::days(365));
            assert!(!state.has_active_background_work(chrono::Utc::now()));
        }
        assert!(manager
            .update_blockers()
            .await
            .iter()
            .any(|reason| reason.contains("completion is unknown")));
    }
}
