use crate::config::{self, EdgeConfig};
use crate::http_client;
use crate::runtime::{self, RuntimeManifest};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CenterBootstrap {
    pub schema: u32,
    pub center_url: String,
    pub enterprise: EnterpriseInfo,
    pub client: ClientInfo,
    pub bridge: BridgeInfo,
    pub runtime_manifest: Option<RuntimeManifest>,
    pub settings: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnterpriseInfo {
    pub name: String,
    pub slug: String,
    pub tenant_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub client_id: String,
    pub client_name: String,
    pub hostname: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeInfo {
    pub server_url: String,
    pub token: String,
}

pub fn bootstrap_cache_path() -> PathBuf {
    config::edge_home().join("bootstrap.json")
}

pub fn load_cached_bootstrap() -> Option<CenterBootstrap> {
    let path = bootstrap_cache_path();
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_cached_bootstrap(payload: &CenterBootstrap) -> Result<(), String> {
    let home = config::edge_home();
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    fs::write(bootstrap_cache_path(), raw).map_err(|e| e.to_string())
}

pub fn os_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "edge-client".to_string())
}

pub fn ensure_device_id(cfg: &mut EdgeConfig) -> String {
    if let Some(id) = cfg.device_id.as_ref().filter(|s| !s.is_empty()) {
        return id.clone();
    }
    let id = uuid::Uuid::new_v4().to_string();
    cfg.device_id = Some(id.clone());
    let _ = config::save_config(cfg);
    id
}

#[derive(Debug, Deserialize)]
struct LocalTrayConfig {
    center_url: Option<String>,
    enroll_token: Option<String>,
    gateway_token: Option<String>,
    client_name: Option<String>,
    #[allow(dead_code)]
    device_client_id: Option<String>,
    enterprise_name: Option<String>,
    tenant_id: Option<i64>,
    port: Option<u16>,
}

/// Read gateway / enroll settings from local Web client (5101) when already configured.
pub fn import_from_local_client(cfg: &mut EdgeConfig, port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/api/edge/tray-config");
    let client = match http_client::build_http_client(cfg, Duration::from_secs(4)) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let resp = match client.get(&url).send() {
        Ok(r) if r.status().is_success() => r,
        _ => return false,
    };
    let local: LocalTrayConfig = match resp.json() {
        Ok(v) => v,
        Err(_) => return false,
    };

    let mut changed = false;
    if let Some(url) = local.center_url.filter(|s| !s.trim().is_empty()) {
        cfg.center_url = url.trim().to_string();
        changed = true;
    }
    if let Some(token) = local.enroll_token.filter(|s| !s.trim().is_empty()) {
        cfg.enroll_token = Some(token.trim().to_string());
        changed = true;
    }
    if let Some(token) = local.gateway_token.filter(|s| !s.trim().is_empty()) {
        cfg.gateway_token = Some(token.trim().to_string());
        changed = true;
    }
    if let Some(name) = local.client_name.filter(|s| !s.trim().is_empty()) {
        cfg.client_name = Some(name.trim().to_string());
        changed = true;
    }
    if let Some(name) = local.enterprise_name.filter(|s| !s.trim().is_empty()) {
        cfg.enterprise_name = Some(name.trim().to_string());
        changed = true;
    }
    if let Some(tenant_id) = local.tenant_id {
        cfg.tenant_id = Some(tenant_id);
        changed = true;
    }
    if let Some(p) = local.port {
        cfg.port = p;
        changed = true;
    }
    if changed {
        let _ = config::save_config(cfg);
    }
    changed
}

pub fn resolve_enroll_token(cfg: &EdgeConfig) -> Result<String, String> {
    if let Some(token) = cfg.enroll_token.as_ref().filter(|s| !s.trim().is_empty()) {
        return Ok(token.trim().to_string());
    }
    if let Ok(token) = std::env::var("EDGE_ENROLL_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    Err(
        "未配置企业注册令牌。请在 Web 设置填写「边缘注册令牌」或「网关 API 令牌」，或配置 ~/.e-agent-edge/config.json"
            .to_string(),
    )
}

fn fetch_bootstrap_via_web_client(
    cfg: &EdgeConfig,
    hostname: &str,
    device_id: &str,
) -> Result<CenterBootstrap, String> {
    let url = format!(
        "http://127.0.0.1:{}/api/edge/proxy-bootstrap?hostname={}&device_id={}",
        cfg.port,
        urlencoding::encode(hostname),
        urlencoding::encode(device_id)
    );
    let client = http_client::build_http_client(cfg, Duration::from_secs(90))?;
    let resp = client.get(&url).send().map_err(|e| {
        format!("无法通过 Web 客户端 (5101) 转发 bootstrap: {e}（请先启动 pnpm prod / standalone）")
    })?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Web 客户端转发 bootstrap 失败 HTTP {status}: {}",
            body.chars().take(240).collect::<String>()
        ));
    }
    if body.trim_start().starts_with('<') {
        return Err(
            "5101 返回 HTML 而非 JSON，请先重启 Web 客户端: cd mission-control-client && pnpm prod:restart"
                .to_string(),
        );
    }
    serde_json::from_str(&body).map_err(|e| format!("Web 客户端 bootstrap JSON 无效: {e}"))
}

fn local_web_client_available(cfg: &EdgeConfig) -> bool {
    let url = format!("http://127.0.0.1:{}/api/status?action=health", cfg.port);
    let client = match http_client::build_http_client(cfg, Duration::from_secs(2)) {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(&url)
        .send()
        .map(|resp| resp.status().is_success())
        .unwrap_or(false)
}

pub fn fetch_center_bootstrap(cfg: &EdgeConfig) -> Result<CenterBootstrap, String> {
    let device_id = cfg
        .device_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let hostname = os_hostname();

    if local_web_client_available(cfg) {
        match fetch_bootstrap_via_web_client(cfg, &hostname, &device_id) {
            Ok(payload) => {
                eprintln!("[E-Agent Edge] 已通过 Web 客户端 (5101) 连接通道获取 bootstrap");
                return Ok(payload);
            }
            Err(e) => eprintln!("[E-Agent Edge] Web 通道 bootstrap 不可用: {e}"),
        }
    } else {
        eprintln!("[E-Agent Edge] 本机 Web 客户端未运行，直接连接服务中心 bootstrap");
    }

    let enroll = resolve_enroll_token(cfg)?;
    let base = cfg.center_url.trim_end_matches('/');
    let url = format!(
        "{base}/api/edge/bootstrap?hostname={}&device_id={}",
        urlencoding::encode(&hostname),
        urlencoding::encode(&device_id)
    );

    let client =
        http_client::build_http_client(cfg, Duration::from_secs(90))?;

    let resp = client
        .get(&url)
        .header("x-edge-enroll-token", &enroll)
        .send()
        .map_err(|e| {
            let hint = if http_client::tls_insecure_enabled(cfg) {
                String::new()
            } else {
                "（若使用代理/VPN 自签证书，请在 config.json 设 \"tls_insecure\": true）".to_string()
            };
            format!("无法连接服务中心 ({base}): {e}{hint}")
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        return Err(format!(
            "服务中心 bootstrap 失败 HTTP {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }

    let payload: CenterBootstrap = resp
        .json()
        .map_err(|e| format!("bootstrap JSON 无效: {e}"))?;

    Ok(payload)
}

pub fn merge_config_from_bootstrap(cfg: &mut EdgeConfig, payload: &CenterBootstrap) {
    cfg.center_url = payload.center_url.clone();
    if !payload.bridge.token.trim().is_empty() {
        cfg.gateway_token = Some(payload.bridge.token.trim().to_string());
    }
    cfg.client_name = Some(payload.client.client_name.clone());
    cfg.enterprise_name = Some(payload.enterprise.name.clone());
    cfg.enterprise_slug = Some(payload.enterprise.slug.clone());
    cfg.tenant_id = payload.enterprise.tenant_id;
    if !runtime::has_explicit_manifest_url(cfg) {
        if let Some(version) = payload.runtime_manifest.as_ref().map(|m| m.client_version.clone()) {
            cfg.runtime_version = Some(version);
        }
    }
}

fn local_bootstrap_fallback(cfg: &EdgeConfig) -> Result<CenterBootstrap, String> {
    let enroll = resolve_enroll_token(cfg)?;
    let center_url = cfg.center_url.trim_end_matches('/').to_string();
    let hostname = os_hostname();
    let client_name = cfg
        .client_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(hostname.clone());
    let client_id = cfg
        .device_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("mc-edge-{}", &uuid::Uuid::new_v4().to_string()[..12]));

    let mut settings = std::collections::HashMap::new();
    settings.insert("gateway.server_url".to_string(), center_url.clone());
    settings.insert(
        "gateway.token".to_string(),
        cfg.gateway_token.clone().filter(|s| !s.trim().is_empty()).unwrap_or(enroll.clone()),
    );
    settings.insert("edge.enroll_token".to_string(), enroll.clone());
    settings.insert("gateway.client_name".to_string(), client_name.clone());
    settings.insert("device.client_id".to_string(), client_id.clone());
    settings.insert("general.server_gateway_sync".to_string(), "true".to_string());
    if let Some(name) = &cfg.enterprise_name {
        settings.insert("edge.enterprise_name".to_string(), name.clone());
    }
    if let Some(slug) = &cfg.enterprise_slug {
        settings.insert("edge.enterprise_slug".to_string(), slug.clone());
    }
    if let Some(tenant_id) = cfg.tenant_id {
        settings.insert("edge.tenant_id".to_string(), tenant_id.to_string());
    }

    Ok(CenterBootstrap {
        schema: 1,
        center_url: center_url.clone(),
        enterprise: EnterpriseInfo {
            name: cfg
                .enterprise_name
                .clone()
                .unwrap_or_else(|| "E-Agent Enterprise".to_string()),
            slug: cfg
                .enterprise_slug
                .clone()
                .unwrap_or_else(|| "default".to_string()),
            tenant_id: None,
        },
        client: ClientInfo {
            client_id,
            client_name: client_name.clone(),
            hostname,
        },
        bridge: BridgeInfo {
            server_url: center_url.clone(),
            token: enroll,
        },
        runtime_manifest: None,
        settings,
    })
}

pub fn apply_tray_bootstrap(cfg: &EdgeConfig) -> Result<CenterBootstrap, String> {
    let mut working = cfg.clone();
    let port = working.port;
    import_from_local_client(&mut working, port);
    working.device_id = Some(ensure_device_id(&mut working));
    let payload = match fetch_center_bootstrap(&working) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[E-Agent Edge] 中心 bootstrap 不可用 ({e})，使用本地 5101 配置");
            local_bootstrap_fallback(&working)?
        }
    };
    merge_config_from_bootstrap(&mut working, &payload);
    let enroll = resolve_enroll_token(&working)?;
    working.enroll_token = Some(enroll);
    let _ = config::save_config(&working);
    save_cached_bootstrap(&payload)?;
    if !runtime::has_explicit_manifest_url(&working) {
        if let Some(manifest) = &payload.runtime_manifest {
            runtime::set_cached_manifest(manifest.clone());
        }
    }
    Ok(payload)
}

/// Push tray credentials into 5101 settings when the local Web client is already up.
pub fn push_tray_credentials_to_local(cfg: &EdgeConfig) -> Result<(), String> {
    let enroll_token = resolve_enroll_token(cfg)?;
    let center_url = cfg.center_url.trim_end_matches('/').to_string();
    if center_url.is_empty() {
        return Ok(());
    }
    let mut settings = std::collections::HashMap::new();
    settings.insert("gateway.server_url".to_string(), center_url);
    settings.insert("edge.enroll_token".to_string(), enroll_token.clone());
    settings.insert(
        "gateway.token".to_string(),
        cfg.gateway_token
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(enroll_token),
    );
    if let Some(name) = cfg
        .client_name
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        settings.insert("gateway.client_name".to_string(), name.trim().to_string());
    }
    if let Some(name) = cfg
        .enterprise_name
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        settings.insert("edge.enterprise_name".to_string(), name.trim().to_string());
    }
    if let Some(slug) = cfg
        .enterprise_slug
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        settings.insert("edge.enterprise_slug".to_string(), slug.trim().to_string());
    }
    if let Some(tenant_id) = cfg.tenant_id {
        settings.insert("edge.tenant_id".to_string(), tenant_id.to_string());
    }
    wait_and_apply_local_settings(cfg.port, &settings)
}

pub fn wait_and_apply_local_settings(port: u16, settings: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/api/edge/apply-bootstrap");
    let body = serde_json::json!({
        "settings": settings,
        "reconnect_bridge": true
    });
    let cfg = config::load_config();
    let client = http_client::build_http_client(&cfg, Duration::from_secs(15))?;

    for attempt in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(if attempt == 0 { 500 } else { 750 }));
        let resp = client
            .post(&url)
            .header("x-edge-tray", "1")
            .json(&body)
            .send();
        match resp {
            Ok(r) if r.status().is_success() => return Ok(()),
            Ok(r) => {
                let status = r.status();
                let text = r.text().unwrap_or_default();
                if status.as_u16() == 403 && attempt < 39 {
                    continue;
                }
                return Err(format!("应用本地配置失败 HTTP {status}: {text}"));
            }
            Err(e) if attempt < 39 => {
                let _ = e;
                continue;
            }
            Err(e) => {
                let log = config::edge_home().join("logs/node-server.log");
                return Err(format!(
                    "5101 未响应，无法写入连接配置（{e}）。若刚重装 runtime 仍失败，请查看 {log}",
                    log = log.display()
                ));
            }
        }
    }
    Err(format!(
        "本地边缘服务 (127.0.0.1:{port}) 启动超时。请删除损坏的 runtime 后重试: rm -rf ~/.e-agent-edge/runtime",
        port = port
    ))
}
