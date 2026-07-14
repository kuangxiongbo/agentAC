use crate::bootstrap::CenterBootstrap;
use crate::config::{self, EdgeConfig};
use crate::http_client;
use crate::keep_awake;
use crate::runtime;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

static CHILD: Mutex<Option<Child>> = Mutex::new(None);

#[derive(Debug, serde::Deserialize)]
struct HealthResponse {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    process_id: Option<u32>,
}

#[derive(Debug, Clone)]
struct PortOwnerInfo {
    pid: String,
    command: Option<String>,
    cwd: Option<PathBuf>,
    owned_by_edge: bool,
}

fn duplicate_owned_port_victims(
    infos: &[PortOwnerInfo],
    tracked_pid: Option<&str>,
) -> Vec<String> {
    if infos.len() <= 1 || infos.iter().any(|info| !info.owned_by_edge) {
        return Vec::new();
    }

    match tracked_pid.filter(|pid| infos.iter().any(|info| info.pid == *pid)) {
        Some(pid) => infos
            .iter()
            .filter(|info| info.pid != pid)
            .map(|info| info.pid.clone())
            .collect(),
        None => infos.iter().map(|info| info.pid.clone()).collect(),
    }
}

fn tracked_child_pid() -> Option<String> {
    CHILD
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|child| child.id().to_string()))
}

pub fn is_running() -> bool {
    let mut guard = CHILD.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                false
            }
            Ok(None) => true,
            Err(_) => {
                *guard = None;
                false
            }
        }
    } else {
        false
    }
}

pub fn stop() -> Result<(), String> {
    let mut guard = CHILD.lock().unwrap();
    if let Some(mut child) = guard.take() {
        #[cfg(target_os = "macos")]
        {
            let child_pid = child.id().to_string();
            if let Some(pgid) = pid_pgid(&child_pid) {
                eprintln!(
                    "[E-Agent Edge] stop(): 终止本机 Web 进程组 PGID {}（child PID {}）",
                    pgid, child_pid
                );
                let _ = kill_process_group(&pgid);
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    #[cfg(target_os = "macos")]
    {
        let cfg = config::load_config();
        let _ = recover_owned_port(&cfg, "stop() 收尾清理旧 runtime 进程");
        if port_in_use(cfg.port) {
            if let Ok(infos) = port_owner_infos(cfg.port) {
                if infos.iter().all(|info| info.owned_by_edge) {
                    eprintln!(
                        "[E-Agent Edge] stop(): 端口 {} 仍被本产品进程占用，执行最终清理:\n{}",
                        cfg.port,
                        format_port_owner_infos(&infos)
                    );
                    let _ = kill_port_owner(cfg.port);
                }
            }
        }
    }
    Ok(())
}

fn node_binary() -> Result<PathBuf, String> {
    crate::node_path::resolve_node_binary()
}

fn port_in_use(port: u16) -> bool {
    #[cfg(target_os = "macos")]
    {
        return lsof_port_pids(port)
            .or_else(|_| netstat_port_pids(port))
            .map(|pids| !pids.is_empty())
            .unwrap_or_else(|_| std::net::TcpListener::bind(("127.0.0.1", port)).is_err());
    }

    #[cfg(not(target_os = "macos"))]
    {
        std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
    }
}

fn health_probe_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/status?action=health")
}

/// 本机 Web 客户端是否已就绪（避免端口被占用但返回 Internal Server Error）。
pub fn is_healthy(cfg: &EdgeConfig) -> bool {
    probe_health(cfg).is_some()
}

fn probe_health(cfg: &EdgeConfig) -> Option<HealthResponse> {
    let Ok(client) = http_client::build_http_client(cfg, Duration::from_secs(3)) else {
        return None;
    };
    let resp = client
        .get(health_probe_url(cfg.port))
        .send()
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<HealthResponse>().ok()
}

fn is_current_runtime_healthy(cfg: &EdgeConfig) -> bool {
    let Some(health) = probe_health(cfg) else {
        return false;
    };
    let Some(installed) = runtime::installed_version().filter(|v| v != "local") else {
        return true;
    };
    health.version.as_deref() == Some(installed.as_str())
}

fn lsof_port_pids(port: u16) -> Result<Vec<String>, String> {
    let mut child = Command::new("lsof")
        .arg("-nP")
        .arg(format!("-tiTCP:{port}"))
        .arg("-sTCP:LISTEN")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("无法查询端口 {port} 占用进程: {e}"))?;
    let started = Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(2) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("查询端口 {port} 占用进程超时"));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_string(&mut stdout);
                }
                if !status.success() {
                    return Err(format!("无法查询端口 {port} 占用进程"));
                }
                return Ok(stdout
                    .lines()
                    .map(str::trim)
                    .filter(|pid| !pid.is_empty())
                    .map(ToOwned::to_owned)
                    .collect());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("无法查询端口 {port} 占用进程: {e}")),
        }
    }
}

fn netstat_port_pids(port: u16) -> Result<Vec<String>, String> {
    let output = Command::new("netstat")
        .args(["-anv", "-p", "tcp"])
        .output()
        .map_err(|e| format!("无法查询端口 {port} 网络状态: {e}"))?;
    if !output.status.success() {
        return Err(format!("无法查询端口 {port} 网络状态"));
    }
    let suffix = format!(".{port}");
    let mut pids = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 11 || !fields[3].ends_with(&suffix) {
            continue;
        }
        let state = fields[5];
        if matches!(state, "TIME_WAIT" | "FIN_WAIT_1" | "FIN_WAIT_2" | "CLOSE_WAIT") {
            continue;
        }
        let pid = fields[10];
        if pid.chars().all(|ch| ch.is_ascii_digit()) && pid != "0" {
            pids.push(pid.to_string());
        }
    }
    pids.sort();
    pids.dedup();
    Ok(pids)
}

#[cfg(target_os = "macos")]
fn port_owner_pids(port: u16) -> Result<Vec<String>, String> {
    let current_pid = std::process::id().to_string();
    Ok(lsof_port_pids(port)
        .or_else(|err| {
            eprintln!("[E-Agent Edge] {err}，改用 netstat 兜底查询");
            netstat_port_pids(port)
        })?
        .into_iter()
        .filter(|pid| !pid.is_empty() && *pid != current_pid)
        .collect())
}

#[cfg(target_os = "macos")]
fn pid_cwd(pid: &str) -> Option<PathBuf> {
    let output = Command::new("lsof")
        .arg("-nP")
        .arg("-a")
        .arg("-p")
        .arg(pid)
        .arg("-d")
        .arg("cwd")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    for line in String::from_utf8_lossy(&output.stdout).lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if let Some(path) = fields.last() {
            return Some(PathBuf::from(path));
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn pid_command(pid: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", pid, "-o", "comm="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "macos")]
fn pid_pgid(pid: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", pid, "-o", "pgid="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

#[cfg(target_os = "macos")]
fn kill_process_group(pgid: &str) -> Result<(), String> {
    let group = pgid.trim();
    if group.is_empty() {
        return Err("进程组 ID 为空".to_string());
    }
    let target = format!("-{group}");
    let _ = Command::new("kill").arg(&target).status();
    for _ in 0..20 {
        let still_alive = Command::new("ps")
            .args(["-o", "pid=", "-g", group])
            .output()
            .ok()
            .map(|out| {
                out.status.success()
                    && String::from_utf8_lossy(&out.stdout)
                        .lines()
                        .any(|line| !line.trim().is_empty())
            })
            .unwrap_or(false);
        if !still_alive {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = Command::new("kill").args(["-KILL", &target]).status();
    Ok(())
}

#[cfg(target_os = "macos")]
fn is_edge_runtime_port_owner(pid: &str) -> bool {
    let runtime_root = config::runtime_root()
        .canonicalize()
        .unwrap_or_else(|_| config::runtime_root());
    pid_cwd(pid)
        .and_then(|cwd| cwd.canonicalize().ok())
        .map(|cwd| cwd.starts_with(&runtime_root))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn port_owner_infos(port: u16) -> Result<Vec<PortOwnerInfo>, String> {
    Ok(port_owner_pids(port)?
        .into_iter()
        .map(|pid| PortOwnerInfo {
            command: pid_command(&pid),
            cwd: pid_cwd(&pid),
            owned_by_edge: is_edge_runtime_port_owner(&pid),
            pid,
        })
        .collect())
}

#[cfg(target_os = "macos")]
fn format_port_owner_infos(infos: &[PortOwnerInfo]) -> String {
    if infos.is_empty() {
        return "未识别到占用进程".to_string();
    }
    infos
        .iter()
        .map(|info| {
            let command = info.command.as_deref().unwrap_or("unknown");
            let cwd = info
                .cwd
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let owner = if info.owned_by_edge {
                "E-Agent Edge"
            } else {
                "other"
            };
            format!("PID {} · {} · {} · cwd={}", info.pid, command, owner, cwd)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn kill_port_owner(port: u16) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let pids = port_owner_pids(port)?;
        if pids.is_empty() {
            return Err(format!("端口 {port} 没有可清理的外部监听进程"));
        }
        for pid in &pids {
            let _ = Command::new("kill").arg(pid).status();
        }
        for _ in 0..20 {
            if !port_in_use(port) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        for pid in &pids {
            let _ = Command::new("kill").args(["-KILL", pid]).status();
        }
        for _ in 0..12 {
            if !port_in_use(port) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err(format!("已尝试清理端口 {port}，但端口仍被占用"))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(format!("端口 {port} 被旧服务占用，请先手动停止后重试"))
    }
}

#[cfg(target_os = "macos")]
fn terminate_pids(pids: &[String]) {
    for pid in pids {
        let _ = Command::new("kill").arg(pid).status();
    }
    for _ in 0..20 {
        let alive = pids.iter().any(|pid| {
            Command::new("kill")
                .args(["-0", pid])
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        });
        if !alive {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    for pid in pids {
        let _ = Command::new("kill").args(["-KILL", pid]).status();
    }
}

fn recover_duplicate_owned_port(cfg: &EdgeConfig) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let infos = port_owner_infos(cfg.port)?;
        if infos.len() <= 1 {
            return Ok(false);
        }
        if infos.iter().any(|info| !info.owned_by_edge) {
            return Err(format!(
                "端口 {} 同时被 E-Agent Edge 和其他程序占用，未自动终止任何进程：\n{}",
                cfg.port,
                format_port_owner_infos(&infos)
            ));
        }
        let tracked = tracked_child_pid();
        let victims = duplicate_owned_port_victims(&infos, tracked.as_deref());
        if victims.is_empty() {
            return Ok(false);
        }
        let responder_pid = probe_health(cfg)
            .and_then(|health| health.process_id)
            .map(|pid| pid.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        eprintln!(
            "[E-Agent Edge] 端口 {} 检测到 {} 个重复 runtime（health responder PID {}），保留当前托盘实例并清理 PID: {}",
            cfg.port,
            infos.len(),
            responder_pid,
            victims.join(", ")
        );
        terminate_pids(&victims);
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = cfg;
        Ok(false)
    }
}

fn recover_owned_port(cfg: &EdgeConfig, reason: &str) -> Result<bool, String> {
    if !port_in_use(cfg.port) {
        return Ok(false);
    }
    if is_current_runtime_healthy(cfg) {
        return Ok(false);
    }
    #[cfg(target_os = "macos")]
    {
        let pids = port_owner_pids(cfg.port)?;
        if pids.is_empty() {
            return Ok(false);
        }
        if !pids.iter().all(|pid| is_edge_runtime_port_owner(pid)) {
            return Ok(false);
        }
        eprintln!(
            "[E-Agent Edge] 端口 {} 被本产品 Web 进程占用（{reason}），自动回收后重启",
            cfg.port
        );
        kill_port_owner(cfg.port)?;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = reason;
        Ok(false)
    }
}

fn recover_stale_healthy_port(cfg: &EdgeConfig) -> Result<bool, String> {
    if !port_in_use(cfg.port) || !is_healthy(cfg) || is_current_runtime_healthy(cfg) {
        return Ok(false);
    }
    let installed = runtime::installed_version().unwrap_or_else(|| "unknown".to_string());
    let running = probe_health(cfg)
        .and_then(|h| h.version)
        .unwrap_or_else(|| "unknown".to_string());
    eprintln!(
        "[E-Agent Edge] 端口 {} 正在运行旧 Web 客户端（当前 {running}，目标 {installed}），自动回收后重启",
        cfg.port
    );
    kill_port_owner(cfg.port)?;
    Ok(true)
}

fn node_server_log_hint() -> String {
    let log = config::edge_home().join("logs/node-server.log");
    let Ok(raw) = std::fs::read_to_string(&log) else {
        return String::new();
    };
    let lines: Vec<&str> = raw.lines().collect();
    if lines.is_empty() {
        return String::new();
    }
    let tail: Vec<&str> = lines.into_iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
    format!("\n\nNode 启动日志（{}）:\n{}", log.display(), tail.join("\n"))
}

pub fn wait_until_healthy(cfg: &EdgeConfig, max_attempts: u32) -> Result<(), String> {
    for attempt in 0..max_attempts {
        if is_healthy(cfg) {
            return Ok(());
        }
        if !is_running() && attempt > 2 {
            break;
        }
        if attempt + 1 < max_attempts {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    let hint = node_server_log_hint();
    Err(format!(
        "本机 Web 客户端 ({}:{}) 未就绪。常见原因：① Node 版本低于 22（日志末尾若显示 v20 等需升级）；② runtime 依赖链接损坏（删除 ~/.e-agent-edge/runtime 后重新「连接并启动」）。{hint}",
        "127.0.0.1",
        cfg.port
    ))
}

fn wait_until_current_runtime_healthy(cfg: &EdgeConfig, max_attempts: u32) -> Result<(), String> {
    let mut last_running = String::from("未知");
    let target = runtime::installed_version().unwrap_or_else(|| "未知".to_string());
    for attempt in 0..max_attempts {
        if let Some(health) = probe_health(cfg) {
            last_running = health.version.unwrap_or_else(|| "未知".to_string());
            if is_current_runtime_healthy(cfg) {
                return Ok(());
            }
        }
        if !is_running() && attempt > 2 {
            break;
        }
        if attempt + 1 < max_attempts {
            std::thread::sleep(Duration::from_millis(500));
        }
    }
    let hint = node_server_log_hint();
    Err(format!(
        "本机 Web 客户端版本不匹配：当前运行 {last_running}，目标版本 {target}。托盘将尝试回收旧进程后重启。{hint}"
    ))
}

fn recover_for_version_mismatch(
    cfg: &EdgeConfig,
    bootstrap: Option<&CenterBootstrap>,
) -> Result<bool, String> {
    let stale = recover_stale_healthy_port(cfg)?;
    let owned = recover_owned_port(cfg, "下载完成后仍存在旧 runtime 进程")?;
    if !stale && !owned {
        return Ok(false);
    }
    start(cfg, bootstrap)?;
    wait_until_current_runtime_healthy(cfg, 40)?;
    Ok(true)
}

fn apply_bootstrap_settings_if_needed(
    cfg: &EdgeConfig,
    bootstrap: Option<&CenterBootstrap>,
) -> Result<(), String> {
    if let Some(payload) = bootstrap {
        crate::bootstrap::wait_and_apply_local_settings(cfg.port, &payload.settings)?;
    }
    Ok(())
}

/// 确保边缘服务在跑：已配置用户启动托盘 / 安装完成后自动调用。
pub fn ensure_running(cfg: &EdgeConfig, bootstrap: Option<&CenterBootstrap>) -> Result<(), String> {
    let _ = recover_duplicate_owned_port(cfg)?;
    if is_running() {
        if !is_current_runtime_healthy(cfg) {
            eprintln!("[E-Agent Edge] 已跟踪的 Web 客户端版本不是当前 runtime，准备重启");
            stop()?;
        } else {
            wait_until_healthy(cfg, 40)?;
            return apply_bootstrap_settings_if_needed(cfg, bootstrap);
        }
    }
    let _ = recover_stale_healthy_port(cfg)?;
    let _ = recover_owned_port(cfg, "启动前检测到非当前 runtime")?;
    if port_in_use(cfg.port) {
        if is_current_runtime_healthy(cfg) {
            eprintln!(
                "[E-Agent Edge] 端口 {} 已有当前版本健康服务，沿用现有进程",
                cfg.port
            );
            return apply_bootstrap_settings_if_needed(cfg, bootstrap);
        }
        #[cfg(target_os = "macos")]
        {
            let infos = port_owner_infos(cfg.port)?;
            if infos.iter().all(|info| info.owned_by_edge) {
                eprintln!(
                    "[E-Agent Edge] 端口 {} 仍被旧 runtime 占用，执行最终强制回收:\n{}",
                    cfg.port,
                    format_port_owner_infos(&infos)
                );
                kill_port_owner(cfg.port)?;
                start(cfg, bootstrap)?;
                wait_until_current_runtime_healthy(cfg, 40)?;
                return apply_bootstrap_settings_if_needed(cfg, bootstrap);
            }
            if !infos.is_empty() {
                return Err(format!(
                    "端口 {} 已被其他程序占用，E-Agent Edge 未自动终止该进程。请先关闭占用程序后重试：\n{}",
                    cfg.port,
                    format_port_owner_infos(&infos)
                ));
            }
        }
        if is_healthy(cfg) {
            return Err(format!(
                "端口 {} 已被旧版本 Web 客户端占用，但自动回收失败。请退出托盘后重试，或手动停止占用该端口的 node 进程。",
                cfg.port
            ));
        }
        return Err(format!(
            "端口 {} 已被占用但服务异常（浏览器可能显示 Internal Server Error）。请先执行: cd mission-control-client && pnpm prod:restart --stop，或在托盘菜单选择「重启边缘服务」",
            cfg.port
        ));
    }
    start(cfg, bootstrap)?;
    // 先等 5101 健康，再写入 apply-bootstrap（否则易误报「无法调用 apply-bootstrap」）
    if let Err(version_err) = wait_until_current_runtime_healthy(cfg, 40) {
        eprintln!("[E-Agent Edge] {version_err}");
        if !recover_for_version_mismatch(cfg, bootstrap)? {
            return Err(version_err);
        }
    }
    if !is_current_runtime_healthy(cfg) {
        let running = probe_health(cfg)
            .and_then(|h| h.version)
            .unwrap_or_else(|| "未知".to_string());
        let target = runtime::installed_version().unwrap_or_else(|| "未知".to_string());
        return Err(format!(
            "本机 Web 客户端版本不匹配：当前运行 {running}，目标版本 {target}。请在托盘中重启边缘服务，或退出托盘后重新打开。"
        ));
    }
    apply_bootstrap_settings_if_needed(cfg, bootstrap)
}

fn command_for_node_server(node: &std::path::Path) -> Command {
    #[cfg(target_os = "macos")]
    {
        if keep_awake::keep_awake_enabled() {
            eprintln!("[E-Agent Edge] keep-awake: node wrapped in caffeinate -ims");
            let mut cmd = Command::new("caffeinate");
            // -i idle sleep, -m disk sleep, -s system sleep (AC only); omit -u (user-active = battery drain)
            cmd.arg("-ims").arg(node).arg("server.js");
            return cmd;
        }
    }
    let mut cmd = Command::new(node);
    cmd.arg("server.js");
    cmd
}

pub fn start(cfg: &EdgeConfig, bootstrap: Option<&CenterBootstrap>) -> Result<(), String> {
    runtime::ensure_runtime(cfg)?;
    let _ = recover_duplicate_owned_port(cfg)?;
    if is_running() {
        return Ok(());
    }
    let _ = recover_stale_healthy_port(cfg)?;
    let _ = recover_owned_port(cfg, "启动前检测到非当前 runtime")?;
    if port_in_use(cfg.port) {
        if is_current_runtime_healthy(cfg) {
            eprintln!(
                "[E-Agent Edge] 端口 {} 已有当前版本健康服务，跳过重复启动",
                cfg.port
            );
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            let infos = port_owner_infos(cfg.port)?;
            if infos.iter().all(|info| info.owned_by_edge) {
                eprintln!(
                    "[E-Agent Edge] start(): 端口 {} 仍被旧 runtime 占用，执行最终强制回收:\n{}",
                    cfg.port,
                    format_port_owner_infos(&infos)
                );
                kill_port_owner(cfg.port)?;
            } else if !infos.is_empty() {
                return Err(format!(
                    "端口 {} 已被其他程序占用，E-Agent Edge 未自动终止该进程。请先关闭占用程序后重试：\n{}",
                    cfg.port,
                    format_port_owner_infos(&infos)
                ));
            }
        }
        if port_in_use(cfg.port) {
        eprintln!(
            "[E-Agent Edge] 端口 {} 已被占用（多为 pnpm prod:restart）。请先执行: cd mission-control-client && pnpm prod:restart --stop，或停止占用该端口的进程后重试托盘。",
            cfg.port
        );
        return Err(format!(
            "端口 {} 已被占用，请先停止本机 Web 客户端（pnpm prod:restart --stop）再连接",
            cfg.port
        ));
        }
    }

    let server_js = runtime::server_js_path();
    if !server_js.exists() {
        return Err("未找到 runtime/server.js，请先下载 runtime".to_string());
    }

    let runtime_dir = server_js.parent().unwrap().to_path_buf();
    let data = config::data_dir();
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;

    let node = node_binary()?;
    let mut cmd = command_for_node_server(&node);
    cmd.current_dir(&runtime_dir)
        .env("PATH", crate::node_path::augmented_path_for_subprocess())
        .env("PORT", cfg.port.to_string())
        .env("HOSTNAME", "0.0.0.0")
        .env(
            "MISSION_CONTROL_DATA_DIR",
            data.to_string_lossy().to_string(),
        )
        .env(
            "MISSION_CONTROL_DB_PATH",
            data.join("mission-control.db").to_string_lossy().to_string(),
        )
        .env(
            "MISSION_CONTROL_TOKENS_PATH",
            data
                .join("mission-control-tokens.json")
                .to_string_lossy()
                .to_string(),
        )
        .env("MC_KEEP_AWAKE", "1")
        .env("MC_DISABLE_AUTH", "1")
        .env("MC_EDGE_ALLOW_BOOTSTRAP", "1");

    if cfg.tls_insecure == Some(true) {
        cmd.env("NODE_TLS_REJECT_UNAUTHORIZED", "0")
            .env("MC_EDGE_TLS_INSECURE", "1");
    }

    if let Some(payload) = bootstrap {
        cmd.env("MC_REMOTE_SERVER_URL", &payload.bridge.server_url)
            .env("MC_REMOTE_SERVER_TOKEN", &payload.bridge.token);
        if let Some(name) = cfg.client_name.as_ref().filter(|s| !s.is_empty()) {
            cmd.env("MC_EDGE_CLIENT_NAME", name);
        }
    } else if !cfg.center_url.is_empty() {
        cmd.env("MC_REMOTE_SERVER_URL", cfg.center_url.trim());
    }

    let log_dir = config::edge_home().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let stderr_log = std::fs::File::create(log_dir.join("node-server.log")).ok();

    cmd.stdin(Stdio::null()).stdout(Stdio::null());
    if let Some(file) = stderr_log {
        cmd.stderr(Stdio::from(file));
    } else {
        cmd.stderr(Stdio::null());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 Node 失败（{}）: {e}", node.display()))?;

    *CHILD.lock().unwrap() = Some(child);
    Ok(())
}

pub fn restart(cfg: &EdgeConfig, bootstrap: Option<&CenterBootstrap>) -> Result<(), String> {
    stop()?;
    let _ = recover_stale_healthy_port(cfg)?;
    let _ = recover_owned_port(cfg, "重启前检测到非当前 runtime")?;
    if port_in_use(cfg.port) && !is_healthy(cfg) {
        #[cfg(target_os = "macos")]
        {
            let infos = port_owner_infos(cfg.port)?;
            if infos.iter().all(|info| info.owned_by_edge) {
                eprintln!(
                    "[E-Agent Edge] restart(): 端口 {} 仍被旧 runtime 占用，执行最终强制回收:\n{}",
                    cfg.port,
                    format_port_owner_infos(&infos)
                );
                kill_port_owner(cfg.port)?;
            } else if !infos.is_empty() {
                return Err(format!(
                    "端口 {} 已被其他程序占用，E-Agent Edge 未自动终止该进程。请先关闭占用程序后重试：\n{}",
                    cfg.port,
                    format_port_owner_infos(&infos)
                ));
            }
        }
    }
    if port_in_use(cfg.port) && !is_healthy(cfg) {
        eprintln!(
            "[E-Agent Edge] 端口 {} 仍被占用，请手动停止旧 Web 客户端后重试",
            cfg.port
        );
    }
    ensure_running(cfg, bootstrap)
}

#[cfg(test)]
mod tests {
    use super::{duplicate_owned_port_victims, PortOwnerInfo};

    fn owner(pid: &str, owned_by_edge: bool) -> PortOwnerInfo {
        PortOwnerInfo {
            pid: pid.to_string(),
            command: Some("node".to_string()),
            cwd: None,
            owned_by_edge,
        }
    }

    #[test]
    fn duplicate_cleanup_keeps_tracked_runtime() {
        let infos = vec![owner("100", true), owner("200", true)];
        assert_eq!(duplicate_owned_port_victims(&infos, Some("200")), vec!["100"]);
    }

    #[test]
    fn duplicate_cleanup_reclaims_all_untracked_edge_runtimes() {
        let infos = vec![owner("100", true), owner("200", true)];
        assert_eq!(
            duplicate_owned_port_victims(&infos, None),
            vec!["100", "200"]
        );
    }

    #[test]
    fn duplicate_cleanup_never_kills_mixed_owners() {
        let infos = vec![owner("100", true), owner("200", false)];
        assert!(duplicate_owned_port_victims(&infos, Some("100")).is_empty());
    }
}
