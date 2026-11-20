//! What the frontend is told about computer use.
//!
//! 桌面和通过认证的 Web 客户端操作同一个 computer service，因此授权、
//! 活动、驱动状态与停止状态也必须同步。独立 codeg-server 仍只在运行者
//! 通过 `CODEG_COMPUTER_USE` 开启后提供这些能力。

use std::sync::Arc;

use serde::Serialize;

use super::agent::{
    ComputerActivityPayload, ComputerGrantPayload, AGENT_ACTIVITY_EVENT, AGENT_GRANT_EVENT,
};
use super::backend::BackendStatus;
use super::driver_admin::DriverInfo;
use super::stop_shortcut::StopKeyStatus;
use super::targets::{SharedApp, SharedScreen, SharedWindow};
use crate::web::event_bridge::WebEventBroadcaster;

/// Every window with a grant in force — the source of truth for the panel.
pub const STATE_EVENT: &str = "computer://state";

/// The helper's state, for the panel's status line.
pub const BACKEND_STATUS_EVENT: &str = "computer://backend-status";

/// Whether the stop shortcut is in force, for every place that offers Stop.
pub const STOP_KEY_EVENT: &str = "computer://stop-key";

/// The driver as Settings shows it, whenever it changes or an install moves.
pub const DRIVER_EVENT: &str = "computer://driver";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatePayload<'a> {
    shared: &'a [SharedWindow],
    apps: &'a [SharedApp],
    #[serde(skip_serializing_if = "Option::is_none")]
    screen: Option<&'a SharedScreen>,
}

/// Where computer use tells what changed.
#[derive(Clone)]
pub enum ComputerEvents {
    /// 桌面 webview 和同一进程内置 Web 服务的已认证客户端。
    #[cfg(feature = "tauri-runtime")]
    Desktop(tauri::AppHandle),
    /// codeg-server's web clients: the only panel there is in server mode.
    Web(Arc<WebEventBroadcaster>),
}

impl ComputerEvents {
    fn send<T: Serialize>(&self, channel: &str, payload: &T) {
        match self {
            #[cfg(feature = "tauri-runtime")]
            Self::Desktop(app) => {
                // 与共享实例配套广播；否则另一端只能看到过期授权，无法确认停止。
                crate::web::event_bridge::emit_event(
                    &crate::web::event_bridge::EventEmitter::from_app(app),
                    channel,
                    payload,
                );
            }
            Self::Web(broadcaster) => {
                let _ = broadcaster.send(channel, payload);
            }
        }
    }

    pub fn state(
        &self,
        shared: &[SharedWindow],
        apps: &[SharedApp],
        screen: Option<&SharedScreen>,
    ) {
        self.send(
            STATE_EVENT,
            &StatePayload {
                shared,
                apps,
                screen,
            },
        );
    }

    pub fn grant(&self, payload: &ComputerGrantPayload) {
        self.send(AGENT_GRANT_EVENT, payload);
    }

    pub fn activity(&self, payload: &ComputerActivityPayload) {
        self.send(AGENT_ACTIVITY_EVENT, payload);
    }

    pub fn backend_status(&self, status: &BackendStatus) {
        self.send(BACKEND_STATUS_EVENT, status);
    }

    pub fn stop_key(&self, status: &StopKeyStatus) {
        self.send(STOP_KEY_EVENT, status);
    }

    pub fn driver(&self, info: &DriverInfo) {
        self.send(DRIVER_EVENT, info);
    }
}
