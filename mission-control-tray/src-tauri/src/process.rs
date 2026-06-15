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
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn node_binary() -> Result<PathBuf, String> {
    crate::node_path::resolve_node_binary()
}

fn port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
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

fn kill_port_owner(port: u16) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let current_pid = std::process::id().to_string();
        let pids: Vec<String> = lsof_port_pids(port)
            .or_else(|err| {
                eprintln!("[E-Agent Edge] {err}，改用 netstat 兜底查询");
                netstat_port_pids(port)
            })?
            .into_iter()
            .filter(|pid| !pid.is_empty() && *pid != current_pid)
            .collect();
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
    if port_in_use(cfg.port) {
        if is_current_runtime_healthy(cfg) {
            eprintln!(
                "[E-Agent Edge] 端口 {} 已有当前版本健康服务，沿用现有进程",
                cfg.port
            );
            return apply_bootstrap_settings_if_needed(cfg, bootstrap);
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
        if recover_stale_healthy_port(cfg)? {
            start(cfg, bootstrap)?;
            wait_until_current_runtime_healthy(cfg, 40)?;
        } else {
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
    if is_running() {
        return Ok(());
    }
    let _ = recover_stale_healthy_port(cfg)?;
    if port_in_use(cfg.port) {
        if is_current_runtime_healthy(cfg) {
            eprintln!(
                "[E-Agent Edge] 端口 {} 已有当前版本健康服务，跳过重复启动",
                cfg.port
            );
            return Ok(());
        }
        eprintln!(
            "[E-Agent Edge] 端口 {} 已被占用（多为 pnpm prod:restart）。请先执行: cd mission-control-client && pnpm prod:restart --stop，或停止占用该端口的进程后重试托盘。",
            cfg.port
        );
        return Err(format!(
            "端口 {} 已被占用，请先停止本机 Web 客户端（pnpm prod:restart --stop）再连接",
            cfg.port
        ));
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
    if port_in_use(cfg.port) && !is_healthy(cfg) {
        eprintln!(
            "[E-Agent Edge] 端口 {} 仍被占用，请手动停止旧 Web 客户端后重试",
            cfg.port
        );
    }
    ensure_running(cfg, bootstrap)
}
