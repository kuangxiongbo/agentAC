//! 托盘菜单动作（原生 NSStatusItem 与 Tauri 托盘共用）

use crate::setup::{open_connection_setup, open_setup_window, open_tray_config, quit_from_tray};
use crate::{bootstrap, config, open_web_console, process, runtime, show_notice, tray_update};
use config::{center_web_url, load_config};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

pub fn handle_tray_menu(app: &AppHandle, id: &str) {
    match id {
        "tray_click" => {
            let _ = open_tray_config(app);
        }
        "open_local" | "open" => open_web_console(app),
        "open_center" => {
            let cfg = load_config();
            let url = center_web_url(&cfg);
            let _ = app.opener().open_url(&url, None::<&str>);
        }
        "connection_setup" => {
            let _ = super::set_activation_policy_regular(app);
            let _ = open_connection_setup(app.clone());
        }
        "mailbox_status" => {
            let cfg = load_config();
            match crate::mailbox::fetch_status(&cfg) {
                Ok(status) => show_notice(&crate::mailbox::summarize_status(&status)),
                Err(e) => show_notice(&e),
            }
        }
        "mailbox_drain" => {
            let cfg = load_config();
            std::thread::spawn(move || match crate::mailbox::drain(&cfg) {
                Ok(result) => show_notice(&crate::mailbox::summarize_drain(&result)),
                Err(e) => show_notice(&e),
            });
        }
        "restart" => {
            let cfg = load_config();
            if !config::is_setup_complete(&cfg) {
                let _ = open_setup_window(app);
                return;
            }
            // process::restart waits for a health check (~20s) and may trigger a runtime
            // download if the install is broken — run off the main thread to avoid freezing
            // the menu bar UI.
            std::thread::spawn(move || {
                let payload = bootstrap::load_cached_bootstrap();
                match process::restart(&cfg, payload.as_ref()) {
                    Ok(()) => show_notice("边缘服务已重启"),
                    Err(e) => show_notice(&e),
                }
            });
        }
        "update" => {
            // Download/install now retries with resume (up to 5 attempts) — runs on a
            // background thread so a slow/flaky network doesn't freeze the menu bar UI.
            let app = app.clone();
            std::thread::spawn(move || {
                let cfg = load_config();
                match runtime::download_and_install(&cfg, true) {
                    Ok(msg) => {
                        let payload = bootstrap::load_cached_bootstrap();
                        let _ = process::restart(&cfg, payload.as_ref());
                        show_notice(&msg);
                    }
                    Err(e) => show_notice(&e),
                }
                let _ = app;
            });
        }
        "check_update" => {
            let app = app.clone();
            std::thread::spawn(move || {
                // Check both tray app update and runtime update in one action.
                let tray_status = tray_update::check_for_update(true);
                if tray_status.update_available {
                    let _ = open_setup_window(&app);
                    show_notice(&format!(
                        "发现托盘应用新版本 {}，请在连接窗口点击下载更新",
                        tray_status.latest_version.unwrap_or_default()
                    ));
                    return;
                }
                let cfg = load_config();
                match runtime::download_and_install(&cfg, true) {
                    Ok(msg) => {
                        let payload = bootstrap::load_cached_bootstrap();
                        let _ = process::restart(&cfg, payload.as_ref());
                        show_notice(&msg);
                    }
                    Err(e) => {
                        // Always show the download error. Mention tray-check error only as supplemental context.
                        if let Some(tray_err) = tray_status.error {
                            show_notice(&format!("{e}（托盘检查也遇到问题: {tray_err}）"));
                        } else {
                            show_notice(&e);
                        }
                    }
                }
            });
        }
        // Legacy id kept for compatibility with older native menu builds.
        "check_tray_update" => {
            let status = tray_update::check_for_update(true);
            if status.update_available {
                let _ = open_setup_window(app);
                show_notice(&format!(
                    "发现托盘应用新版本 {}，请在连接窗口点击下载更新",
                    status.latest_version.unwrap_or_default()
                ));
            } else if let Some(error) = status.error {
                show_notice(&error);
            } else {
                show_notice(&format!(
                    "托盘应用已是最新版本 {}",
                    status.current_version
                ));
            }
        }
        "uninstall" => {
            crate::uninstall::confirm_then_purge(app);
        }
        "quit" => quit_from_tray(app),
        _ => {}
    }
}
