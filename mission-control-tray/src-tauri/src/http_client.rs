use crate::config::EdgeConfig;
use reqwest::blocking::Client;
use std::time::Duration;

pub fn tls_insecure_enabled(cfg: &EdgeConfig) -> bool {
    if cfg.tls_insecure == Some(true) {
        return true;
    }
    for key in ["EDGE_TLS_INSECURE", "MC_EDGE_TLS_INSECURE"] {
        if let Ok(v) = std::env::var(key) {
            let t = v.trim();
            if t == "1" || t.eq_ignore_ascii_case("true") {
                return true;
            }
        }
    }
    false
}

pub fn build_http_client(cfg: &EdgeConfig, timeout: Duration) -> Result<Client, String> {
    let mut builder = Client::builder().timeout(timeout);
    if tls_insecure_enabled(cfg) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build().map_err(|e| e.to_string())
}
