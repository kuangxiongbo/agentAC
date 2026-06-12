use crate::bootstrap::CenterBootstrap;
use crate::config::{self, EdgeConfig};
use crate::http_client;
use crate::keep_awake;
use crate::runtime;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

static CHILD: Mutex<Option<Child>> = Mutex::new(None);

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
    let Ok(client) = http_client::build_http_client(cfg, Duration::from_secs(3)) else {
        return false;
    };
    client
        .get(health_probe_url(cfg.port))
        .send()
        .ok()
        .is_some_and(|r| r.status().is_success())
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
        wait_until_healthy(cfg, 40)?;
        return apply_bootstrap_settings_if_needed(cfg, bootstrap);
    }
    if port_in_use(cfg.port) {
        if is_healthy(cfg) {
            eprintln!(
                "[E-Agent Edge] 端口 {} 已有健康服务，沿用现有进程",
                cfg.port
            );
            return apply_bootstrap_settings_if_needed(cfg, bootstrap);
        }
        return Err(format!(
            "端口 {} 已被占用但服务异常（浏览器可能显示 Internal Server Error）。请先执行: cd mission-control-client && pnpm prod:restart --stop，或在托盘菜单选择「重启边缘服务」",
            cfg.port
        ));
    }
    start(cfg, bootstrap)?;
    // 先等 5101 健康，再写入 apply-bootstrap（否则易误报「无法调用 apply-bootstrap」）
    wait_until_healthy(cfg, 40)?;
    apply_bootstrap_settings_if_needed(cfg, bootstrap)
}

fn command_for_node_server(node: &std::path::Path) -> Command {
    #[cfg(target_os = "macos")]
    {
        if keep_awake::keep_awake_enabled() {
            eprintln!("[E-Agent Edge] keep-awake: node wrapped in caffeinate -imsu");
            let mut cmd = Command::new("caffeinate");
            cmd.arg("-imsu").arg(node).arg("server.js");
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
    if port_in_use(cfg.port) {
        if is_healthy(cfg) {
            eprintln!(
                "[E-Agent Edge] 端口 {} 已有健康服务，跳过重复启动",
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

    let child = cmd.spawn().map_err(|e| {
        format!("启动 Node 失败（{}）: {e}", node.display())
    })?;

    *CHILD.lock().unwrap() = Some(child);
    Ok(())
}

pub fn restart(cfg: &EdgeConfig, bootstrap: Option<&CenterBootstrap>) -> Result<(), String> {
    stop()?;
    // 若端口仍被外部进程占用，尝试仅在我们能识别时清理
    if port_in_use(cfg.port) && !is_healthy(cfg) {
        eprintln!(
            "[E-Agent Edge] 端口 {} 仍被占用，请手动停止旧 Web 客户端后重试",
            cfg.port
        );
    }
    ensure_running(cfg, bootstrap)
}
