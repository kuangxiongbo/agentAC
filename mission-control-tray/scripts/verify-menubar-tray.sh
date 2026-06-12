#!/usr/bin/env bash
# 构建、签名、启动 Edge，并打印菜单栏托盘诊断（button 应在屏幕顶部 y 接近菜单栏）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/E-Agent Edge.app"
LOG="$HOME/Library/Logs/E-Agent-Edge/tray-diag.log"

cd "$ROOT"
pkill -f "E-Agent Edge.app" 2>/dev/null || true
sleep 1

echo "==> build release"
pnpm tauri build

echo "==> codesign"
codesign --force --deep --sign - "$APP"

echo "==> 清空诊断日志"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"

echo "==> 启动 .app"
open "$APP"
sleep 4

echo "==> 诊断日志"
cat "$LOG" || true

echo ""
echo ""
echo "判定:"
echo "  - 日志含 objc_tray 且 screen.y 接近主屏顶部 → Cocoa 菜单栏项已创建"
echo "  - 肉眼在菜单栏右侧（微信输入法 / 时钟左侧）找 template 图标"
echo "  - 若无：系统设置 → 菜单栏，允许 E-Agent Edge；或试 MC_EDGE_TAURI_TRAY=1 重打包"
