//! macOS launch context: app bundle vs bare binary (`tauri dev`).

/// True when launched as `*.app/Contents/MacOS/...` (e.g. after `tauri build` + Finder open).
pub fn running_inside_app_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .is_some_and(|p| {
            let s = p.to_string_lossy();
            s.contains(".app/Contents/MacOS/")
        })
}

/// 顶部 WebView 快捷条：默认关闭（攻关右侧小图标时避免遮挡）；`MC_EDGE_TOP_HELPER=1` 开启。
pub fn should_show_top_helper() -> bool {
    matches!(
        std::env::var("MC_EDGE_TOP_HELPER")
            .ok()
            .as_deref()
            .map(str::trim),
        Some("1") | Some("true") | Some("yes")
    )
}

pub fn launch_mode_hint() -> &'static str {
    if running_inside_app_bundle() {
        "已打包 .app 启动"
    } else {
        "开发/裸二进制启动（菜单栏图标建议 tauri build 后 open .app）"
    }
}
