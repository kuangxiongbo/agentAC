//! 卸载辅助：停止本机服务并清理 ~/.e-agent-edge/ 数据目录。
//!
//! 卸载流程（仅清理托盘管理的内容）：
//!   1. 停止 Node 进程
//!   2. 停止 caffeinate
//!   3. 删除 ~/.e-agent-edge/（runtime、data、logs、config）
//!   4. 退出托盘应用
//!
//! 用户仍需手动将 E-Agent Edge.app 拖入废纸篓完成 .app 本体的删除。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

static UNINSTALL_CONFIRMED: AtomicBool = AtomicBool::new(false);
// Set to true as soon as purge_and_quit begins; prevents the reset timer from
// clearing UNINSTALL_CONFIRMED after a second click already triggered purge.
static PURGE_EXECUTED: AtomicBool = AtomicBool::new(false);

/// 清理托盘管理的所有运行时数据，并退出进程。
/// 调用前应确认用户已确认（UI 层负责确认）。
pub fn purge_and_quit(app: &AppHandle) {
    PURGE_EXECUTED.store(true, Ordering::SeqCst);

    // 停止 Node 进程
    if let Err(e) = crate::process::stop() {
        eprintln!("[E-Agent Edge] 卸载: 停止 Node 进程失败: {e}");
    }

    // 停止 caffeinate
    crate::keep_awake::stop_system_keep_awake();

    // 删除数据目录
    let home = crate::config::edge_home();
    if home.exists() {
        match std::fs::remove_dir_all(&home) {
            Ok(()) => eprintln!("[E-Agent Edge] 卸载: 已删除 {}", home.display()),
            Err(e) => eprintln!("[E-Agent Edge] 卸载: 删除数据目录失败: {e}"),
        }
    } else {
        eprintln!("[E-Agent Edge] 卸载: 数据目录不存在，跳过删除");
    }

    // 标记为正常退出（避免触发 ExitRequested 里的 prevent_exit）
    crate::setup::mark_intentional_quit();

    eprintln!("[E-Agent Edge] 卸载完成。请将 E-Agent Edge.app 拖入废纸篓删除应用本体。");
    app.exit(0);
}

/// 两步确认：第一次调用记录"待确认"状态，返回 false；第二次调用才真正执行。
/// 用于菜单一次点击显示提示，再次点击执行的 UX 模式。
pub fn confirm_then_purge(app: &AppHandle) -> bool {
    let already_confirmed = UNINSTALL_CONFIRMED.swap(true, Ordering::SeqCst);
    if !already_confirmed {
        // 第一次：仅提示，不执行
        crate::show_notice(
            "再次点击「卸载并清除数据」以确认。\
             此操作将停止本机 Web 服务并删除 ~/.e-agent-edge/ 目录（配置、数据库、缓存均会被清除）。\
             应用本体请手动拖入废纸篓。",
        );
        // 10 秒内不再次点击则重置确认状态（仅在 purge 尚未执行时重置）
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(10));
            if !PURGE_EXECUTED.load(Ordering::SeqCst) {
                UNINSTALL_CONFIRMED.store(false, Ordering::SeqCst);
            }
        });
        return false;
    }
    purge_and_quit(app);
    true
}

/// Tauri 命令：直接执行清理（供已弹窗确认的前端页面调用）。
/// 必须传入 confirmed=true，否则返回错误，防止意外 IPC 调用直接删除数据。
#[tauri::command]
pub fn uninstall_edge(app: AppHandle, confirmed: bool) -> Result<(), String> {
    if !confirmed {
        return Err("卸载需要明确确认（confirmed=true）".to_string());
    }
    purge_and_quit(&app);
    Ok(())
}
