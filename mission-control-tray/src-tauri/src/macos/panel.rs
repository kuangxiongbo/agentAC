//! 将隐藏窗口转为 NSPanel，满足 macOS 菜单栏应用事件循环（tauri-nspanel v2）

use tauri::{AppHandle, Manager};
use tauri_nspanel::{ManagerExt, WebviewWindowExt};

const SHELL_LABEL: &str = "edge-shell";

pub fn init_shell_panel(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(SHELL_LABEL)
        .ok_or_else(|| format!("未找到窗口 {SHELL_LABEL}，请检查 tauri.conf.json"))?;

    if app.get_webview_panel(SHELL_LABEL).is_ok() {
        return Ok(());
    }

    window
        .to_panel()
        .map_err(|e| format!("edge-shell 转为 NSPanel 失败: {e}"))?;

    if let Ok(panel) = app.get_webview_panel(SHELL_LABEL) {
        panel.order_out(None);
    }

    Ok(())
}
