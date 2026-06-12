//! Block macOS system sleep while E-Agent Edge tray is running.
//! Display may turn off; machine stays reachable over the network until shutdown.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static KEEP_AWAKE_CHILD: Mutex<Option<Child>> = Mutex::new(None);

pub fn keep_awake_enabled() -> bool {
    std::env::var("MC_KEEP_AWAKE")
        .unwrap_or_else(|_| "1".into())
        != "0"
}

#[cfg(target_os = "macos")]
pub fn start_system_keep_awake() {
    if !keep_awake_enabled() {
        return;
    }
    let mut guard = KEEP_AWAKE_CHILD.lock().unwrap();
    if guard.is_some() {
        return;
    }
    let pid = std::process::id();
    match Command::new("caffeinate")
        // -i idle sleep, -m disk sleep, -s system sleep (AC), -u user active (battery)
        // -w: hold assertion until tray process exits
        .args(["-imsu", "-w", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => {
            eprintln!(
                "[E-Agent Edge] keep-awake: blocking system sleep while tray runs (pid {pid}; display may turn off)"
            );
            *guard = Some(child);
        }
        Err(e) => eprintln!("[E-Agent Edge] keep-awake: caffeinate failed: {e}"),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn start_system_keep_awake() {}

#[cfg(target_os = "macos")]
pub fn stop_system_keep_awake() {
    let mut guard = KEEP_AWAKE_CHILD.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(not(target_os = "macos"))]
pub fn stop_system_keep_awake() {}
