//! macOS launch context: app bundle vs bare binary (`tauri dev`).

use std::process::{Command, Stdio};

const LEGACY_RUNTIME_LABEL: &str = "work.1sheng.e-agent-edge.runtime";

/// Tray 3.x owns the Node lifecycle. Remove the legacy KeepAlive LaunchAgent so
/// it cannot continuously race the tray-managed process for port 5101.
pub fn disable_legacy_runtime_launch_agent() {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let plist = home
        .join("Library/LaunchAgents")
        .join(format!("{LEGACY_RUNTIME_LABEL}.plist"));
    let stale_pid = home.join(".e-agent-edge/runtime-node.pid");
    if !plist.exists() {
        let _ = std::fs::remove_file(stale_pid);
        return;
    }

    let uid = Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|uid| uid.trim().to_string())
        .filter(|uid| !uid.is_empty());

    if let Some(uid) = uid {
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("gui/{uid}"), plist.to_string_lossy().as_ref()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = Command::new("launchctl")
        .args(["remove", LEGACY_RUNTIME_LABEL])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = Command::new("launchctl")
        .args(["unload", plist.to_string_lossy().as_ref()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    if std::fs::remove_file(&plist).is_ok() {
        eprintln!("[E-Agent Edge] 已移除旧版 Runtime LaunchAgent，由托盘统一管理 5101");
    }
    let _ = std::fs::remove_file(stale_pid);
}

/// True when launched as `*.app/Contents/MacOS/...` (e.g. after `tauri build` + Finder open).
pub fn running_inside_app_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .is_some_and(|p| {
            let s = p.to_string_lossy();
            s.contains(".app/Contents/MacOS/")
        })
}

/// 顶部 WebView 快捷条：默认关闭（攻关右侧小图标时避免遮挡）；`MC_EDGE_TOP_HELPER=1` 开启。
pub fn should_show_top_helper() -> bool {
    matches!(
        std::env::var("MC_EDGE_TOP_HELPER")
            .ok()
            .as_deref()
            .map(str::trim),
        Some("1") | Some("true") | Some("yes")
    )
}

pub fn launch_mode_hint() -> &'static str {
    if running_inside_app_bundle() {
        "已打包 .app 启动"
    } else {
        "开发/裸二进制启动（菜单栏图标建议 tauri build 后 open .app）"
    }
}
