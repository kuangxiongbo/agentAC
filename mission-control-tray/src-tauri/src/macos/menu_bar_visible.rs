//! 强制 macOS 菜单栏托盘可见（Tauri/tray-icon：需 `setVisible(true)`；TrayTarget 移除仅调试开启）

use std::ffi::CStr;
use std::time::Duration;
use tauri::tray::TrayIcon;
use tauri::{AppHandle, PhysicalPosition, Position, Runtime};

pub fn should_skip_fix() -> bool {
    matches!(
        std::env::var("MC_EDGE_TRAY_FIX")
            .ok()
            .as_deref()
            .map(str::trim),
        Some("0") | Some("false") | Some("no")
    )
}

fn should_remove_tray_target<R: Runtime>(tray: &TrayIcon<R>) -> bool {
    if std::env::var("MC_EDGE_TRAY_FIX")
        .ok()
        .as_deref()
        .map(str::trim)
        == Some("0")
    {
        return false;
    }
    if std::env::var("MC_EDGE_TRAY_FIX")
        .ok()
        .as_deref()
        .map(str::trim)
        == Some("1")
    {
        return true;
    }
    // 物理坐标 y≈1912 为屏底（Retina 956×2），菜单栏应在 y≈0；错位时移除 TrayTarget
    match tray.rect().ok().flatten() {
        Some(r) => match r.position {
            Position::Physical(PhysicalPosition { y, .. }) => y > 120,
            _ => true,
        },
        None => true,
    }
}

fn should_show_title() -> bool {
    std::env::var("MC_EDGE_TRAY_TITLE")
        .ok()
        .as_deref()
        .map(str::trim)
        == Some("1")
}

pub fn ensure_visible<R: Runtime>(tray: &TrayIcon<R>) -> Result<(), String> {
    if should_skip_fix() {
        return Ok(());
    }
    let remove_target = should_remove_tray_target(tray);
    tray.with_inner_tray_icon(move |inner| apply_fix(inner, remove_target))
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn schedule_retries<R: Runtime>(app: &AppHandle<R>, tray: &TrayIcon<R>) {
    if should_skip_fix() {
        return;
    }
    let app = app.clone();
    let tray = tray.clone();
    std::thread::spawn(move || {
        for delay_ms in [100u64, 400, 1000, 2500, 5000] {
            std::thread::sleep(Duration::from_millis(delay_ms));
            let app = app.clone();
            let tray = tray.clone();
            let _ = app.run_on_main_thread(move || {
                if let Err(e) = ensure_visible(&tray) {
                    eprintln!("[E-Agent Edge] 菜单栏可见性重试失败: {e}");
                }
            });
        }
    });
}

fn apply_fix(inner: &tray_icon::TrayIcon, remove_tray_target: bool) -> Result<(), String> {
    use objc2_app_kit::NSCellImagePosition;
    use objc2_foundation::{MainThreadMarker, NSString};

    let mtm = MainThreadMarker::new().ok_or("NSStatusItem 需要主线程")?;
    let status_item = inner.ns_status_item().ok_or("无法获取 NSStatusItem")?;
    let button = status_item.button(mtm).ok_or("无法获取 NSStatusBarButton")?;

    unsafe {
        status_item.setVisible(true);
    }

    let mut removed = 0usize;
    if remove_tray_target {
        for subview in button.subviews().iter() {
            let class_name = subview.class().name();
            let name = unsafe { CStr::from_ptr(class_name.as_ptr()) };
            let label = name.to_string_lossy();
            if label.contains("TrayTarget") || label.contains("TaoTray") {
                subview.removeFromSuperview();
                removed += 1;
            }
        }
    }

    if should_show_title() {
        unsafe {
            let title = NSString::from_str("Edge");
            button.setTitle(&title);
            button.setImagePosition(NSCellImagePosition::ImageLeft);
        }
    }

    unsafe {
        button.setHidden(false);
        button.setNeedsDisplay();
    }

    eprintln!(
        "[E-Agent Edge] 菜单栏：setVisible(true)，TrayTarget 移除×{removed}，标题={}",
        should_show_title()
    );
    Ok(())
}
