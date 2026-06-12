//! 纯 Cocoa NSStatusItem（Objective-C，无 tray-icon / TrayTarget）

use std::ffi::{c_char, CStr};
use std::io::Cursor;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::AppHandle;

use super::{activate_app, log_tray};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// 与 Dock 应用图标同源
const BRAND_PNG: &[u8] = include_bytes!("../../icons/tray-icon@2x.png");
const TEMPLATE_PNG: &[u8] = include_bytes!("../../icons/tray-icon-template@1x.png");

#[link(name = "edge_menubar", kind = "static")]
extern "C" {
    fn edge_menubar_set_action_handler(handler: Option<extern "C" fn(*const c_char)>);
    fn edge_menubar_install_png(
        rgba: *const u8,
        len: usize,
        width: u32,
        height: u32,
        as_template: bool,
    );
    fn edge_menubar_refresh_visible();
    fn edge_menubar_log_geometry(buf: *mut c_char, buflen: usize);
    fn edge_menubar_log_environment(buf: *mut c_char, buflen: usize);
}

pub struct ObjcMenuBarTray;

pub fn install(app: &AppHandle) -> Result<ObjcMenuBarTray, String> {
    activate_app();
    let _ = APP.set(app.clone());

    log_environment();
    // 默认彩色品牌图（与 app 一致）；MC_EDGE_TRAY_TEMPLATE=1 时用单色 template
    let use_template = std::env::var("MC_EDGE_TRAY_TEMPLATE")
        .ok()
        .as_deref()
        .map(str::trim)
        == Some("1");
    let (rgba, w, h) = if use_template {
        decode_png(TEMPLATE_PNG)?
    } else {
        decode_png(BRAND_PNG)?
    };
    unsafe {
        edge_menubar_set_action_handler(Some(c_menu_action));
        edge_menubar_install_png(rgba.as_ptr(), rgba.len(), w, h, use_template);
    }
    log_geometry("install");
    Ok(ObjcMenuBarTray)
}

pub fn refresh_visible() {
    unsafe {
        edge_menubar_refresh_visible();
    }
    log_geometry("refresh");
}

pub fn schedule_visible_retries() {
    std::thread::spawn(|| {
        for delay_ms in [200u64, 800, 2000, 5000] {
            std::thread::sleep(Duration::from_millis(delay_ms));
            unsafe {
                edge_menubar_refresh_visible();
            }
            log_geometry("retry");
        }
    });
}

extern "C" fn c_menu_action(id: *const c_char) {
    let Ok(id) = (unsafe { CStr::from_ptr(id) }).to_str() else {
        return;
    };
    let Some(app) = APP.get() else {
        return;
    };
    let app = app.clone();
    let id = id.to_string();
    let _ = app.clone().run_on_main_thread(move || {
        super::handle_tray_menu(&app, &id);
    });
}

fn log_environment() {
    let mut buf = [0i8; 512];
    unsafe {
        edge_menubar_log_environment(buf.as_mut_ptr(), buf.len());
    }
    let msg = unsafe { CStr::from_ptr(buf.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    log_tray(&msg);
}

fn decode_png(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(buf.len() / 3 * 4);
            for chunk in buf.chunks_exact(3) {
                out.extend_from_slice(chunk);
                out.push(255);
            }
            out
        }
        other => return Err(format!("不支持的 PNG 色彩: {other:?}")),
    };
    Ok((rgba, info.width, info.height))
}

fn log_geometry(phase: &str) {
    let mut buf = [0i8; 512];
    unsafe {
        edge_menubar_log_geometry(buf.as_mut_ptr(), buf.len());
    }
    let msg = unsafe { CStr::from_ptr(buf.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    log_tray(&format!("{msg} [{phase}]"));
}
