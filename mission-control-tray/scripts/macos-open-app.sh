#!/usr/bin/env bash
# 必须用 .app 启动，Dock 才显示正常图标，菜单栏托盘才可靠（勿直接跑 target/ 下裸二进制）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/E-Agent Edge.app"

cd "$ROOT"
echo "==> 构建 release .app …"
pnpm tauri build

if [[ ! -d "$APP" ]]; then
  echo "未找到: $APP" >&2
  exit 1
fi

echo "==>  ad-hoc 签名 …"
codesign --force --deep --sign - "$APP"

echo "==> 启动（Finder 方式）…"
open "$APP"

echo "完成。请在菜单栏右上角找 Clash 同款小图标；Dock 应显示 E-Agent Edge 图标而非 exec。"
