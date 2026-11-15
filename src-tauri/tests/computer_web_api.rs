//! 仅验证共享服务的 HTTP 状态和停止链路，不启动 helper、不枚举或操作真实窗口。

use std::sync::Arc;
use std::time::Duration;

use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::commands::computer::{computer_shared_state_core, ComputerHost, ComputerService};
use codeg_lib::computer::events::STATE_EVENT;
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use serde_json::{json, Value};

const TOKEN: &str = "computer-web-test";

async fn fixture(
    serve_computer: bool,
) -> (
    TestServer,
    Arc<AppState>,
    tempfile::TempDir,
    tempfile::TempDir,
) {
    let data = tempfile::tempdir().unwrap();
    let files = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new_for_test(
        fresh_in_memory_db().await,
        data.path().into(),
    ));
    if serve_computer {
        let service = ComputerService::start(
            ComputerHost::Server {
                broadcaster: state.event_broadcaster.clone(),
                emitter: state.emitter.clone(),
            },
            state.computer_tools_config.clone(),
        );
        assert!(state.computer_service.set(service).is_ok());
    }
    let router = build_router(
        state.clone(),
        TOKEN.into(),
        files.path().into(),
        Arc::new(ShutdownSignal::new()),
    );
    (TestServer::new(router).unwrap(), state, data, files)
}

#[tokio::test]
async fn computer_routes_require_authentication_even_when_a_service_is_shared() {
    let (server, _, _data, _files) = fixture(true).await;
    for path in [
        "/api/computer_available",
        "/api/computer_shared_state",
        "/api/computer_stop",
    ] {
        let response = server.post(path).json(&json!({})).await;
        assert_eq!(response.status_code(), 401, "{path}");
    }
}

#[tokio::test]
async fn a_server_without_a_service_keeps_computer_use_unavailable() {
    let (server, _, _data, _files) = fixture(false).await;
    let response = server
        .post("/api/computer_available")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(response.json::<Value>()["available"], false);
    let response = server
        .post("/api/computer_shared_state")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({}))
        .await;
    assert_ne!(response.status_code(), 200);
    assert!(response.json::<Value>()["message"]
        .as_str()
        .unwrap()
        .contains("computer use is not available"));
}

#[tokio::test]
async fn web_preferences_and_stop_use_the_shared_service_and_event_channel() {
    let (server, state, _data, _files) = fixture(true).await;
    let mut events = state.event_broadcaster.subscribe();
    let response = server
        .post("/api/computer_available")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(response.json::<Value>()["available"], true);

    let response = server
        .post("/api/set_computer_tools_preferences")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({ "allowForeground": false }))
        .await;
    assert_eq!(response.status_code(), 200);
    assert!(
        !state
            .computer_tools_config
            .snapshot()
            .await
            .allow_foreground
    );

    let response = server
        .post("/api/computer_stop")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(response.status_code(), 200);
    let stopped = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.channel == STATE_EVENT {
                break event;
            }
        }
    })
    .await
    .expect("Web Stop must broadcast the new shared state");
    let direct = serde_json::to_value(computer_shared_state_core(
        state.computer_service.get().unwrap(),
    ))
    .unwrap();
    assert_eq!(stopped.payload.as_ref(), &direct);

    let response = server
        .post("/api/computer_shared_state")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(response.json::<Value>(), direct);
}

#[cfg(windows)]
mod live {
    use super::*;
    use codeg_lib::acp::computer_tools::{ComputerToolAccess, SnapshotRequest};
    use codeg_lib::commands::computer::{computer_driver_install_core, McpComputerTools};
    use codeg_lib::computer::types::{ActDelivery, ComputerActRequest, ElementTarget};
    use std::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn GetThreadDesktop(thread: u32) -> *mut c_void;
        fn GetUserObjectInformationW(
            object: *mut c_void,
            index: i32,
            buffer: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
    }

    // 真实窗口验收只允许在专属后台桌面执行，误从日常桌面启动时在启动 helper 前拒绝。
    fn require_isolated_desktop() {
        let mut name = [0u16; 128];
        let mut needed = 0;
        let read = unsafe {
            GetUserObjectInformationW(
                GetThreadDesktop(GetCurrentThreadId()),
                2,
                name.as_mut_ptr().cast(),
                std::mem::size_of_val(&name) as u32,
                &mut needed,
            )
        };
        assert_ne!(read, 0);
        let end = name.iter().position(|unit| *unit == 0).unwrap();
        assert_eq!(
            String::from_utf16_lossy(&name[..end]),
            "CodegComputerProof20261115"
        );
    }

    #[tokio::test]
    #[ignore = "requires the isolated native-window acceptance fixture"]
    async fn web_grants_real_window_actions_and_stop_share_one_service() {
        require_isolated_desktop();
        let fixture_pid: u64 = std::env::var("CODEG_COMPUTER_LIVE_PID")
            .expect("isolated fixture pid")
            .parse()
            .unwrap();
        let (server, state, _data, _files) = fixture(true).await;
        let post = |path: &str, body: Value| {
            server
                .post(path)
                .add_header("authorization", format!("Bearer {TOKEN}"))
                .json(&body)
        };
        post(
            "/api/set_computer_tools_preferences",
            json!({"allowForeground": false}),
        )
        .await
        .assert_status_ok();
        post("/api/set_computer_tools_enabled", json!({"enabled": true}))
            .await
            .assert_status_ok();
        let service = state.computer_service.get().unwrap();
        computer_driver_install_core(service).await.unwrap();
        let tools = McpComputerTools::new(service.clone());
        let response = post("/api/computer_list_shareable_windows", json!({})).await;
        response.assert_status_ok();
        let windows = response.json::<Value>();
        let window = windows
            .as_array()
            .unwrap()
            .iter()
            .find(|window| {
                window["pid"].as_u64() == Some(fixture_pid)
                    && window["title"] == "Codeg computer acceptance fixture"
            })
            .expect("the isolated native fixture must be listed");
        let target = window["targetId"].as_str().unwrap();
        assert!(
            window.get("notGrantable").is_none_or(Value::is_null),
            "{window}"
        );
        let refused = tools.snapshot(target, SnapshotRequest::default()).await;
        assert_eq!(refused.error.as_deref(), Some("computer_grant_required"));

        post(
            "/api/computer_share_window",
            json!({"targetId": target, "level": "read"}),
        )
        .await
        .assert_status_ok();
        let snapshot = tools.snapshot(target, SnapshotRequest::default()).await;
        let snapshot = snapshot
            .snapshot
            .as_ref()
            .unwrap_or_else(|| panic!("{snapshot:?}"));
        println!("ISOLATED_SNAPSHOT {}", snapshot.tree);
        let line = snapshot
            .tree
            .lines()
            .find(|line| line.contains("codeg-proof-edit"))
            .expect("the native text field must be in the accessibility snapshot");
        let index = line
            .split_once('[')
            .unwrap()
            .1
            .split_once(']')
            .unwrap()
            .0
            .parse()
            .unwrap();
        let request = ComputerActRequest::SetValue {
            target: ElementTarget {
                generation: snapshot.generation.clone(),
                index,
            },
            value: "Codeg Web computer round43".into(),
        };
        let refused = tools
            .act(target, request.clone(), Some(ActDelivery::Background))
            .await;
        assert_eq!(refused.error.as_deref(), Some("computer_control_required"));

        post(
            "/api/computer_share_window",
            json!({"targetId": target, "level": "control"}),
        )
        .await
        .assert_status_ok();
        let snapshot = tools.snapshot(target, SnapshotRequest::default()).await;
        let snapshot = snapshot
            .snapshot
            .as_ref()
            .unwrap_or_else(|| panic!("{snapshot:?}"));
        let line = snapshot
            .tree
            .lines()
            .find(|line| line.contains("codeg-proof-edit"))
            .unwrap();
        let index = line
            .split_once('[')
            .unwrap()
            .1
            .split_once(']')
            .unwrap()
            .0
            .parse()
            .unwrap();
        let request = ComputerActRequest::SetValue {
            target: ElementTarget {
                generation: snapshot.generation.clone(),
                index,
            },
            value: "Codeg Web computer round43".into(),
        };
        let acted = tools
            .act(target, request.clone(), Some(ActDelivery::Background))
            .await;
        assert!(acted.error.is_none(), "{acted:?}");
        let snapshot = tools.snapshot(target, SnapshotRequest::default()).await;
        assert!(
            snapshot
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| { snapshot.tree.contains("Codeg Web computer round43") }),
            "{snapshot:?}"
        );

        let mut events = state.event_broadcaster.subscribe();
        post("/api/computer_stop", json!({}))
            .await
            .assert_status_ok();
        let event = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.channel == STATE_EVENT {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        let direct = serde_json::to_value(computer_shared_state_core(service)).unwrap();
        assert_eq!(event.payload.as_ref(), &direct);
        assert_eq!(direct["shared"], json!([]));
        let stopped = tools
            .act(target, request, Some(ActDelivery::Background))
            .await;
        assert!(stopped.error.is_some(), "Stop must revoke the real target");
        println!("COMPUTER_LIVE_WEB_PROOF_PASSED");
    }
}
