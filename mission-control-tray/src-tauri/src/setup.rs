use crate::bootstrap::{self, CenterBootstrap};
use crate::config::{self, console_url, load_config, save_config, EdgeConfig};
use crate::process;
use crate::runtime;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SetupStatus {
    pub configured: bool,
    pub phase: String,
    pub message: String,
    pub console_url: String,
    pub error: Option<String>,
}

/// Pre-fill for setup.html (token stored locally in ~/.e-agent-edge/config.json).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSetupForm {
    pub center_url: String,
    pub api_token: String,
    pub tls_insecure: bool,
    pub has_saved_token: bool,
}

struct SetupState {
    status: SetupStatus,
    running: bool,
}

lazy_static::lazy_static! {
    static ref INTENTIONAL_QUIT: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    static ref SETUP: Mutex<SetupState> = Mutex::new(SetupState {
        status: default_status(),
        running: false,
    });
    static ref LAST_CONSOLE_OPEN: Mutex<Option<Instant>> = Mutex::new(None);
}

use std::sync::atomic::Ordering;

/// 菜单栏托盘「退出」：标记后停止 5101 并结束进程。
pub fn quit_from_tray(app: &AppHandle) {
    INTENTIONAL_QUIT.store(true, Ordering::SeqCst);
    let _ = process::stop();
    crate::keep_awake::stop_system_keep_awake();
    app.exit(0);
}

pub fn is_intentional_quit() -> bool {
    INTENTIONAL_QUIT.load(Ordering::SeqCst)
}

/// Dock / 关配置窗：仅隐藏窗口，5101 与菜单栏托盘继续运行。
pub fn hide_to_background(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = crate::macos::set_activation_policy_accessory(app);
    if let Some(w) = app.get_webview_window("setup") {
        let _ = w.hide();
    }
}

fn default_status() -> SetupStatus {
    let cfg = load_config();
    SetupStatus {
        configured: config::is_setup_complete(&cfg),
        phase: "idle".to_string(),
        message: String::new(),
        console_url: console_url(&cfg),
        error: None,
    }
}

const CONSOLE_OPEN_DEBOUNCE: Duration = Duration::from_secs(10);

fn set_status(update: impl FnOnce(&mut SetupStatus)) {
    let mut guard = SETUP.lock().unwrap();
    update(&mut guard.status);
}

fn set_running(running: bool) {
    SETUP.lock().unwrap().running = running;
}

fn is_running() -> bool {
    SETUP.lock().unwrap().running
}

pub fn current_status() -> SetupStatus {
    SETUP.lock().unwrap().status.clone()
}

/// 点击托盘 / Dock 图标：弹出与首次初始化相同的连接配置页（不先停 5101）。
pub fn open_tray_config(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let _ = crate::macos::set_activation_policy_regular(app);
    open_setup_window(app)
}

#[tauri::command]
pub fn open_tray_config_cmd(app: AppHandle) -> Result<(), String> {
    open_tray_config(&app)
}

pub fn open_setup_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("setup").is_some() {
        let _ = app.get_webview_window("setup").unwrap().show();
        let _ = app.get_webview_window("setup").unwrap().set_focus();
        return Ok(());
    }
    eprintln!("[E-Agent Edge] 打开连接初始化窗口（托盘进程已运行，菜单栏找 Edge）");
    let win = tauri::WebviewWindowBuilder::new(app, "setup", tauri::WebviewUrl::App("setup.html".into()))
        .title("E-Agent Edge — 连接配置")
        .inner_size(520.0, 520.0)
        .min_inner_size(420.0, 400.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    // 关窗 / Dock：只隐藏，不停止 5101（仅菜单栏「退出」才停服务）
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            hide_to_background(&handle);
        }
    });
    Ok(())
}

fn normalize_center_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err("请填写连接地址".to_string());
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("连接地址须以 https:// 或 http:// 开头".to_string());
    }
    Ok(url.to_string())
}

fn run_setup_pipeline(app: AppHandle, mut cfg: EdgeConfig) {
    set_running(true);
    set_status(|s| {
        s.phase = "connecting".to_string();
        s.message = "正在连接服务中心…".to_string();
        s.error = None;
    });
    let _ = app.emit("setup-status", current_status());

    let result: Result<CenterBootstrap, String> = (|| {
        set_status(|s| {
            s.phase = "connecting".to_string();
            s.message = "正在连接服务中心…".to_string();
        });
        let _ = app.emit("setup-status", current_status());
        let payload = bootstrap::apply_tray_bootstrap(&cfg)?;

        set_status(|s| {
            s.phase = "runtime".to_string();
            s.message = "正在准备本机运行环境…".to_string();
        });
        let _ = app.emit("setup-status", current_status());
        runtime::ensure_runtime(&cfg)?;

        set_status(|s| {
            s.phase = "starting".to_string();
            s.message = "正在启动本机 Web 客户端…".to_string();
        });
        let _ = app.emit("setup-status", current_status());
        process::ensure_running(&cfg, Some(&payload))?;

        cfg.setup_completed = Some(true);
        let _ = save_config(&cfg);
        Ok(payload)
    })();

    match result {
        Ok(payload) => {
            let enterprise = payload.enterprise.name.clone();
            let client_name = payload.client.client_name.clone();
            let url = console_url(&cfg);
            set_status(|s| {
                s.configured = true;
                s.phase = "done".to_string();
                s.message = format!("已连接 {enterprise} · 客户端「{client_name}」");
                s.console_url = url.clone();
                s.error = None;
            });
            let _ = app.emit("setup-status", current_status());
            if process::is_healthy(&cfg) {
                let _ = open_console(app.clone());
            }
            eprintln!("[E-Agent Edge] 初始化完成 · {url}");
        }
        Err(e) => {
            set_status(|s| {
                s.phase = "error".to_string();
                s.message = "初始化失败".to_string();
                s.error = Some(e.clone());
            });
            let _ = app.emit("setup-status", current_status());
            eprintln!("[E-Agent Edge] 初始化失败: {e}");
        }
    }
    set_running(false);
}

/// Background bootstrap when setup was completed earlier.
pub fn run_if_configured(app: &AppHandle, open_console_when_done: bool) {
    let cfg = load_config();
    if !config::is_setup_complete(&cfg) {
        return;
    }
    if is_running() {
        return;
    }
    if process::is_running() && process::is_healthy(&cfg) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        set_running(true);
        set_status(|s| {
            s.phase = "starting".to_string();
            s.message = "正在启动边缘服务…".to_string();
            s.error = None;
        });
        let _ = app.emit("setup-status", current_status());

        let cfg = load_config();
        let err = (|| {
            let payload = bootstrap::apply_tray_bootstrap(&cfg)?;
            runtime::ensure_runtime(&cfg)?;
            process::ensure_running(&cfg, Some(&payload))?;
            Ok::<(), String>(())
        })();

        if let Err(e) = err {
            set_status(|s| {
                s.phase = "error".to_string();
                s.message = "启动失败".to_string();
                s.error = Some(e);
            });
        } else {
            set_status(|s| {
                s.configured = true;
                s.phase = "done".to_string();
                s.message = "边缘服务已运行".to_string();
                s.console_url = console_url(&load_config());
                s.error = None;
            });
            if open_console_when_done {
                let _ = open_console(app.clone());
            }
        }
        set_running(false);
        let _ = app.emit("setup-status", current_status());
    });
}

#[tauri::command]
pub fn get_setup_status() -> SetupStatus {
    current_status()
}

#[tauri::command]
pub fn get_saved_setup() -> SavedSetupForm {
    let cfg = load_config();
    let token = cfg.enroll_token.clone().unwrap_or_default();
    SavedSetupForm {
        center_url: if cfg.center_url.trim().is_empty() {
            config::DEFAULT_CENTER_URL.to_string()
        } else {
            cfg.center_url.clone()
        },
        api_token: token.clone(),
        tls_insecure: cfg.tls_insecure == Some(true),
        has_saved_token: !token.trim().is_empty(),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn submit_setup(
    app: AppHandle,
    center_url: String,
    api_token: String,
    tls_insecure: Option<bool>,
) -> Result<(), String> {
    if is_running() {
        return Err("正在初始化，请稍候…".to_string());
    }

    let center_url = normalize_center_url(&center_url)?;
    let mut cfg = load_config();
    let token = api_token.trim().to_string();
    let token = if token.is_empty() {
        cfg.enroll_token
            .clone()
            .unwrap_or_default()
            .trim()
            .to_string()
    } else {
        token
    };
    if token.is_empty() {
        return Err("请填写认证令牌 (API TOKEN)".to_string());
    }

    cfg.center_url = center_url;
    cfg.enroll_token = Some(token);
    cfg.tls_insecure = if tls_insecure == Some(true) {
        Some(true)
    } else {
        None
    };
    cfg.setup_completed = Some(false);
    save_config(&cfg)?;

    if process::is_healthy(&cfg) {
        if let Err(e) = bootstrap::push_tray_credentials_to_local(&cfg) {
            eprintln!("[E-Agent Edge] 预同步 5101 配置: {e}");
        }
    }

    set_status(|s| {
        s.configured = false;
        s.phase = "connecting".to_string();
        s.message = "正在保存并连接…".to_string();
        s.console_url = console_url(&cfg);
        s.error = None;
    });

    let app_clone = app.clone();
    std::thread::spawn(move || run_setup_pipeline(app_clone, cfg));
    Ok(())
}

#[tauri::command]
pub fn open_console(app: AppHandle) -> Result<(), String> {
    {
        let mut last = LAST_CONSOLE_OPEN.lock().unwrap();
        if last
            .map(|t| t.elapsed() < CONSOLE_OPEN_DEBOUNCE)
            .unwrap_or(false)
        {
            return Ok(());
        }
        *last = Some(Instant::now());
    }
    let cfg = load_config();
    if !config::is_setup_complete(&cfg) {
        return open_setup_window(&app);
    }
    if !process::is_healthy(&cfg) {
        let payload = crate::bootstrap::load_cached_bootstrap();
        if let Err(e) = process::ensure_running(&cfg, payload.as_ref()) {
            return Err(format!(
                "{e}\n\n请先在托盘打开「连接配置」，填写地址与令牌后点击「连接并启动」。"
            ));
        }
    }
    let url = console_url(&cfg);
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn close_setup_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("setup") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn open_connection_setup(app: AppHandle) -> Result<(), String> {
    let _ = process::stop();
    open_setup_window(&app)
}
