//! 菜单栏诊断日志（`~/Library/Logs/E-Agent-Edge/tray-diag.log`）

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

pub fn log_tray(message: &str) {
    let path = diag_path();
    if let Some(parent) = path.parent() {
        let _ = create_dir_all(parent);
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{message}");
    }
    eprintln!("[E-Agent Edge] {message}");
}

pub fn diag_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Library/Logs/E-Agent-Edge/tray-diag.log")
}
