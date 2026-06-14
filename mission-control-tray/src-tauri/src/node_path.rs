//! 解析 Node 可执行文件。从 Finder/.app 启动时 PATH 常不含 Homebrew/nvm，需显式探测。

use std::path::{Path, PathBuf};

const REQUIRED_NODE_MAJOR: u32 = 22;

/// 返回可执行的 `node` 路径（macOS 会探测 Homebrew / nvm / fnm 等）。
///
/// Edge runtime ships native modules compiled for Node 22 ABI. Newer Node majors
/// such as 25 can start the server but fail once better-sqlite3 is loaded, so
/// this must prefer/require Node 22 instead of the newest installed Node.
pub fn resolve_node_binary() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("MC_EDGE_NODE_PATH") {
        let p = p.trim();
        if !p.is_empty() {
            return validate_node(Path::new(p));
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = which::which("node") {
        candidates.push(p);
    }
    candidates.extend(default_candidates());
    if let Some(p) = newest_nvm_node() {
        candidates.push(p);
    }
    if let Some(p) = node_from_login_shell() {
        candidates.push(p);
    }

    let mut best: Option<(u32, PathBuf)> = None;
    let mut seen = std::collections::HashSet::new();
    for path in candidates {
        let key = path.to_string_lossy().to_string();
        if !seen.insert(key) {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let Ok((major, minor)) = node_version(&path) else {
            continue;
        };
        if major != REQUIRED_NODE_MAJOR {
            eprintln!(
                "[E-Agent Edge] 跳过 Node {}（runtime 需要 Node {}.x）: {}",
                major,
                REQUIRED_NODE_MAJOR,
                path.display()
            );
            continue;
        }
        let replace = match &best {
            None => true,
            Some((bm, _)) => minor > *bm,
        };
        if replace {
            best = Some((minor, path));
        }
    }

    if let Some((_, path)) = best {
        return validate_node(&path);
    }

    Err(format!(
        "未找到 Node.js {}.x。请安装: brew install node@22，或从 https://nodejs.org 安装 Node 22 LTS，\
         然后重试；也可设置 MC_EDGE_NODE_PATH=/你的/node 路径",
        REQUIRED_NODE_MAJOR
    ))
}

fn node_version(path: &Path) -> Result<(u32, u32), String> {
    let out = std::process::Command::new(path)
        .arg("--version")
        .output()
        .map_err(|e| format!("无法执行 {}: {e}", path.display()))?;
    if !out.status.success() {
        return Err(format!(
            "Node 无法运行: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let ver = ver.strip_prefix('v').unwrap_or(&ver);
    let mut parts = ver.split('.');
    let major: u32 = parts
        .next()
        .ok_or_else(|| "invalid node version".to_string())?
        .parse()
        .map_err(|_| format!("invalid node version: {ver}"))?;
    let minor: u32 = parts.next().unwrap_or("0").parse().unwrap_or(0);
    Ok((major, minor))
}

fn validate_node(path: &Path) -> Result<PathBuf, String> {
    if !path.is_file() {
        return Err(format!("Node 路径不存在: {}", path.display()));
    }
    let (major, _) = node_version(path)?;
    if major != REQUIRED_NODE_MAJOR {
        return Err(format!(
            "Node 版本不匹配（当前 v{major}，runtime 需要 Node {REQUIRED_NODE_MAJOR}.x）: {}",
            path.display()
        ));
    }
    let ver = std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    eprintln!("[E-Agent Edge] 使用 Node: {} ({ver})", path.display());
    Ok(path.to_path_buf())
}

fn default_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".openagents/nodejs/bin/node"));
        paths.push(home.join(".fnm/current/bin/node"));
        paths.push(home.join(".volta/bin/node"));
        paths.push(home.join(".local/bin/node"));
    }
    paths.push(PathBuf::from("/opt/homebrew/bin/node"));
    paths.push(PathBuf::from("/usr/local/bin/node"));
    paths.push(PathBuf::from("/usr/bin/node"));
    paths
}

fn newest_nvm_node() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let versions_dir = home.join(".nvm/versions/node");
    let mut best: Option<(u32, u32, PathBuf)> = None;
    let entries = std::fs::read_dir(&versions_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let ver = name.strip_prefix('v').unwrap_or(&name);
        let (major, minor) = parse_semver_prefix(ver)?;
        if major != REQUIRED_NODE_MAJOR {
            continue;
        }
        let node = entry.path().join("bin/node");
        if !node.is_file() {
            continue;
        }
        let replace = match &best {
            None => true,
            Some((bm, bn, _)) => (major, minor) > (*bm, *bn),
        };
        if replace {
            best = Some((major, minor, node));
        }
    }
    best.map(|(_, _, p)| p)
}

/// 读取用户登录 shell 的 PATH（Finder 启动的 .app 往往只有 /usr/bin:/bin）。
fn node_from_login_shell() -> Option<PathBuf> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let out = std::process::Command::new(&shell)
        .args(["-l", "-c", "command -v node 2>/dev/null || which node 2>/dev/null"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        return None;
    }
    Some(PathBuf::from(path))
}

fn parse_semver_prefix(s: &str) -> Option<(u32, u32)> {
    let mut parts = s.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor))
}

/// 供子进程使用的 PATH（含 Homebrew 等，避免 runtime 内再找不到命令）。
pub fn augmented_path_for_subprocess() -> String {
    let mut prefixes = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    if let Some(home) = dirs::home_dir() {
        prefixes.push(
            home.join(".openagents/nodejs/bin")
                .to_string_lossy()
                .into_owned(),
        );
        prefixes.push(home.join(".fnm/current/bin").to_string_lossy().into_owned());
        prefixes.push(home.join(".volta/bin").to_string_lossy().into_owned());
    if let Some(nvm) = newest_nvm_node() {
            if let Some(bin) = nvm.parent() {
                prefixes.push(bin.to_string_lossy().into_owned());
            }
        }
    }
    let current = std::env::var("PATH").unwrap_or_default();
    if current.is_empty() {
        prefixes.join(":")
    } else {
        format!("{}:{}", prefixes.join(":"), current)
    }
}
