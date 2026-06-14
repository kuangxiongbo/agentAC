mod bootstrap;
mod config;
mod http_client;
mod keep_awake;
mod node_path;
mod process;
mod runtime;
mod setup;
mod supervisor;
mod tray_update;
mod tray_panel;
mod uninstall;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod macos_launch;

use config::{load_config, console_url};
use setup::{hide_to_background, is_intentional_quit, open_setup_window, open_tray_config, quit_from_tray, run_if_configured};
use tauri::{Manager, RunEvent};
#[cfg(not(target_os = "macos"))]
use tauri::tray::{TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "macos")]
use tray_panel::open_tray_helper_window;

#[cfg(target_os = "macos")]
#[allow(dead_code)]
struct AppTray(tauri::tray::TrayIcon);

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
struct AppTray(tauri::tray::TrayIcon);

#[cfg(not(target_os = "macos"))]
const TRAY_ICON: tauri::image::Image<'static> = include_image!("icons/tray-icon.png");

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "macos")]
static TRAY_CREATED: AtomicBool = AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(target_os = "macos")]
    {
        if std::env::var("MC_EDGE_NSPANEL").ok().as_deref().map(str::trim) == Some("1") {
            builder = builder.plugin(tauri_nspanel::init());
        }
        builder = builder.on_menu_event(|app, event| {
            macos::handle_tray_menu(app, event.id().as_ref());
        });
    }

    builder
        .invoke_handler(tauri::generate_handler![
            setup::get_setup_status,
            setup::get_saved_setup,
            setup::submit_setup,
            setup::open_console,
            setup::close_setup_window,
            setup::open_connection_setup,
            setup::open_tray_config_cmd,
            tray_update::get_tray_update_status,
            tray_update::check_tray_update,
            tray_update::open_tray_update_download,
            tray_panel::hide_tray_panel,
            tray_panel::show_tray_panel,
            uninstall::uninstall_edge,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            keep_awake::start_system_keep_awake();

            #[cfg(target_os = "macos")]
            macos::setup(&app_handle)?;

            #[cfg(not(target_os = "macos"))]
            {
                let tray = create_tray_icon(app)?;
                app.manage(AppTray(tray));
            }

            let cfg = load_config();
            if config::is_setup_complete(&cfg) {
                run_if_configured(&app_handle, false);
            } else {
                let _ = open_setup_window(&app_handle);
            }
            tray_update::start_background_check(app_handle.clone());
            supervisor::start_background_supervisor();

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match &event {
                #[cfg(target_os = "macos")]
                RunEvent::Ready | RunEvent::Resumed => {
                    let handle = app.clone();
                    let delayed = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        init_macos_tray(&handle);
                    });
                    macos::schedule_delayed_tray_install(delayed);
                    if matches!(&event, RunEvent::Resumed) {
                        supervisor::recover_after_resume();
                    }
                }
                RunEvent::Reopen { .. } => {
                    let _ = open_tray_config(app);
                }
                RunEvent::ExitRequested { api, .. } => {
                    if is_intentional_quit() {
                        return;
                    }
                    // Dock ⌘Q / 退出请求：等同关窗，不停止 5101
                    api.prevent_exit();
                    hide_to_background(app);
                }
                _ => {}
            }
            #[cfg(not(target_os = "macos"))]
            if let RunEvent::Ready = event {
                eprintln!("[E-Agent Edge] 应用已就绪");
            }
        });
}

#[cfg(target_os = "macos")]
fn init_macos_tray(app: &tauri::AppHandle) {
    let first = !TRAY_CREATED.swap(true, Ordering::SeqCst);
    if !first {
        macos::refresh_tray_visible(app);
        return;
    }

    macos::activate_app();

    let diag = macos::diag_path().display().to_string();

    match macos::tray_backend() {
        macos::TrayBackend::Tauri => match macos::install_clash_tray(app) {
            Ok(tray) => {
                app.manage(AppTray(tray));
                macos::log_tray(&format!("Tauri/Clash 托盘；诊断: {diag}"));
            }
            Err(e) => macos::log_tray(&format!("Tauri 托盘失败: {e}")),
        },
        macos::TrayBackend::Native => match macos::install_native_tray() {
            Ok(_) => {
                macos::schedule_native_tray_retries(app.clone());
                macos::log_tray(&format!("objc2 原生菜单栏；诊断: {diag}"));
            }
            Err(e) => macos::log_tray(&format!("objc2 原生安装失败: {e}")),
        },
        macos::TrayBackend::Objc => match macos::install_objc_tray(app) {
            Ok(_) => {
                macos::schedule_objc_tray_retries();
                macos::log_tray(&format!("Cocoa 菜单栏图标（默认）；诊断: {diag}"));
            }
            Err(e) => macos::log_tray(&format!("Cocoa 菜单栏安装失败: {e}")),
        },
    }

    apply_macos_tray_fallback(app);

    warn_if_not_app_bundle();
}

#[cfg(target_os = "macos")]
fn warn_if_not_app_bundle() {
    let exe = std::env::current_exe().ok();
    let in_bundle = exe
        .as_ref()
        .is_some_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"));
    if in_bundle {
        return;
    }
    macos::log_tray(
        "当前为裸二进制启动（Dock 会显示 exec，菜单栏常无图标）。请用: pnpm tauri build && open bundle/macos/E-Agent\\ Edge.app",
    );
}

#[cfg(target_os = "macos")]
fn apply_macos_tray_fallback(app: &tauri::AppHandle) {
    eprintln!("[E-Agent Edge] {}", macos_launch::launch_mode_hint());

    if macos_launch::should_show_top_helper() {
        let tray = app.tray_by_id("e-agent-edge-main");
        if let Err(e) = open_tray_helper_window(app, tray.as_ref()) {
            eprintln!("[E-Agent Edge] 顶部快捷条: {e}");
        } else {
            eprintln!("[E-Agent Edge] 已显示顶部快捷条（菜单栏备用入口）");
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn create_tray_icon(app: &tauri::App) -> Result<TrayIcon, String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let open_local_i = MenuItem::with_id(app, "open_local", "打开控制台", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let connection_i = MenuItem::with_id(
        app,
        "connection_setup",
        "连接设置…",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let uninstall_i =
        MenuItem::with_id(app, "uninstall", "卸载并清除数据…", true, None::<&str>)
            .map_err(|e| e.to_string())?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(
        app,
        &[
            &open_local_i,
            &connection_i,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &uninstall_i,
            &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
            &quit_i,
        ],
    )
    .map_err(|e| e.to_string())?;

    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};

    let tray = TrayIconBuilder::with_id("e-agent-edge-main")
        .icon(TRAY_ICON.clone())
        .menu(&menu)
        .tooltip("E-Agent Edge — 点击打开连接配置")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open_local" => open_web_console(app),
            "connection_setup" => {
                let _ = setup::open_connection_setup(app.clone());
            }
            "uninstall" => {
                crate::uninstall::confirm_then_purge(app);
            }
            "quit" => quit_from_tray(app),
            _ => {}
        })
        .build(app)
        .map_err(|e| format!("创建托盘失败: {e}"))?;

    tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            let app = tray.app_handle();
            let cfg = load_config();
            if config::is_setup_complete(&cfg) {
                open_web_console(app);
            } else {
                let _ = open_tray_config(app);
            }
        }
    });

    Ok(tray)
}

pub(crate) fn open_web_console(app: &tauri::AppHandle) {
    let cfg = load_config();
    if !config::is_setup_complete(&cfg) {
        let _ = open_setup_window(app);
        return;
    }
    let url = console_url(&cfg);
    match app.opener().open_url(&url, None::<&str>) {
        Ok(()) => {}
        Err(e) => show_notice(&format!("无法打开浏览器: {e}")),
    }
}

pub(crate) fn show_notice(message: &str) {
    log::info!(target: "edge_tray", "{message}");
    eprintln!("[E-Agent Edge] {message}");
}
