//! 纯原生 NSStatusItem（无 tray-icon / TrayTarget）

use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use muda::{ContextMenu, Menu};
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_app_kit::{NSImage, NSMenu, NSStatusBar, NSStatusItem};
use objc2_foundation::{MainThreadMarker, NSData, NSRect, NSSize, NSString};
use tauri::AppHandle;

/// 与 Dock 应用图标同源（app-logo → tray-icon.png）
const MENU_BAR_PNG: &[u8] = include_bytes!("../../icons/tray-icon.png");

static STATUS_ITEM_PTR: AtomicPtr<NSStatusItem> = AtomicPtr::new(ptr::null_mut());

// Cache the raw NSImage pointer to avoid re-decoding PNG on every refresh.
// NSImage is ObjC reference-counted; we retain it for the app lifetime.
static CACHED_IMAGE_PTR: AtomicPtr<NSImage> = AtomicPtr::new(ptr::null_mut());

pub struct NativeMenuBarTray;

pub fn install() -> Result<NativeMenuBarTray, String> {
    super::activate_app();

    let menu = super::build_muda_tray_menu()?;
    let mtm = MainThreadMarker::new().ok_or("NSStatusItem 需要主线程")?;

    let status_item = NSStatusBar::systemStatusBar().statusItemWithLength(22.0);
    status_item.setVisible(true);

    let button = status_item
        .button(mtm)
        .ok_or("NSStatusBarButton 不可用")?;

    for sub in button.subviews().iter() {
        sub.removeFromSuperview();
    }

    set_button_icon(&button, mtm)?;
    button.setTitle(&NSString::from_str(""));
    button.setHidden(false);
    button.setNeedsDisplay();
    button.setEnabled(true);

    let ns_menu_ptr = menu.ns_menu();
    if ns_menu_ptr.is_null() {
        return Err("muda NSMenu 为空".to_string());
    }
    let ns_menu =
        unsafe { Retained::retain(ns_menu_ptr.cast::<NSMenu>()) }.ok_or("无法 retain NSMenu")?;
    status_item.setMenu(Some(&ns_menu));

    let raw = Retained::into_raw(status_item);
    STATUS_ITEM_PTR.store(raw, Ordering::Release);
    Box::leak(Box::new(menu));

    log_geometry("install");
    Ok(NativeMenuBarTray)
}

pub fn schedule_visible_retries(app: AppHandle) {
    std::thread::spawn(move || {
        for delay_ms in [200u64, 800, 2000, 5000] {
            std::thread::sleep(Duration::from_millis(delay_ms));
            let app = app.clone();
            let _ = app.run_on_main_thread(|| {
                refresh_on_main_thread();
                log_geometry("retry");
            });
        }
    });
}

pub fn refresh_on_main_thread_public() {
    refresh_on_main_thread();
}

fn refresh_on_main_thread() {
    let ptr = STATUS_ITEM_PTR.load(Ordering::Acquire);
    if ptr.is_null() {
        return;
    }
    let item = unsafe { &*ptr };
    item.setVisible(true);
    item.setLength(22.0);
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(button) = item.button(mtm) else {
        return;
    };
    for sub in button.subviews().iter() {
        sub.removeFromSuperview();
    }
    let _ = set_button_icon(&button, mtm);
    button.setTitle(&NSString::from_str(""));
    button.setHidden(false);
    button.setNeedsDisplay();
}

fn get_or_create_image() -> Result<*mut NSImage, String> {
    let cached = CACHED_IMAGE_PTR.load(Ordering::Acquire);
    if !cached.is_null() {
        return Ok(cached);
    }
    let nsdata = NSData::with_bytes(MENU_BAR_PNG);
    let allocated = NSImage::alloc();
    let img = NSImage::initWithData(allocated, &nsdata).ok_or("NSImage 解码失败")?;
    img.setSize(NSSize::new(18.0, 18.0));
    img.setTemplate(false);
    let raw = Retained::into_raw(img);
    // Store for lifetime of process; intentional leak.
    CACHED_IMAGE_PTR.store(raw, Ordering::Release);
    Ok(raw)
}

fn set_button_icon(
    button: &objc2_app_kit::NSStatusBarButton,
    mtm: MainThreadMarker,
) -> Result<(), String> {
    let raw = get_or_create_image()?;
    let img = unsafe { &*raw };
    button.setImage(Some(img));
    let _ = mtm;
    Ok(())
}

fn log_geometry(phase: &str) {
    let ptr = STATUS_ITEM_PTR.load(Ordering::Acquire);
    if ptr.is_null() {
        super::log_tray(&format!("native_tray[{phase}] 无 status item"));
        return;
    }
    let item = unsafe { &*ptr };
    let visible = item.isVisible();
    let length = item.length();
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(button) = item.button(mtm) else {
        super::log_tray(&format!("native_tray[{phase}] 无 button"));
        return;
    };

    let has_image = button.image().is_some();
    let title = button.title().to_string();
    let btn_frame = button.frame();
    let sub_count = button.subviews().len();

    let screen_info = button.window().map(|win| {
        let local = btn_frame;
        let screen: NSRect = win.convertRectToScreen(local);
        format!(
            "screen=({:.0},{:.0},{:.0}x{:.0})",
            screen.origin.x, screen.origin.y, screen.size.width, screen.size.height
        )
    }).unwrap_or_else(|| "no-window".into());

    super::log_tray(&format!(
        "native_tray[{phase}] visible={visible} len={length:.0} title=\"{title}\" hasImage={has_image} button=({:.0},{:.0},{:.0}x{:.0}) subviews={sub_count} {screen_info}",
        btn_frame.origin.x,
        btn_frame.origin.y,
        btn_frame.size.width,
        btn_frame.size.height,
    ));
}
