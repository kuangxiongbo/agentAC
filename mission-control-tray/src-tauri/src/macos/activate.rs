//! 激活应用，避免菜单栏项在后台创建后不绘制

use objc2_app_kit::NSApplication;
use objc2_foundation::MainThreadMarker;

pub fn activate_app() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    app.activateIgnoringOtherApps(true);
}
