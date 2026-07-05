//! macOS 菜单栏：默认纯原生 NSStatusItem（`native_tray`），可选 Tauri 托盘回退

mod activate;
mod diag;
mod menu_bar_visible;
mod native_tray;
mod objc_tray;
mod panel;
mod tray;

pub use activate::activate_app;
pub use diag::{diag_path, log_tray};

use muda::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{ActivationPolicy, AppHandle, Wry};

pub use native_tray::{
    install as install_native_tray, schedule_visible_retries as schedule_native_tray_retries,
    NativeMenuBarTray,
};
pub use objc_tray::{
    install as install_objc_tray, schedule_visible_retries as schedule_objc_tray_retries,
    ObjcMenuBarTray,
};
pub use tray::handle_tray_menu;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayBackend {
    /// 纯 Cocoa（默认，无 tray-icon TrayTarget）
    Objc,
    /// Clash 同款 Tauri TrayIconBuilder + template .ico
    Tauri,
    /// Rust objc2 NSStatusItem
    Native,
}

/// 默认 Tauri/Clash 路径：本机已证实 Clash 猫头可见，Cocoa 路径 API visible=1 但仍不可见。
pub fn tray_backend() -> TrayBackend {
    if use_cocoa_tray() {
        TrayBackend::Objc
    } else if use_native_tray() {
        TrayBackend::Native
    } else {
        TrayBackend::Tauri
    }
}

/// 布局稳定后再装一次（避免 install 时 screen.y 为负、在屏外）
pub fn schedule_delayed_tray_install(app: AppHandle) {
    std::thread::spawn(move || {
        for delay_ms in [600u64, 1800] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let app = app.clone();
            let runner = app.clone();
            let _ = runner.run_on_main_thread(move || {
                refresh_tray_visible(&app);
            });
        }
    });
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    app.set_activation_policy(ActivationPolicy::Regular)
        .map_err(|e| format!("设置 Regular 激活策略失败: {e}"))?;

    if std::env::var("MC_EDGE_NSPANEL")
        .ok()
        .as_deref()
        .map(str::trim)
        == Some("1")
    {
        panel::init_shell_panel(app)?;
        eprintln!("[E-Agent Edge] macOS：已启用 NSPanel（MC_EDGE_NSPANEL=1）");
    }

    eprintln!(
        "[E-Agent Edge] macOS：菜单栏后端 {:?}（默认 Tauri/Clash；MC_EDGE_COCOA_TRAY=1 / MC_EDGE_NATIVE_TRAY=1 可切换）",
        tray_backend()
    );
    Ok(())
}

pub fn set_activation_policy_regular(app: &AppHandle) -> Result<(), String> {
    app.set_activation_policy(ActivationPolicy::Regular)
        .map_err(|e| format!("{e}"))
}

pub fn set_activation_policy_accessory(app: &AppHandle) -> Result<(), String> {
    app.set_activation_policy(ActivationPolicy::Accessory)
        .map_err(|e| format!("{e}"))
}

pub fn build_muda_tray_menu() -> Result<Menu, String> {
    let open_local = MenuItem::with_id("open_local", "打开控制台", true, None);
    let open_center = MenuItem::with_id("open_center", "打开服务中心", true, None);
    let connection = MenuItem::with_id("connection_setup", "连接设置…", true, None);
    let mailbox_status = MenuItem::with_id("mailbox_status", "消息队列状态…", true, None);
    let mailbox_drain = MenuItem::with_id("mailbox_drain", "立即处理消息队列", true, None);
    let restart = MenuItem::with_id("restart", "重启服务", true, None);
    let check_update = MenuItem::with_id("check_update", "检查更新…", true, None);
    let uninstall = MenuItem::with_id("uninstall", "卸载并清除数据…", true, None);
    let quit = MenuItem::with_id("quit", "退出", true, None);
    let sep1 = PredefinedMenuItem::separator();
    let sep2 = PredefinedMenuItem::separator();
    let sep3 = PredefinedMenuItem::separator();
    let sep4 = PredefinedMenuItem::separator();

    Menu::with_items(&[
        &open_local,
        &open_center,
        &connection,
        &sep1,
        &mailbox_status,
        &mailbox_drain,
        &sep2,
        &restart,
        &check_update,
        &sep3,
        &uninstall,
        &sep4,
        &quit,
    ])
    .map_err(|e| e.to_string())
}

pub fn build_tray_menu(app: &AppHandle) -> Result<tauri::menu::Menu<Wry>, String> {
    use tauri::menu::{MenuItem, PredefinedMenuItem};

    let open_local_i = MenuItem::with_id(app, "open_local", "打开控制台", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let open_center_i =
        MenuItem::with_id(app, "open_center", "打开服务中心", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    let connection_i =
        MenuItem::with_id(app, "connection_setup", "连接设置…", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    let mailbox_status_i =
        MenuItem::with_id(app, "mailbox_status", "消息队列状态…", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    let mailbox_drain_i =
        MenuItem::with_id(app, "mailbox_drain", "立即处理消息队列", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    let restart_i = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let check_update_i =
        MenuItem::with_id(app, "check_update", "检查更新…", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    let uninstall_i =
        MenuItem::with_id(app, "uninstall", "卸载并清除数据…", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    tauri::menu::Menu::with_items(
        app,
        &[
            &open_local_i,
            &open_center_i,
            &connection_i,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &mailbox_status_i,
            &mailbox_drain_i,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &restart_i,
            &check_update_i,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &uninstall_i,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &quit_i,
        ],
    )
    .map_err(|e| e.to_string())
}

/// 默认路径：与 Clash Verge 相同（mono .ico + template，无 title）
pub fn install_clash_tray(app: &AppHandle) -> Result<tauri::tray::TrayIcon, String> {
    use crate::setup::open_tray_config;
    use crate::open_web_console;
    use tauri::image::Image;
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    activate_app();

    // 与 Dock/应用图标同源（public/brand/app-logo.png → tray-icon@2x.png）
    const TRAY_ICON_BRAND: &[u8] = include_bytes!("../../icons/tray-icon@2x.png");
    let menu = build_tray_menu(app)?;
    let icon = Image::from_bytes(TRAY_ICON_BRAND).map_err(|e| e.to_string())?;
    let use_template = std::env::var("MC_EDGE_TRAY_TEMPLATE")
        .ok()
        .as_deref()
        .map(str::trim)
        == Some("1");

    let tray = TrayIconBuilder::with_id("e-agent-edge-main")
        .icon(icon)
        .icon_as_template(use_template)
        .menu(&menu)
        .tooltip("E-Agent Edge — 点击打开连接配置")
        .show_menu_on_left_click(false)
        .build(app)
        .map_err(|e| format!("Clash 模式托盘创建失败: {e}"))?;

    tray.on_menu_event(|app, event| handle_tray_menu(app, event.id().as_ref()));
    tray.on_tray_icon_event(|tray, event| {
        let app = tray.app_handle();
        match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                // If configured, open the console directly (primary action).
                // Fall back to setup window only when not yet configured.
                let cfg = crate::config::load_config();
                if crate::config::is_setup_complete(&cfg) {
                    open_web_console(app);
                } else {
                    let _ = open_tray_config(app);
                }
            }
            _ => {}
        }
    });

    menu_bar_visible::ensure_visible(&tray)?;
    menu_bar_visible::schedule_retries(app, &tray);
    log_tray_state(app, &tray);
    Ok(tray)
}

pub fn ensure_tray_visible(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("e-agent-edge-main") {
        let _ = menu_bar_visible::ensure_visible(&tray);
        log_tray_state(app, &tray);
    }
}

pub fn refresh_tray_visible(app: &AppHandle) {
    ensure_tray_visible(app);
    match tray_backend() {
        TrayBackend::Objc => {
            objc_tray::refresh_visible();
        }
        TrayBackend::Native => {
            native_tray::refresh_on_main_thread_public();
        }
        TrayBackend::Tauri => {}
    }
}

fn log_tray_state(_app: &AppHandle, tray: &tauri::tray::TrayIcon) {
    use tauri::{PhysicalPosition, Position};

    let bundle = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let rect = tray
        .rect()
        .map(|r| format!("{r:?}"))
        .unwrap_or_else(|e| format!("err:{e}"));
    let placement = tray
        .rect()
        .ok()
        .flatten()
        .map(|r| match r.position {
            Position::Physical(PhysicalPosition { x, y, .. }) => {
                if y <= 80 {
                    format!("菜单栏区(物理 y={y} x={x})")
                } else {
                    format!("疑似错位(物理 y={y} x={x})")
                }
            }
            _ => "未知坐标".into(),
        })
        .unwrap_or_default();
    let inner_visible = tray
        .with_inner_tray_icon(|inner| {
            inner
                .ns_status_item()
                .map(|item| item.isVisible())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    log_tray(&format!(
        "托盘诊断 exe={bundle} rect={rect} ns_isVisible={inner_visible} {placement}"
    ));
}

/// 强制纯 Cocoa 托盘（`MC_EDGE_COCOA_TRAY=1` 或 `MC_EDGE_OBJC_TRAY=1`）
pub fn use_cocoa_tray() -> bool {
    matches!(
        std::env::var("MC_EDGE_COCOA_TRAY")
            .or_else(|_| std::env::var("MC_EDGE_OBJC_TRAY"))
            .ok()
            .as_deref()
            .map(str::trim),
        Some("1")
    )
}


/// Rust objc2 原生项（`MC_EDGE_NATIVE_TRAY=1`）
pub fn use_native_tray() -> bool {
    std::env::var("MC_EDGE_NATIVE_TRAY")
        .ok()
        .as_deref()
        .map(str::trim)
        == Some("1")
}
