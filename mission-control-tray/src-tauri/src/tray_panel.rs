use tauri::tray::TrayIcon;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl, WebviewWindowBuilder};

/// Menu-bar row height (logical px).
const PANEL_WIDTH: f64 = 248.0;
const PANEL_HEIGHT: f64 = 24.0;
/// Reserve space for clock / Wi‑Fi / Control Center on the right.
const SYSTEM_TRAY_RESERVE: f64 = 400.0;

/// Compact strip docked into the macOS menu bar row (status-bar window level).
pub fn open_tray_helper_window(app: &AppHandle, tray: Option<&TrayIcon>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("tray-panel") {
        position_in_menu_bar(app, &win, tray)?;
        #[cfg(target_os = "macos")]
        elevate_to_menu_bar_level(&win)?;
        win.show().map_err(|e| e.to_string())?;
        let _ = win.set_always_on_top(true);
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(
        app,
        "tray-panel",
        WebviewUrl::App("tray-panel.html".into()),
    )
    .title("E-Agent Edge")
    .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .visible_on_all_workspaces(true)
    .focused(false)
    .visible(true)
    .build()
    .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        elevate_to_menu_bar_level(&win)?;
        position_in_menu_bar(app, &win, tray)?;
        if let Some(tray) = tray {
            schedule_menu_bar_reposition(app.clone(), tray.clone());
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        position_top_right_fallback(app, &win)?;
    }

    let _ = win.show();
    eprintln!("[E-Agent Edge] 控制条已嵌入菜单栏行（屏幕最顶部右侧）");
    Ok(())
}

#[cfg(target_os = "macos")]
fn elevate_to_menu_bar_level(win: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior, NSStatusWindowLevel};

    let ptr = win.ns_window().map_err(|e| e.to_string())?;
    if ptr.is_null() {
        return Err("无法获取 NSWindow".to_string());
    }
    unsafe {
        let window: &NSWindow = &*ptr.cast();
        window.setLevel(NSStatusWindowLevel);
        window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        window.setHasShadow(false);
        window.setOpaque(false);
        window.setBackgroundColor(None);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn schedule_menu_bar_reposition(app: AppHandle, tray: TrayIcon) {
    std::thread::spawn(move || {
        for delay_ms in [400u64, 1200, 2500] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let app = app.clone();
            let tray = tray.clone();
            let _ = app.clone().run_on_main_thread(move || {
                if let Some(win) = app.get_webview_window("tray-panel") {
                    let _ = position_in_menu_bar(&app, &win, Some(&tray));
                }
            });
        }
    });
}

fn position_in_menu_bar(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
    tray: Option<&TrayIcon>,
) -> Result<(), String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "无法获取主显示器".to_string())?;
    let scale = monitor.scale_factor();
    let w = (PANEL_WIDTH * scale).round() as i32;
    let h = (PANEL_HEIGHT * scale).round() as i32;

    let (x, y) = if let Some(tray) = tray {
        if let Ok(Some(r)) = tray.rect() {
            let (rx, ry) = match r.position {
                Position::Physical(p) => (p.x as f64, p.y as f64),
                Position::Logical(p) => (p.x * scale, p.y * scale),
            };
            let rw = match r.size {
                Size::Physical(s) => s.width as f64,
                Size::Logical(s) => s.width * scale,
            };
            let top = monitor.position().y as f64;
            // Menu bar row is near the top of the display (y within ~120pt of screen top).
            if ry >= top && ry <= top + 120.0 * scale {
                let px = (rx - PANEL_WIDTH * scale + rw).round() as i32;
                let py = top as i32;
                (px, py)
            } else {
                right_menu_bar_slot(&monitor, w)
            }
        } else {
            right_menu_bar_slot(&monitor, w)
        }
    } else {
        right_menu_bar_slot(&monitor, w)
    };

    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
    Ok(())
}

/// Place in the menu bar row, left of system status icons (clock / Wi‑Fi).
fn right_menu_bar_slot(
    monitor: &tauri::Monitor,
    panel_width: i32,
) -> (i32, i32) {
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    let reserve = (SYSTEM_TRAY_RESERVE * scale).round() as i32;
    let margin = (4.0 * scale).round() as i32;
    let x = pos.x + size.width as i32 - panel_width - reserve - margin;
    let y = pos.y;
    (x, y)
}

#[cfg(not(target_os = "macos"))]
fn position_top_right_fallback(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
) -> Result<(), String> {
    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "无法获取主显示器".to_string())?;
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let w = (PANEL_WIDTH * scale).round() as i32;
    let h = (PANEL_HEIGHT * scale).round() as i32;
    let margin = (12.0 * scale).round() as i32;
    let x = work.position.x + work.size.width as i32 - w - margin;
    let y = work.position.y + margin;
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
    Ok(())
}

#[tauri::command]
pub fn hide_tray_panel(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("tray-panel") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_tray_panel(app: AppHandle) -> Result<(), String> {
    let tray = app.tray_by_id("e-agent-edge-main");
    open_tray_helper_window(&app, tray.as_ref())
}
