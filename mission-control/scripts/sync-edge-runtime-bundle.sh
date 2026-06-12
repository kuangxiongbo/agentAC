#!/usr/bin/env bash
# 本机打包 mission-control-client standalone → 同步到 mission-control/public/edge-runtime/
# 供 Docker 镜像内置 Edge 客户端 runtime（与中心服同版本配套）。
#
# 用法（仓库根目录）:
#   bash mission-control/scripts/sync-edge-runtime-bundle.sh
#   bash mission-control/scripts/sync-edge-runtime-bundle.sh --skip-build   # 仅用已有 zip
#
# Docker 构建前执行一次，再 cd mission-control && docker build ...
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MC_ROOT/.." && pwd)"
CLIENT_ROOT="$REPO_ROOT/mission-control-client"
OUT_DIR="$MC_ROOT/public/edge-runtime"
SKIP_BUILD=0

for arg in "$@"; do
  [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=1
done

VERSION="$(node -p "require('$CLIENT_ROOT/package.json').version")"
PLATFORM="${EDGE_RUNTIME_PLATFORM:-darwin-aarch64}"
ZIP_NAME="client-runtime-${VERSION}-${PLATFORM}.zip"
SRC_ZIP="$REPO_ROOT/releases/dist/$ZIP_NAME"

echo "==> Edge runtime sync (client $VERSION / $PLATFORM)"

if [[ "$SKIP_BUILD" -eq 0 ]] || [[ ! -f "$SRC_ZIP" ]]; then
  echo "==> package standalone zip"
  (cd "$CLIENT_ROOT" && EDGE_RUNTIME_PLATFORM="$PLATFORM" bash scripts/package-edge-runtime.sh)
fi

if [[ ! -f "$SRC_ZIP" ]]; then
  echo "error: missing $SRC_ZIP" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp -f "$SRC_ZIP" "$OUT_DIR/$ZIP_NAME"

if command -v shasum >/dev/null 2>&1; then
  SHA256="$(shasum -a 256 "$OUT_DIR/$ZIP_NAME" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$OUT_DIR/$ZIP_NAME" | awk '{print $1}')"
else
  echo "error: need shasum or sha256sum" >&2
  exit 1
fi

PUBLISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
MANIFEST="$OUT_DIR/manifest.json"

VERSION="$VERSION" PLATFORM="$PLATFORM" ZIP_NAME="$ZIP_NAME" SHA256="$SHA256" \
  PUBLISHED_AT="$PUBLISHED_AT" MANIFEST="$MANIFEST" node <<'NODE'
const fs = require('fs');
const manifest = {
  schema: 1,
  client_version: process.env.VERSION,
  tray_min_version: '0.1.0',
  published_at: process.env.PUBLISHED_AT,
  platforms: {
    [process.env.PLATFORM]: {
      url: '/edge-runtime/' + process.env.ZIP_NAME,
      sha256: process.env.SHA256,
    },
  },
};
fs.writeFileSync(process.env.MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
NODE

echo "==> synced"
echo "    zip:      $OUT_DIR/$ZIP_NAME ($(du -h "$OUT_DIR/$ZIP_NAME" | awk '{print $1}'))"
echo "    manifest: $MANIFEST"
echo "    sha256:   $SHA256"
echo ""
echo "下一步: cd mission-control && docker build -t agentcenter:$VERSION ."
echo "验证:   curl -sk https://你的域名/api/releases/edge-runtime-manifest"
