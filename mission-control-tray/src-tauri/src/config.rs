use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub const DEFAULT_CENTER_URL: &str = "https://agent.1sheng.work";
pub const DEFAULT_PORT: u16 = 5101;
pub const DEFAULT_CLIENT_VERSION: &str = "2.1.76";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeConfig {
    pub center_url: String,
    /// 企业分发安装包内置的注册令牌（对应中心 MC_EDGE_ENROLL_TOKEN）
    #[serde(default)]
    pub enroll_token: Option<String>,
    /// 中心桥接 WebSocket 令牌，由 bootstrap 下发；不要与 enroll_token 混用。
    #[serde(default)]
    pub gateway_token: Option<String>,
    #[serde(default)]
    pub manifest_url: Option<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub runtime_version: Option<String>,
    /// 稳定设备 ID（首次生成；bootstrap 后可能被中心派生的 client_id 覆盖）
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub client_name: Option<String>,
    #[serde(default)]
    pub enterprise_name: Option<String>,
    #[serde(default)]
    pub enterprise_slug: Option<String>,
    #[serde(default)]
    pub tenant_id: Option<i64>,
    /// 代理/VPN 自签证书场景：跳过 HTTPS 校验（与浏览器已信任 MITM CA 时等效）
    #[serde(default)]
    pub tls_insecure: Option<bool>,
    /// 用户已在初始化页完成连接配置
    #[serde(default)]
    pub setup_completed: Option<bool>,
}

/// 安装后仅需填写「连接地址 + API 令牌」即视为可启动。
pub fn is_setup_complete(cfg: &EdgeConfig) -> bool {
    has_credentials(cfg)
}

pub fn has_credentials(cfg: &EdgeConfig) -> bool {
    !cfg.center_url.trim().is_empty()
        && cfg
            .enroll_token
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for EdgeConfig {
    fn default() -> Self {
        Self {
            center_url: DEFAULT_CENTER_URL.to_string(),
            enroll_token: None,
            gateway_token: None,
            manifest_url: None,
            port: DEFAULT_PORT,
            runtime_version: None,
            device_id: None,
            client_name: None,
            enterprise_name: None,
            enterprise_slug: None,
            tenant_id: None,
            tls_insecure: None,
            setup_completed: None,
        }
    }
}

pub fn edge_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".e-agent-edge")
}

pub fn config_path() -> PathBuf {
    edge_home().join("config.json")
}

pub fn runtime_root() -> PathBuf {
    edge_home().join("runtime")
}

pub fn data_dir() -> PathBuf {
    edge_home().join("data")
}

pub fn load_config() -> EdgeConfig {
    let path = config_path();
    if !path.exists() {
        return EdgeConfig::default();
    }
    let raw = fs::read_to_string(&path).unwrap_or_default();
    let mut cfg: EdgeConfig = serde_json::from_str(&raw).unwrap_or_default();
    // 兼容旧版：已保存连接信息但未写 setup_completed
    if has_credentials(&cfg) && cfg.setup_completed.is_none() {
        cfg.setup_completed = Some(true);
    }
    cfg
}

pub fn save_config(config: &EdgeConfig) -> Result<(), String> {
    let home = edge_home();
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(config_path(), raw).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn console_url(config: &EdgeConfig) -> String {
    format!("http://127.0.0.1:{}/chat", config.port)
}

pub fn center_web_url(config: &EdgeConfig) -> String {
    config.center_url.trim_end_matches('/').to_string()
}
