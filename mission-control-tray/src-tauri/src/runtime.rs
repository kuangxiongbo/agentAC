use crate::config::{self, EdgeConfig, DEFAULT_CLIENT_VERSION};
use crate::bootstrap;
use crate::http_client;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

static CACHED_MANIFEST: Mutex<Option<RuntimeManifest>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeManifest {
    pub schema: u32,
    pub client_version: String,
    #[serde(default)]
    pub tray_min_version: Option<String>,
    pub platforms: std::collections::HashMap<String, PlatformArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformArtifact {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RuntimeProgress {
    pub phase: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
}

impl RuntimeProgress {
    fn new(phase: &str, message: impl Into<String>) -> Self {
        Self {
            phase: phase.to_string(),
            message: message.into(),
            progress: None,
            detail: None,
            downloaded_bytes: None,
            total_bytes: None,
        }
    }

    fn with_progress(mut self, progress: u8) -> Self {
        self.progress = Some(progress.min(100));
        self
    }

    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    fn with_bytes(mut self, downloaded: u64, total: Option<u64>) -> Self {
        self.downloaded_bytes = Some(downloaded);
        self.total_bytes = total;
        self
    }
}

fn format_bytes(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / MB)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

pub fn platform_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "darwin-aarch64";
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return "darwin-x86_64";
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return "windows-x86_64";
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return "linux-x86_64";
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
    )))]
    compile_error!("unsupported platform for edge runtime");
}

/// Standalone copy from 5101: `~/.e-agent-edge/runtime/server.js`.
/// Zip install: `~/.e-agent-edge/runtime/runtime/server.js`.
pub fn resolve_server_js() -> Option<PathBuf> {
    let root = config::runtime_root();
    let flat = root.join("server.js");
    if flat.is_file() {
        return Some(flat);
    }
    let nested = root.join("runtime").join("server.js");
    if nested.is_file() {
        return Some(nested);
    }
    None
}

pub fn installed_version() -> Option<String> {
    let server_js = resolve_server_js()?;
    let runtime_dir = server_js.parent()?;
    if let Some(version) = package_json_version(runtime_dir) {
        return Some(version);
    }
    if let Some(version) = version_file_value(&runtime_dir.join("VERSION")) {
        return Some(version);
    }
    if let Some(version) = version_file_value(&config::runtime_root().join("VERSION")) {
        return Some(version);
    }
    Some("local".to_string())
}

pub fn server_js_path() -> PathBuf {
    resolve_server_js().unwrap_or_else(|| config::runtime_root().join("runtime").join("server.js"))
}

/// `server.js` 存在且 Next 依赖可解析（pnpm 符号链接被破坏时视为损坏）。
pub fn is_runtime_usable() -> bool {
    let Some(server_js) = resolve_server_js() else {
        return false;
    };
    let Some(root) = server_js.parent() else {
        return false;
    };
    next_module_resolvable(root)
        && runtime_require_hook_resolvable(root)
        && runtime_static_assets_present(root)
        && next_compiled_runtime_present(root)
}

fn version_file_value(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let v = fs::read_to_string(path).ok()?.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn package_json_version(runtime_dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(runtime_dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let version = json.get("version")?.as_str()?.trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn runtime_static_assets_present(runtime_dir: &Path) -> bool {
    let chunks = runtime_dir.join(".next/static/chunks");
    if !chunks.is_dir() {
        return false;
    }
    let Ok(entries) = fs::read_dir(&chunks) else {
        return false;
    };
    let mut has_js = false;
    let mut has_css = false;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        match path.extension().and_then(|s| s.to_str()) {
            Some("js") => has_js = true,
            Some("css") => has_css = true,
            _ => {}
        }
        if has_js && has_css {
            return true;
        }
    }
    false
}

fn next_compiled_runtime_present(runtime_dir: &Path) -> bool {
    runtime_dir
        .join("node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js")
        .is_file()
}

fn validate_installed_runtime(target_version: &str) -> Result<PathBuf, String> {
    let server_js = resolve_server_js().ok_or_else(|| "runtime 缺少 server.js".to_string())?;
    let runtime_dir = server_js
        .parent()
        .ok_or_else(|| "无法识别 runtime 目录".to_string())?
        .to_path_buf();
    if !next_module_resolvable(&runtime_dir) {
        return Err("runtime 缺少 Next 运行依赖".to_string());
    }
    if !runtime_require_hook_resolvable(&runtime_dir) {
        return Err("runtime 缺少 Next require-hook 依赖".to_string());
    }
    if !runtime_static_assets_present(&runtime_dir) {
        return Err("runtime 缺少 .next/static/chunks 静态资源".to_string());
    }
    if !next_compiled_runtime_present(&runtime_dir) {
        return Err("runtime 缺少 Next app-route turbo 运行时".to_string());
    }
    if let Some(version) = package_json_version(&runtime_dir) {
        if version != target_version {
            return Err(format!(
                "runtime package.json 版本不一致: 当前 {version}，目标 {target_version}"
            ));
        }
    }
    Ok(runtime_dir)
}

fn runtime_require_hook_resolvable(runtime_dir: &Path) -> bool {
    let hook = runtime_dir.join("node_modules/next/dist/server/require-hook.js");
    if !hook.is_file() {
        return false;
    }
    let styled = runtime_dir.join("node_modules/styled-jsx/package.json");
    if path_resolves_to_existing_file(&styled) {
        return true;
    }
    // pnpm: styled-jsx may live under .pnpm while next stays a symlink
    let pnpm_store = runtime_dir.join("node_modules/.pnpm");
    if !pnpm_store.is_dir() {
        return false;
    }
    walkdir_styled_jsx(&pnpm_store).is_some()
}

fn walkdir_styled_jsx(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let lossy = path.to_string_lossy();
        if lossy.ends_with("styled-jsx/package.json") && path.is_file() {
            return Some(path);
        }
        if entry.file_type().ok()?.is_dir() {
            if let Some(found) = walkdir_styled_jsx(&path) {
                return Some(found);
            }
        }
    }
    None
}

fn next_module_resolvable(runtime_dir: &Path) -> bool {
    let next_pkg = runtime_dir.join("node_modules/next/package.json");
    let next_dir = runtime_dir.join("node_modules/next");
    path_resolves_to_existing_file(&next_pkg) || path_resolves_to_existing_file(&next_dir)
}

fn path_resolves_to_existing_file(path: &Path) -> bool {
    if path.is_file() {
        return true;
    }
    if path.is_symlink() {
        if let Ok(target) = fs::read_link(path) {
            let resolved = if target.is_absolute() {
                target
            } else {
                path.parent()
                    .unwrap_or(Path::new("."))
                    .join(target)
            };
            return resolved.is_file() || resolved.is_dir();
        }
        return false;
    }
    path.is_file()
}

/// 补齐 Next standalone 顶层 peer 依赖链接（zip 解压或 copy 可能缺失 styled-jsx 等）。
fn repair_runtime_peer_links(runtime_dir: &Path) -> Result<(), String> {
    let nm = runtime_dir.join("node_modules");
    if !nm.is_dir() {
        return Ok(());
    }
    for pkg in ["styled-jsx", "@swc/helpers", "@next/env"] {
        let link_path = nm.join(pkg);
        let pkg_json = link_path.join("package.json");
        if path_resolves_to_existing_file(&pkg_json) {
            continue;
        }
        let Some(target_dir) = find_pnpm_package_dir(&nm, pkg) else {
            continue;
        };
        let rel = target_dir
            .strip_prefix(&nm)
            .map_err(|_| format!("无法计算 {pkg} 相对路径"))?;
        if let Some(parent) = link_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if link_path.exists() || link_path.is_symlink() {
            fs::remove_file(&link_path).ok();
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(rel, &link_path).map_err(|e| {
                format!("创建 {pkg} 符号链接失败: {e}")
            })?;
        }
        #[cfg(not(unix))]
        {
            copy_dir_recursive(&target_dir, &link_path)?;
        }
    }
    Ok(())
}

fn find_pnpm_package_dir(nm: &Path, pkg: &str) -> Option<PathBuf> {
    let store = nm.join(".pnpm");
    if !store.is_dir() {
        return None;
    }
    find_pnpm_package_dir_inner(&store, pkg)
}

fn find_pnpm_package_dir_inner(dir: &Path, pkg: &str) -> Option<PathBuf> {
    let needle = format!("node_modules/{pkg}/package.json");
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let lossy = path.to_string_lossy();
        if lossy.ends_with(&needle) && path.is_file() {
            return path.parent().map(|p| p.to_path_buf());
        }
        if entry.file_type().ok()?.is_dir() {
            if let Some(found) = find_pnpm_package_dir_inner(&path, pkg) {
                return Some(found);
            }
        }
    }
    None
}

pub fn has_explicit_manifest_url(cfg: &EdgeConfig) -> bool {
    if let Some(url) = &cfg.manifest_url {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return true;
        }
    }
    if let Ok(url) = std::env::var("EDGE_RUNTIME_MANIFEST_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return true;
        }
    }
    false
}

fn resolve_manifest_url(cfg: &EdgeConfig) -> String {
    if let Some(url) = &cfg.manifest_url {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(url) = std::env::var("EDGE_RUNTIME_MANIFEST_URL") {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    format!(
        "{}/api/releases/edge-runtime-manifest",
        cfg.center_url.trim_end_matches('/')
    )
}

fn manifest_base_url(cfg: &EdgeConfig) -> String {
    let manifest_url = resolve_manifest_url(cfg);
    if let Some((base, _)) = manifest_url.rsplit_once('/') {
        return base.to_string();
    }
    cfg.center_url.trim_end_matches('/').to_string()
}

fn resolve_artifact_url(cfg: &EdgeConfig, artifact_url: &str) -> String {
    let trimmed = artifact_url.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    if trimmed.starts_with('/') {
        let manifest_url = resolve_manifest_url(cfg);
        if let Some(rest) = manifest_url.strip_prefix("http://") {
            if let Some((host, _)) = rest.split_once('/') {
                return format!("http://{host}{trimmed}");
            }
        }
        if let Some(rest) = manifest_url.strip_prefix("https://") {
            if let Some((host, _)) = rest.split_once('/') {
                return format!("https://{host}{trimmed}");
            }
        }
        return format!("{}{}", cfg.center_url.trim_end_matches('/'), trimmed);
    }
    format!("{}/{}", manifest_base_url(cfg).trim_end_matches('/'), trimmed)
}

pub fn set_cached_manifest(manifest: RuntimeManifest) {
    if let Ok(mut guard) = CACHED_MANIFEST.lock() {
        *guard = Some(manifest);
    }
}

pub fn clear_cached_manifest() {
    if let Ok(mut guard) = CACHED_MANIFEST.lock() {
        *guard = None;
    }
}

pub fn fetch_manifest(cfg: &EdgeConfig) -> Result<RuntimeManifest, String> {
    let explicit_manifest = has_explicit_manifest_url(cfg);
    if !explicit_manifest {
        if let Ok(guard) = CACHED_MANIFEST.lock() {
            if let Some(m) = guard.as_ref() {
                return Ok(m.clone());
            }
        }
    }
    if !explicit_manifest {
        if let Ok(m) = fetch_manifest_via_web_client(cfg) {
            set_cached_manifest(m.clone());
            return Ok(m);
        }
    }
    let url = resolve_manifest_url(cfg);
    let client = http_client::build_http_client(cfg, Duration::from_secs(60))?;
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("无法拉取 runtime 清单 ({url}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let hint = if status.as_u16() == 503 {
            " — 服务中心未配置 Edge runtime 发布清单（需设置 EDGE_RUNTIME_MANIFEST_PATH）。开发机可先执行: cd mission-control-client && pnpm build"
        } else {
            ""
        };
        return Err(format!("runtime 清单 HTTP {status} ({url}){hint}", url = url));
    }
    match resp.json::<RuntimeManifest>() {
        Ok(m) => {
        set_cached_manifest(m.clone());
            Ok(m)
        }
        Err(e) => Err(format!("runtime 清单 JSON 无效: {e}")),
    }
    .or_else(|err| {
        if explicit_manifest {
            return Err(err);
        }
        if let Some(cached) = bootstrap::load_cached_bootstrap() {
            if let Some(m) = cached.runtime_manifest {
                eprintln!(
                    "[E-Agent Edge] 在线 runtime 清单不可用（{err}），使用 bootstrap 缓存 {}",
                    m.client_version
                );
                set_cached_manifest(m.clone());
                return Ok(m);
            }
        }
        Err(err)
    })
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn download_and_install(cfg: &EdgeConfig, force: bool) -> Result<String, String> {
    download_and_install_with_progress(cfg, force, |_| {})
}

pub fn download_and_install_with_progress<F>(
    cfg: &EdgeConfig,
    force: bool,
    mut on_progress: F,
) -> Result<String, String>
where
    F: FnMut(RuntimeProgress),
{
    on_progress(RuntimeProgress::new(
        "runtime",
        "正在获取本机 Web 客户端版本清单…",
    ));
    let installed = installed_version();
    let manifest = fetch_manifest(cfg)?;

    let key = platform_key();
    let artifact = manifest
        .platforms
        .get(key)
        .ok_or_else(|| format!("清单中无当前平台 {key}"))?;

    let target_version = manifest.client_version.clone();

    if !force {
        if let Some(cur) = &installed {
            if cur == &target_version {
                on_progress(RuntimeProgress::new(
                    "runtime",
                    format!("本机 Web 客户端已是最新版本 {cur}"),
                ));
                return Ok(format!("runtime 已是最新 {cur}"));
            }
        }
    }

    let home = config::edge_home();
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let zip_path = home.join(format!("client-runtime-{target_version}-{key}.zip.download"));
    let extract_parent = home.join(format!("staging-{target_version}-{key}"));

    // Note: do NOT delete an existing partial .zip.download here — download_file_with_progress
    // resumes from it (HTTP Range) when present, instead of restarting from byte 0.
    let artifact_url = resolve_artifact_url(cfg, &artifact.url);
    on_progress(
        RuntimeProgress::new(
            "runtime",
            format!("发现新版本 {target_version}，正在下载安装包…"),
        )
        .with_progress(0),
    );
    download_file_with_progress(cfg, &artifact_url, &zip_path, |progress| {
        on_progress(progress)
    })?;
    on_progress(
        RuntimeProgress::new("runtime", "正在校验安装包完整性…")
            .with_progress(100)
            .with_detail("正在计算 SHA256"),
    );
    let digest = sha256_file(&zip_path)?;
    let expected = artifact.sha256.trim().to_lowercase();
    if !expected.is_empty() && digest != expected {
        let size = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
        let _ = fs::remove_file(&zip_path);
        let hint = if size < 4096 {
            "（下载内容过小，可能被重定向到登录页；请确认服务中心已放行 /edge-runtime/ 静态路径）"
        } else {
            ""
        };
        return Err(format!(
            "SHA256 校验失败: 期望 {expected}, 实际 {digest}{hint}"
        ));
    }

    if extract_parent.exists() {
        fs::remove_dir_all(&extract_parent).map_err(|e| e.to_string())?;
    }
    on_progress(RuntimeProgress::new("runtime", "正在解压本机 Web 客户端…"));
    extract_zip(&zip_path, &extract_parent)?;

    let bundle_root = find_bundle_root(&extract_parent)?;
    let runtime_dest = config::runtime_root();
    on_progress(RuntimeProgress::new("runtime", "正在替换本地运行环境…"));
    if runtime_dest.exists() {
        fs::remove_dir_all(&runtime_dest).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(runtime_dest.parent().unwrap()).map_err(|e| e.to_string())?;
    copy_tree_preserve_symlinks(&bundle_root, &runtime_dest)?;
    if let Some(server_js) = resolve_server_js() {
        if let Some(root) = server_js.parent() {
            on_progress(RuntimeProgress::new("runtime", "正在修复运行依赖链接…"));
            repair_runtime_peer_links(root)?;
        }
    }

    on_progress(RuntimeProgress::new("runtime", "正在验证本地运行环境…"));
    let installed_runtime_dir = validate_installed_runtime(&target_version)?;
    fs::write(runtime_dest.join("VERSION"), format!("{target_version}\n"))
        .map_err(|e| e.to_string())?;
    fs::write(
        installed_runtime_dir.join("VERSION"),
        format!("{target_version}\n"),
    )
    .map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&zip_path);
    let _ = fs::remove_dir_all(&extract_parent);

    let mut saved = cfg.clone();
    saved.runtime_version = Some(target_version.clone());
    config::save_config(&saved)?;

    on_progress(RuntimeProgress::new(
        "runtime",
        format!("本机 Web 客户端 {target_version} 已安装"),
    ));
    Ok(format!("已安装 runtime {target_version} ({key})"))
}

const DOWNLOAD_MAX_ATTEMPTS: u32 = 5;

/// Resumable download with truncation detection and bounded retries.
/// Resumes from an existing partial file via HTTP Range when the server supports it
/// (falls back to a full restart when it doesn't, or when the partial is stale/oversized).
fn download_file_with_progress<F>(
    cfg: &EdgeConfig,
    url: &str,
    dest: &Path,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(RuntimeProgress),
{
    let mut last_err: Option<String> = None;
    for attempt in 1..=DOWNLOAD_MAX_ATTEMPTS {
        match download_file_attempt(cfg, url, dest, attempt, DOWNLOAD_MAX_ATTEMPTS, &mut on_progress) {
            Ok(()) => return Ok(()),
            Err(e) => {
                eprintln!(
                    "[E-Agent Edge] 下载尝试 {attempt}/{DOWNLOAD_MAX_ATTEMPTS} 失败: {e}"
                );
                last_err = Some(e);
                if attempt < DOWNLOAD_MAX_ATTEMPTS {
                    std::thread::sleep(Duration::from_secs((2 * attempt).min(10) as u64));
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "下载失败".to_string()))
}

fn download_file_attempt<F>(
    cfg: &EdgeConfig,
    url: &str,
    dest: &Path,
    attempt: u32,
    max_attempts: u32,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(RuntimeProgress),
{
    let client = http_client::build_http_client(cfg, Duration::from_secs(600))?;
    let existing_len = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);

    let mut req = client.get(url);
    if existing_len > 0 {
        req = req.header("Range", format!("bytes={existing_len}-"));
    }
    let mut resp = req.send().map_err(|e| format!("下载失败 ({url}): {e}"))?;
    let status = resp.status();

    // Range not satisfiable: local partial is stale/oversized relative to the server's
    // copy. Drop it and retry fresh on the next attempt.
    if existing_len > 0 && status.as_u16() == 416 {
        let _ = fs::remove_file(dest);
        return Err("本地分片文件与服务器不匹配（416），已清除，将重新下载".to_string());
    }

    let resumed = existing_len > 0 && status.as_u16() == 206;
    if existing_len > 0 && !resumed && !status.is_success() {
        return Err(format!("下载 HTTP {status} ({url})"));
    }
    if existing_len == 0 && !status.is_success() {
        return Err(format!("下载 HTTP {status} ({url})"));
    }

    let mut out = if resumed {
        fs::OpenOptions::new()
            .append(true)
            .open(dest)
            .map_err(|e| e.to_string())?
    } else {
        // Fresh download, or server ignored Range (200) — (re)write from byte 0.
        File::create(dest).map_err(|e| e.to_string())?
    };
    let mut downloaded = if resumed { existing_len } else { 0u64 };
    let body_len = resp.content_length();
    let total = if resumed {
        body_len.map(|b| b + existing_len)
    } else {
        body_len
    };

    if attempt > 1 {
        eprintln!(
            "[E-Agent Edge] 下载{}（第 {attempt}/{max_attempts} 次尝试，已有 {}）",
            if resumed { "续传" } else { "重试" },
            format_bytes(downloaded)
        );
    }

    let mut buf = [0u8; 65536];
    let mut last_percent: Option<u8> = None;
    let mut last_emit = Instant::now();
    loop {
        let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        let percent = total
            .filter(|t| *t > 0)
            .map(|t| ((downloaded.saturating_mul(100) / t).min(100)) as u8);
        let should_emit = percent != last_percent
            || last_emit.elapsed() >= Duration::from_millis(500);
        if should_emit {
            let detail = if let Some(total) = total {
                format!("{} / {}", format_bytes(downloaded), format_bytes(total))
            } else {
                format!("已下载 {}", format_bytes(downloaded))
            };
            let message = format!("正在下载安装包（{detail}）");
            let mut progress = RuntimeProgress::new("runtime", message)
                .with_bytes(downloaded, total)
                .with_detail(detail);
            if let Some(percent) = percent {
                progress = progress.with_progress(percent);
            }
            on_progress(progress);
            last_percent = percent;
            last_emit = Instant::now();
        }
    }
    drop(out);

    // The read loop exits cleanly on EOF even if the server/proxy cut the connection
    // early — without this check a truncated download is silently treated as
    // "complete" and only surfaces later as a confusing SHA256 mismatch on every retry.
    if let Some(t) = total {
        if downloaded != t {
            return Err(format!(
                "下载不完整: 期望 {}，实际 {}（连接可能被中途截断，将于下次尝试续传）",
                format_bytes(t),
                format_bytes(downloaded)
            ));
        }
    }

    let detail = if let Some(total) = total {
        format!("{} / {}", format_bytes(downloaded), format_bytes(total))
    } else {
        format!("已下载 {}", format_bytes(downloaded))
    };
    let mut progress = RuntimeProgress::new("runtime", format!("安装包下载完成（{detail}）"))
        .with_bytes(downloaded, total)
        .with_detail(detail);
    if total.is_some() {
        progress = progress.with_progress(100);
    }
    on_progress(progress);
    Ok(())
}

fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("ditto")
            .arg("-xk")
            .arg(zip_path)
            .arg(dest)
            .status()
            .map_err(|e| format!("ditto 解压 zip 不可用: {e}"))?;
        if status.success() {
            return Ok(());
        }
        eprintln!("[E-Agent Edge] ditto 解压失败 ({status})，回退 zip crate");
    }
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| "zip 路径非法".to_string())?
            .to_path_buf();
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn find_bundle_root(staging: &Path) -> Result<PathBuf, String> {
    if staging.join("runtime").join("server.js").exists() {
        return Ok(staging.to_path_buf());
    }
    if let Ok(entries) = fs::read_dir(staging) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.join("runtime").join("server.js").exists() {
                return Ok(p);
            }
        }
    }
    Err("zip 内未找到 runtime/server.js".to_string())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_symlink() {
            let target = fs::read_link(&from).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::symlink;
                if to.exists() {
                    fs::remove_file(&to).or_else(|_| fs::remove_dir_all(&to)).map_err(|e| e.to_string())?;
                }
                symlink(&target, &to).map_err(|e| e.to_string())?;
            }
            #[cfg(not(unix))]
            {
                fs::copy(&from, &to).map_err(|e| e.to_string())?;
            }
        } else if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// macOS: ditto preserves pnpm symlinks; other platforms: symlink-aware recursive copy.
fn copy_tree_preserve_symlinks(src: &Path, dst: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if dst.exists() {
            fs::remove_dir_all(dst).map_err(|e| e.to_string())?;
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let status = std::process::Command::new("ditto")
            .arg(src)
            .arg(dst)
            .status()
            .map_err(|e| format!("ditto 不可用: {e}"))?;
        if !status.success() {
            return Err(format!("ditto 复制 runtime 失败 ({status})"));
        }
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        if dst.exists() {
            fs::remove_dir_all(dst).map_err(|e| e.to_string())?;
        }
        copy_dir_recursive(src, dst)
    }
}

fn standalone_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for key in ["MC_EDGE_STANDALONE_DIR", "MISSION_CONTROL_STANDALONE_DIR"] {
        if let Ok(v) = std::env::var(key) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                dirs.push(PathBuf::from(trimmed));
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(
            home.join("Desktop")
                .join("agent指挥仓")
                .join("mission-control-client")
                .join(".next")
                .join("standalone"),
        );
    }
    dirs
}

/// 中心 manifest 503 或下载失败时，从本机 `pnpm build` 产出的 standalone 复制（无需 zip）。
pub fn install_from_local_standalone(version: &str) -> Result<String, String> {
    for dir in standalone_search_dirs() {
        if !dir.join("server.js").is_file() {
            continue;
        }
        if !next_module_resolvable(&dir) {
            eprintln!(
                "[E-Agent Edge] standalone 无效（缺少 next）: {}",
                dir.display()
            );
            continue;
        }
        let dest = config::runtime_root();
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        copy_tree_preserve_symlinks(&dir, &dest)?;
        if let Some(server_js) = resolve_server_js() {
            if let Some(root) = server_js.parent() {
                let _ = repair_runtime_peer_links(root);
            }
        }

        // 与 provision-tray-runtime 一致：补齐 static / public
        let project_root = dir.parent().and_then(|p| p.parent());
        if let Some(root) = project_root {
            let static_src = root.join(".next").join("static");
            if static_src.is_dir() {
                let static_dest = dest.join(".next").join("static");
                let _ = fs::create_dir_all(dest.join(".next"));
                let _ = copy_dir_recursive(&static_src, &static_dest);
            }
            let public_src = root.join("public");
            if public_src.is_dir() {
                let _ = copy_dir_recursive(&public_src, &dest.join("public"));
            }
        }

        fs::write(dest.join("VERSION"), format!("{version}\n")).map_err(|e| e.to_string())?;
        let installed_runtime_dir = validate_installed_runtime(version).map_err(|e| {
            format!("复制 standalone 后 runtime 仍不可用: {} ({e})", dir.display())
        })?;
        fs::write(installed_runtime_dir.join("VERSION"), format!("{version}\n"))
            .map_err(|e| e.to_string())?;
        return Ok(format!("已从本机 standalone 安装 runtime（{}）", dir.display()));
    }
    Err(
        "未找到本机 standalone。请执行: cd mission-control-client && pnpm build；\
         或设置环境变量 MC_EDGE_STANDALONE_DIR=你的/.next/standalone 路径"
            .to_string(),
    )
}

pub fn provision_runtime_via_web_client(cfg: &EdgeConfig) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{}/api/edge/provision-tray-runtime", cfg.port);
    let client = http_client::build_http_client(cfg, Duration::from_secs(120))?;
    let resp = client
        .post(&url)
        .send()
        .map_err(|e| format!("无法请求 Web 客户端安装 runtime: {e}"))?;
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "Web 客户端安装 runtime 失败 HTTP {status}: {}",
            body.chars().take(240).collect::<String>()
        ));
    }
    if resolve_server_js().is_some() {
        return Ok(format!(
            "已从 Web 客户端复制 runtime {}",
            installed_version().unwrap_or_else(|| "local".to_string())
        ));
    }
    Err("复制后仍未检测到 server.js（期望 ~/.e-agent-edge/runtime/server.js）".to_string())
}

fn fetch_manifest_via_web_client(cfg: &EdgeConfig) -> Result<RuntimeManifest, String> {
    let url = format!(
        "http://127.0.0.1:{}/api/edge/proxy-runtime-manifest",
        cfg.port
    );
    let client = http_client::build_http_client(cfg, Duration::from_secs(60))?;
    let resp = client.get(&url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body = resp.text().map_err(|e| e.to_string())?;
    if body.trim_start().starts_with('<') {
        return Err("5101 返回 HTML，请执行 pnpm prod:restart 加载新 API".to_string());
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

pub fn ensure_runtime(cfg: &EdgeConfig) -> Result<(), String> {
    ensure_runtime_with_progress(cfg, |_| {})
}

pub fn ensure_runtime_with_progress<F>(cfg: &EdgeConfig, mut on_progress: F) -> Result<(), String>
where
    F: FnMut(RuntimeProgress),
{
    on_progress(RuntimeProgress::new(
        "runtime",
        "正在检查本机 Web 客户端…",
    ));
    let mut target_version: Option<String> = None;
    let mut requires_update = false;
    if is_runtime_usable() {
        match fetch_manifest(cfg) {
            Ok(manifest) => {
                let installed = installed_version();
                target_version = Some(manifest.client_version.clone());
                if installed.as_deref() == Some(manifest.client_version.as_str()) {
                    on_progress(RuntimeProgress::new(
                        "runtime",
                        format!("本机 Web 客户端已是最新版本 {}", manifest.client_version),
                    ));
                    return Ok(());
                }
                requires_update = true;
                eprintln!(
                    "[E-Agent Edge] runtime 版本需要更新: 当前 {}，目标 {}",
                    installed.unwrap_or_else(|| "unknown".to_string()),
                    manifest.client_version
                );
            }
            Err(e) => {
                eprintln!(
                    "[E-Agent Edge] 在线 runtime 清单不可用（{e}），继续使用已安装 runtime {}",
                    installed_version().unwrap_or_else(|| "local".to_string())
                );
                return Ok(());
            }
        }
    }
    if resolve_server_js().is_some() {
        eprintln!(
            "[E-Agent Edge] ~/.e-agent-edge/runtime 已损坏（常见：node_modules 符号链接指向已删除的 standalone），将重新安装"
        );
        let root = config::runtime_root();
        if root.exists() {
            fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
        }
    }
    if !requires_update && !has_explicit_manifest_url(cfg) {
        if let Ok(msg) = provision_runtime_via_web_client(cfg) {
            eprintln!("[E-Agent Edge] {msg}");
            return Ok(());
        }
    }
    let version = cfg
        .runtime_version
        .clone()
        .or_else(|| target_version.clone())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_VERSION.to_string());

    match download_and_install_with_progress(cfg, true, |progress| on_progress(progress)) {
        Ok(msg) => {
            eprintln!("[E-Agent Edge] {msg}");
            Ok(())
        }
        Err(e) => {
            if is_runtime_usable() && !requires_update {
                eprintln!(
                    "[E-Agent Edge] 中心 runtime 下载失败（{e}），使用已安装的本地 runtime"
                );
                return Ok(());
            }
            eprintln!("[E-Agent Edge] 中心 runtime 下载失败，尝试本机 standalone…");
            match install_from_local_standalone(&version) {
                Ok(msg) => {
                    eprintln!("[E-Agent Edge] {msg}");
                    Ok(())
                }
                Err(local) => Err(format!("{e}\n\n{local}")),
            }
        }
    }
}
