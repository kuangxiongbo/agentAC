use crate::{bootstrap, config, process, runtime};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const HEALTH_INTERVAL: Duration = Duration::from_secs(60);
const STARTUP_DELAY: Duration = Duration::from_secs(20);
const MIN_RECOVERY_GAP: Duration = Duration::from_secs(30);
const RUNTIME_UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(10 * 60);

static STARTED: AtomicBool = AtomicBool::new(false);

lazy_static::lazy_static! {
    static ref LAST_RECOVERY: Mutex<Option<Instant>> = Mutex::new(None);
    static ref LAST_RUNTIME_UPDATE_CHECK: Mutex<Option<Instant>> = Mutex::new(None);
}

fn can_recover(force: bool) -> bool {
    if force {
        return true;
    }
    let mut guard = LAST_RECOVERY.lock().unwrap();
    if guard
        .map(|last| last.elapsed() < MIN_RECOVERY_GAP)
        .unwrap_or(false)
    {
        return false;
    }
    *guard = Some(Instant::now());
    true
}

fn mark_recovery() {
    *LAST_RECOVERY.lock().unwrap() = Some(Instant::now());
}

fn should_check_runtime_update(force: bool) -> bool {
    if force {
        return true;
    }
    let mut guard = LAST_RUNTIME_UPDATE_CHECK.lock().unwrap();
    if guard
        .map(|last| last.elapsed() < RUNTIME_UPDATE_CHECK_INTERVAL)
        .unwrap_or(false)
    {
        return false;
    }
    *guard = Some(Instant::now());
    true
}

fn runtime_update_target(cfg: &config::EdgeConfig, force: bool) -> Result<Option<String>, String> {
    if !should_check_runtime_update(force) {
        return Ok(None);
    }

    runtime::clear_cached_manifest();
    let manifest = runtime::fetch_manifest(cfg)?;
    let installed = runtime::installed_version();
    if installed.as_deref() == Some(manifest.client_version.as_str()) {
        return Ok(None);
    }

    Ok(Some(manifest.client_version))
}

pub fn recover_edge_runtime(reason: &str, force: bool) -> Result<(), String> {
    let cfg = config::load_config();
    if !config::is_setup_complete(&cfg) {
        return Ok(());
    }
    if !force && process::is_running() && process::is_healthy(&cfg) {
        match runtime_update_target(&cfg, false) {
            Ok(Some(target_version)) => {
                if !can_recover(false) {
                    return Ok(());
                }
                eprintln!(
                    "[E-Agent Edge] supervisor: runtime update available ({target_version}); restarting local runtime"
                );
                let payload = bootstrap::apply_tray_bootstrap(&cfg)?;
                process::stop()?;
                runtime::clear_cached_manifest();
                runtime::ensure_runtime(&cfg)?;
                process::ensure_running(&cfg, Some(&payload))?;
                if process::is_healthy(&cfg) {
                    let refreshed = config::load_config();
                    if let Err(e) = bootstrap::push_tray_credentials_to_local(&refreshed) {
                        eprintln!("[E-Agent Edge] supervisor: bridge reconnect apply failed: {e}");
                    }
                }
                mark_recovery();
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!(
                    "[E-Agent Edge] supervisor: runtime update check skipped: {e}"
                );
            }
        }
        return Ok(());
    }
    if !can_recover(force) {
        return Ok(());
    }

    eprintln!("[E-Agent Edge] supervisor: recovery start ({reason})");
    let payload = bootstrap::apply_tray_bootstrap(&cfg)?;
    runtime::ensure_runtime(&cfg)?;
    process::ensure_running(&cfg, Some(&payload))?;
    if process::is_healthy(&cfg) {
        let refreshed = config::load_config();
        if let Err(e) = bootstrap::push_tray_credentials_to_local(&refreshed) {
            eprintln!("[E-Agent Edge] supervisor: bridge reconnect apply failed: {e}");
        }
    }
    mark_recovery();
    eprintln!("[E-Agent Edge] supervisor: recovery complete ({reason})");
    Ok(())
}

pub fn start_background_supervisor() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(STARTUP_DELAY);
        loop {
            if let Err(e) = recover_edge_runtime("periodic-health", false) {
                eprintln!("[E-Agent Edge] supervisor: periodic recovery failed: {e}");
            }
            std::thread::sleep(HEALTH_INTERVAL);
        }
    });
}

pub fn recover_after_resume() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(2));
        if let Err(e) = recover_edge_runtime("system-resume", true) {
            eprintln!("[E-Agent Edge] supervisor: resume recovery failed: {e}");
        }
    });
}
