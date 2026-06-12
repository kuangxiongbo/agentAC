use crate::config::{self, EdgeConfig};
use crate::http_client;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;

const CURRENT_TRAY_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PLATFORM: &str = "darwin-aarch64";
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrayUpdateStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub download_url: Option<String>,
    pub filename: Option<String>,
    pub sha256: Option<String>,
    pub release_notes: Option<String>,
    pub checked_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TrayManifest {
    tray_version: String,
    #[serde(default)]
    release_notes: Option<String>,
    platforms: std::collections::HashMap<String, TrayArtifact>,
}

#[derive(Debug, Deserialize)]
struct TrayArtifact {
    url: String,
    sha256: String,
    #[serde(default)]
    filename: Option<String>,
}

struct TrayUpdateCache {
    status: TrayUpdateStatus,
    last_check: Option<Instant>,
}

lazy_static::lazy_static! {
    static ref CACHE: Mutex<TrayUpdateCache> = Mutex::new(TrayUpdateCache {
        status: empty_status(),
        last_check: None,
    });
}

fn empty_status() -> TrayUpdateStatus {
    TrayUpdateStatus {
        current_version: CURRENT_TRAY_VERSION.to_string(),
        latest_version: None,
        update_available: false,
        download_url: None,
        filename: None,
        sha256: None,
        release_notes: None,
        checked_at: None,
        error: None,
    }
}

fn platform_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "darwin-aarch64";
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return "darwin-x86_64";
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64")
    )))]
    {
        DEFAULT_PLATFORM
    }
}

fn public_url(center_url: &str, raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    let base = center_url.trim_end_matches('/');
    format!("{base}{}", if trimmed.starts_with('/') { trimmed.to_string() } else { format!("/{trimmed}") })
}

fn parse_version(version: &str) -> Vec<u64> {
    version
        .split(|c| c == '.' || c == '-' || c == '+')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let mut l = parse_version(latest);
    let mut c = parse_version(current);
    let len = l.len().max(c.len());
    l.resize(len, 0);
    c.resize(len, 0);
    l > c
}

fn fetch_update_status(cfg: &EdgeConfig) -> Result<TrayUpdateStatus, String> {
    let center = cfg.center_url.trim_end_matches('/');
    let url = format!("{center}/edge-tray/manifest.json");
    let client = http_client::build_http_client(cfg, Duration::from_secs(30))?;
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("无法检查托盘更新 ({url}): {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("托盘更新清单 HTTP {} ({url})", resp.status()));
    }
    let manifest = resp
        .json::<TrayManifest>()
        .map_err(|e| format!("托盘更新清单 JSON 无效: {e}"))?;
    let key = platform_key();
    let artifact = manifest
        .platforms
        .get(key)
        .or_else(|| manifest.platforms.get(DEFAULT_PLATFORM))
        .ok_or_else(|| format!("托盘更新清单中无当前平台 {key}"))?;
    let latest = manifest.tray_version.trim().to_string();
    let update_available = is_newer(&latest, CURRENT_TRAY_VERSION);
    Ok(TrayUpdateStatus {
        current_version: CURRENT_TRAY_VERSION.to_string(),
        latest_version: Some(latest),
        update_available,
        download_url: Some(public_url(center, &artifact.url)),
        filename: artifact.filename.clone(),
        sha256: Some(artifact.sha256.clone()),
        release_notes: manifest.release_notes,
        checked_at: Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        ),
        error: None,
    })
}

pub fn check_for_update(force: bool) -> TrayUpdateStatus {
    let cfg = config::load_config();
    {
        let cache = CACHE.lock().unwrap();
        if !force {
            if let Some(last) = cache.last_check {
                if last.elapsed() < CHECK_INTERVAL {
                    return cache.status.clone();
                }
            }
        }
    }

    let next = match fetch_update_status(&cfg) {
        Ok(status) => status,
        Err(e) => TrayUpdateStatus {
            error: Some(e),
            ..empty_status()
        },
    };
    let mut cache = CACHE.lock().unwrap();
    cache.last_check = Some(Instant::now());
    cache.status = next.clone();
    next
}

pub fn cached_update_status() -> TrayUpdateStatus {
    CACHE.lock().unwrap().status.clone()
}

#[tauri::command]
pub fn get_tray_update_status() -> TrayUpdateStatus {
    cached_update_status()
}

#[tauri::command]
pub fn check_tray_update(force: Option<bool>) -> TrayUpdateStatus {
    check_for_update(force.unwrap_or(false))
}

#[tauri::command]
pub fn open_tray_update_download(app: tauri::AppHandle) -> Result<(), String> {
    let status = check_for_update(false);
    let Some(url) = status.download_url.filter(|u| !u.trim().is_empty()) else {
        return Err(status.error.unwrap_or_else(|| "暂无托盘更新下载地址".to_string()));
    };
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

pub fn start_background_check(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(8));
        let status = check_for_update(false);
        if status.update_available {
            let _ = app.emit("tray-update", status);
            let _ = crate::setup::open_setup_window(&app);
        }
    });
}
