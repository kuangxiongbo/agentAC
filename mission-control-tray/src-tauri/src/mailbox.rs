use crate::config::EdgeConfig;
use crate::http_client;
use std::time::Duration;

#[derive(Debug, serde::Deserialize, Default)]
pub struct MailboxCount {
    #[serde(default)]
    pub pending: u64,
    #[serde(default)]
    pub processing: u64,
    #[serde(default)]
    pub completed: u64,
    #[serde(default)]
    pub failed: u64,
    #[serde(default)]
    pub sent: u64,
}

#[derive(Debug, serde::Deserialize, Default)]
pub struct MailboxStatus {
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub inbox: MailboxCount,
    #[serde(default)]
    pub outbox: MailboxCount,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, serde::Deserialize, Default)]
pub struct MailboxDrainResult {
    #[serde(default)]
    pub pulled: u64,
    #[serde(default)]
    pub executed: u64,
    #[serde(default)]
    pub failed: u64,
    #[serde(default)]
    pub outbox_sent: u64,
    #[serde(default)]
    pub outbox_failed: u64,
    #[serde(default)]
    pub pull_error: Option<String>,
}

fn local_api_url(cfg: &EdgeConfig, path: &str) -> String {
    format!(
        "http://127.0.0.1:{}{}",
        cfg.port,
        if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        }
    )
}

pub fn fetch_status(cfg: &EdgeConfig) -> Result<MailboxStatus, String> {
    let client = http_client::build_http_client(cfg, Duration::from_secs(5))?;
    let resp = client
        .get(local_api_url(cfg, "/api/local/mailbox/status"))
        .send()
        .map_err(|e| format!("读取消息队列状态失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("读取消息队列状态失败: HTTP {}", resp.status()));
    }
    resp.json::<MailboxStatus>()
        .map_err(|e| format!("解析消息队列状态失败: {e}"))
}

pub fn drain(cfg: &EdgeConfig) -> Result<MailboxDrainResult, String> {
    let client = http_client::build_http_client(cfg, Duration::from_secs(30))?;
    let resp = client
        .post(local_api_url(cfg, "/api/local/mailbox/drain"))
        .send()
        .map_err(|e| format!("处理消息队列失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("处理消息队列失败: HTTP {}", resp.status()));
    }
    resp.json::<MailboxDrainResult>()
        .map_err(|e| format!("解析消息队列处理结果失败: {e}"))
}

pub fn summarize_status(status: &MailboxStatus) -> String {
    let mut text = format!(
        "消息队列：inbox pending {} / failed {}，outbox pending {} / failed {}",
        status.inbox.pending, status.inbox.failed, status.outbox.pending, status.outbox.failed
    );
    if !status.client_id.trim().is_empty() {
        text.push_str(&format!("，client {}", status.client_id));
    }
    if let Some(err) = status.last_error.as_deref().filter(|s| !s.trim().is_empty()) {
        text.push_str(&format!("，最近错误: {err}"));
    }
    text
}

pub fn summarize_drain(result: &MailboxDrainResult) -> String {
    let mut text = format!(
        "消息队列处理完成：拉取 {}，执行 {}，失败 {}，回传 {}，回传失败 {}",
        result.pulled, result.executed, result.failed, result.outbox_sent, result.outbox_failed
    );
    if let Some(err) = result.pull_error.as_deref().filter(|s| !s.trim().is_empty()) {
        text.push_str(&format!("，拉取错误: {err}"));
    }
    text
}
