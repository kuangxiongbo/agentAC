#!/usr/bin/env bash
# 本机打包 mission-control-tray → 同步到 mission-control/public/edge-tray/
# 托盘原生版本独立于中心服/runtime 版本；docker build 时打入镜像。
#
# 用法（仓库根目录）:
#   bash mission-control/scripts/sync-edge-tray-bundle.sh
#   bash mission-control/scripts/sync-edge-tray-bundle.sh --skip-build   # 仅用已有 .dmg
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MC_ROOT/.." && pwd)"
TRAY_ROOT="$REPO_ROOT/mission-control-tray"
OUT_DIR="$MC_ROOT/public/edge-tray"
SKIP_BUILD=0

for arg in "$@"; do
  [[ "$arg" == "--skip-build" ]] && SKIP_BUILD=1
done

MC_VERSION="$(node -p "require('$MC_ROOT/package.json').version")"
TRAY_VERSION="$(node -p "require('$TRAY_ROOT/package.json').version")"
PLATFORM="${EDGE_TRAY_PLATFORM:-darwin-aarch64}"
ARCH="${PLATFORM#darwin-}"
DMG_NAME="e-agent-edge-${TRAY_VERSION}-${PLATFORM}.dmg"
MANIFEST="$OUT_DIR/manifest.json"

find_tray_dmg() {
  local candidates=(
    "$TRAY_ROOT/src-tauri/target/release/bundle/dmg/E-Agent Edge_${TRAY_VERSION}_${ARCH}.dmg"
    "$TRAY_ROOT/src-tauri/target/release/bundle/dmg/E-Agent Edge_${TRAY_VERSION}.dmg"
    "$REPO_ROOT/releases/dist/e-agent-edge-${TRAY_VERSION}-${PLATFORM}.dmg"
    "$REPO_ROOT/releases/dist/E-Agent-Edge.dmg"
  )
  local dir="$TRAY_ROOT/src-tauri/target/release/bundle/dmg"
  if [[ -d "$dir" ]]; then
    while IFS= read -r f; do
      candidates+=("$f")
    done < <(find "$dir" -maxdepth 1 -name '*.dmg' -type f 2>/dev/null | sort -r)
  fi
  for f in "${candidates[@]}"; do
    [[ -f "$f" ]] && { echo "$f"; return 0; }
  done
  return 1
}

echo "==> Edge tray sync (center $MC_VERSION / tray $TRAY_VERSION / $PLATFORM)"

SRC_DMG=""
if SRC_DMG="$(find_tray_dmg)"; then
  :
elif [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> pnpm tauri build (mission-control-tray)"
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "error: Edge .dmg must be built on macOS (pnpm tauri build in mission-control-tray)" >&2
    exit 1
  fi
  (cd "$TRAY_ROOT" && pnpm install --frozen-lockfile && pnpm tauri build)
  SRC_DMG="$(find_tray_dmg)" || true
fi

if [[ -z "${SRC_DMG:-}" ]] || [[ ! -f "$SRC_DMG" ]]; then
  echo "error: missing tray .dmg — run: cd mission-control-tray && pnpm tauri build" >&2
  exit 1
fi

APP_BUNDLE="$TRAY_ROOT/src-tauri/target/release/bundle/macos/E-Agent Edge.app"
STAGING_ROOT=""
STAGING_APP=""
cleanup_staging() {
  if [[ -n "$STAGING_ROOT" && -d "$STAGING_ROOT" ]]; then
    rm -rf "$STAGING_ROOT"
  fi
  if [[ -n "$STAGING_APP" && -d "$STAGING_APP" ]]; then
    rm -rf "$STAGING_APP"
  fi
}
trap cleanup_staging EXIT

repack_signed_dmg() {
  local app_path="$1"
  local out_dmg="$2"
  echo "==> ad-hoc codesign + repack dmg (避免 DMG 内直接打开被 Gatekeeper 拦截)"
  codesign --force --deep --sign - "$app_path"
  local dmg_root
  dmg_root="$(mktemp -d)"
  ditto "$app_path" "$dmg_root/E-Agent Edge.app"
  ln -s /Applications "$dmg_root/Applications"
  rm -f "$out_dmg"
  hdiutil create -volname "E-Agent Edge" -srcfolder "$dmg_root" -ov -format UDZO "$out_dmg" >/dev/null
  rm -rf "$dmg_root"
  xattr -cr "$out_dmg" 2>/dev/null || true
}

mkdir -p "$OUT_DIR"
OUT_DMG="$OUT_DIR/$DMG_NAME"

if [[ -d "$APP_BUNDLE" ]]; then
  repack_signed_dmg "$APP_BUNDLE" "$OUT_DMG"
else
  echo "==> extract .app from source dmg then repack"
  STAGING_ROOT="$(mktemp -d)"
  STAGING_APP="$STAGING_ROOT/E-Agent Edge.app"
  MOUNT_OUT="$(hdiutil attach -nobrowse -readonly "$SRC_DMG" | awk '/\/Volumes\// {idx=index($0,"/Volumes/"); print substr($0,idx); exit}')"
  if [[ -z "$MOUNT_OUT" || ! -d "$MOUNT_OUT/E-Agent Edge.app" ]]; then
    echo "error: cannot find E-Agent Edge.app in $SRC_DMG" >&2
    exit 1
  fi
  ditto "$MOUNT_OUT/E-Agent Edge.app" "$STAGING_APP"
  hdiutil detach "$MOUNT_OUT" >/dev/null 2>&1 || true
  repack_signed_dmg "$STAGING_APP" "$OUT_DMG"
fi

VERIFY_MOUNT="$(hdiutil attach -nobrowse -readonly "$OUT_DMG" | awk '/\/Volumes\// {idx=index($0,"/Volumes/"); print substr($0,idx); exit}')"
if [[ -z "$VERIFY_MOUNT" || ! -d "$VERIFY_MOUNT/E-Agent Edge.app" || ! -L "$VERIFY_MOUNT/Applications" ]]; then
  [[ -n "${VERIFY_MOUNT:-}" ]] && hdiutil detach "$VERIFY_MOUNT" >/dev/null 2>&1 || true
  echo "error: generated DMG must contain E-Agent Edge.app and an Applications symlink" >&2
  exit 1
fi
PLIST="$VERIFY_MOUNT/E-Agent Edge.app/Contents/Info.plist"
SHORT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST" 2>/dev/null || true)"
BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST" 2>/dev/null || true)"
if [[ "$SHORT_VERSION" != "$TRAY_VERSION" || "$BUNDLE_VERSION" != "$TRAY_VERSION" ]]; then
  hdiutil detach "$VERIFY_MOUNT" >/dev/null 2>&1 || true
  echo "error: generated DMG Info.plist version mismatch: short=$SHORT_VERSION bundle=$BUNDLE_VERSION expected=$TRAY_VERSION" >&2
  echo "hint: remove mission-control-tray/src-tauri/target/release/bundle and rerun this script" >&2
  exit 1
fi
hdiutil detach "$VERIFY_MOUNT" >/dev/null 2>&1 || true

if command -v shasum >/dev/null 2>&1; then
  SHA256="$(shasum -a 256 "$OUT_DMG" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$OUT_DMG" | awk '{print $1}')"
else
  echo "error: need shasum or sha256sum" >&2
  exit 1
fi

PUBLISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

MC_VERSION="$MC_VERSION" TRAY_VERSION="$TRAY_VERSION" PLATFORM="$PLATFORM" \
  DMG_NAME="$DMG_NAME" SHA256="$SHA256" PUBLISHED_AT="$PUBLISHED_AT" MANIFEST="$MANIFEST" node <<'NODE'
const fs = require('fs');
const manifest = {
  schema: 1,
  center_version: process.env.MC_VERSION,
  tray_version: process.env.TRAY_VERSION,
  published_at: process.env.PUBLISHED_AT,
  platforms: {
    [process.env.PLATFORM]: {
      url: '/edge-tray/' + process.env.DMG_NAME,
      sha256: process.env.SHA256,
      filename: 'E-Agent-Edge.dmg',
    },
  },
};
fs.writeFileSync(process.env.MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
NODE

echo "==> synced"
echo "    dmg:      $OUT_DIR/$DMG_NAME ($(du -h "$OUT_DIR/$DMG_NAME" | awk '{print $1}'))"
echo "    manifest: $MANIFEST"
echo "    sha256:   $SHA256"
echo ""
echo "下一步: bash mission-control/scripts/docker-publish-multiarch.sh"
