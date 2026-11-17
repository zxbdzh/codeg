use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::app_error::AppCommandError;
use crate::models::AgentType;

type Key = (usize, AgentType, String);
type Gates = HashMap<Key, Weak<RwLock<()>>>;

fn gate(manager: &ConnectionManager, agent: AgentType, session: &str) -> Arc<RwLock<()>> {
    static GATES: OnceLock<Mutex<Gates>> = OnceLock::new();
    let mut gates = GATES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if gates.len() > 1024 {
        gates.retain(|_, value| value.strong_count() > 0);
    }
    let key = (
        Arc::as_ptr(&manager.connections) as usize,
        agent,
        session.to_owned(),
    );
    if let Some(existing) = gates.get(&key).and_then(Weak::upgrade) {
        return existing;
    }
    let created = Arc::new(RwLock::new(()));
    gates.insert(key, Arc::downgrade(&created));
    created
}

pub(crate) fn begin(
    manager: &ConnectionManager,
    agent: AgentType,
    session: &str,
) -> Result<OwnedRwLockWriteGuard<()>, AppCommandError> {
    gate(manager, agent, session)
        .try_write_owned()
        .map_err(|_| {
            AppCommandError::invalid_input("This session has another history operation in progress")
        })
}

pub(crate) fn allow_send(
    manager: &ConnectionManager,
    agent: AgentType,
    session: &str,
) -> Result<OwnedRwLockReadGuard<()>, AcpError> {
    gate(manager, agent, session).try_read_owned().map_err(|_| {
        // 独立于 TurnInProgress：客户端须交还草稿，不能自动排队重发到撤回后的上下文。
        AcpError::protocol("conversation history is being changed; keep this draft and send again after completion")
    })
}

pub(crate) async fn allow_connection_send(
    manager: &ConnectionManager,
    connection_id: &str,
) -> Result<Option<OwnedRwLockReadGuard<()>>, AcpError> {
    let state = manager
        .get_state(connection_id)
        .await
        .ok_or_else(|| AcpError::ConnectionNotFound(connection_id.to_owned()))?;
    let state = state.read().await;
    state
        .external_id
        .as_deref()
        .map(|session| allow_send(manager, state.agent_type, session))
        .transpose()
}

pub(crate) fn backup(
    manager: &ConnectionManager,
    conversation_id: i32,
) -> Result<OwnedRwLockWriteGuard<()>, AppCommandError> {
    // 使用独立键空间，自动清理无需读取数据库或加载整段原始历史。
    begin(
        manager,
        AgentType::Custom("undo-backup"),
        &conversation_id.to_string(),
    )
}
