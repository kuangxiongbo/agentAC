use crate::{bootstrap, config, process, runtime};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const HEALTH_INTERVAL: Duration = Duration::from_secs(60);
const STARTUP_DELAY: Duration = Duration::from_secs(20);
const MIN_RECOVERY_GAP: Duration = Duration::from_secs(30);

static STARTED: AtomicBool = AtomicBool::new(false);

lazy_static::lazy_static! {
    static ref LAST_RECOVERY: Mutex<Option<Instant>> = Mutex::new(None);
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

pub fn recover_edge_runtime(reason: &str, force: bool) -> Result<(), String> {
    let cfg = config::load_config();
    if !config::is_setup_complete(&cfg) {
        return Ok(());
    }
    if !force && process::is_running() && process::is_healthy(&cfg) {
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
