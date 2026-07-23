#!/usr/bin/env bash
# Package mission-control-client standalone into client-runtime-{version}-{platform}.zip
# Upload zip + update releases/edge-runtime-manifest.json for tray first-run download.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_ROOT/.." && pwd)"

VERSION="${EDGE_RUNTIME_VERSION:-$(node -p "require('$PROJECT_ROOT/package.json').version")}"
PLATFORM="${EDGE_RUNTIME_PLATFORM:-}"

if [[ -z "$PLATFORM" ]]; then
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"
  case "$uname_s" in
    Darwin)
      [[ "$uname_m" == "arm64" ]] && PLATFORM="darwin-aarch64" || PLATFORM="darwin-x86_64"
      ;;
    Linux) PLATFORM="linux-x86_64" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows-x86_64" ;;
    *) echo "error: unknown platform $uname_s/$uname_m; set EDGE_RUNTIME_PLATFORM" >&2; exit 1 ;;
  esac
fi

STAGING="$PROJECT_ROOT/dist/edge-runtime-staging-$VERSION-$PLATFORM"
OUT_DIR="$REPO_ROOT/releases/dist"
ZIP_NAME="client-runtime-${VERSION}-${PLATFORM}.zip"
OUT_ZIP="$OUT_DIR/$ZIP_NAME"

echo "==> build standalone (mission-control-client)"
cd "$PROJECT_ROOT"
rm -rf "$PROJECT_ROOT/dist/edge-runtime-staging-$VERSION-$PLATFORM"
NODE_ABI="$(node -p "process.versions.modules")"
NODE_VERSION="$(node -p "process.version")"
if [[ "$NODE_ABI" != "127" ]]; then
  cat >&2 <<EOF
error: Edge runtime must be packaged with the tray Node ABI 127 (Node 22.x).
current node: $NODE_VERSION ABI $NODE_ABI
Use the tray/runtime Node first in PATH, for example:
  export PATH="\$HOME/.openagents/nodejs/bin:\$PATH"
EOF
  exit 1
fi
pnpm install --frozen-lockfile
pnpm rebuild better-sqlite3
node -e "require('better-sqlite3'); console.log('better-sqlite3 ABI OK for', process.version)"
rm -rf "$PROJECT_ROOT/.next"
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}" pnpm build

STANDALONE="$PROJECT_ROOT/.next/standalone"
if [[ ! -f "$STANDALONE/server.js" ]]; then
  echo "error: missing $STANDALONE/server.js" >&2
  exit 1
fi

echo "==> stage runtime bundle"
rm -rf "$STAGING"
mkdir -p "$STAGING/runtime"

if command -v ditto >/dev/null 2>&1; then
  ditto "$STANDALONE" "$STAGING/runtime"
else
  cp -R "$STANDALONE/." "$STAGING/runtime/"
fi
# static + public (same as start-standalone.sh)
mkdir -p "$STAGING/runtime/.next"
cp -R "$PROJECT_ROOT/.next/static" "$STAGING/runtime/.next/static"
cp -R "$PROJECT_ROOT/public" "$STAGING/runtime/public"

if [[ ! -d "$STAGING/runtime/.next/static/chunks" ]]; then
  echo "error: missing staged .next/static/chunks; runtime would serve CSS/JS as page HTML" >&2
  exit 1
fi

link_runtime_peer_deps() {
  local root="$1"
  local nm="$root/node_modules"
  local pkg pkgdir rel parent
  for pkg in styled-jsx @swc/helpers @next/env; do
    if [[ -e "$nm/$pkg/package.json" || -L "$nm/$pkg" ]]; then
      continue
    fi
    pkgdir=""
    pkgdir=$(find "$nm/.pnpm" -path "*/node_modules/${pkg}/package.json" 2>/dev/null | head -1)
    [[ -z "$pkgdir" ]] && continue
    pkgdir=$(dirname "$pkgdir")
    rel=$(python3 -c "import os.path; print(os.path.relpath('$pkgdir', '$nm'))")
    parent=$(dirname "$nm/$pkg")
    mkdir -p "$parent"
    ln -sf "$rel" "$nm/$pkg"
  done
}
link_runtime_peer_deps "$STAGING/runtime"

repair_next_compiled_runtime() {
  local root="$1"
  local src_next="$PROJECT_ROOT/node_modules/next"
  local dest_next="$root/node_modules/next"
  local src_dir="$src_next/dist/compiled/next-server"
  local dest_dir="$dest_next/dist/compiled/next-server"
  if [[ ! -d "$src_dir" ]]; then
    echo "error: missing source Next compiled runtime: $src_dir" >&2
    exit 1
  fi
  mkdir -p "$dest_dir"
  if command -v ditto >/dev/null 2>&1; then
    ditto "$src_dir" "$dest_dir"
  else
    cp -R "$src_dir/." "$dest_dir/"
  fi
}
repair_next_compiled_runtime "$STAGING/runtime"

echo "==> verify native runtime modules"
node -e "require('$STAGING/runtime/node_modules/better-sqlite3'); console.log('staged better-sqlite3 ABI OK for', process.version)"

echo "==> remove development-only runtime files"
find "$STAGING/runtime" -maxdepth 2 \( \
  -name ".dev-server.log" -o \
  -name ".dev-server.pid" -o \
  -name ".standalone-server.log" -o \
  -name ".standalone-server.pid" -o \
  -name ".turbo" -o \
  -name ".next/cache" \
\) -exec rm -rf {} +
find "$STAGING/runtime" -name ".DS_Store" -delete

required_runtime_files=(
  "$STAGING/runtime/node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js"
  "$STAGING/runtime/node_modules/next/dist/compiled/next-server/app-page-turbo.runtime.prod.js"
  "$STAGING/runtime/node_modules/next/dist/compiled/next-server/pages-turbo.runtime.prod.js"
)
for file in "${required_runtime_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "error: missing required runtime file: $file" >&2
    exit 1
  fi
done

echo "$VERSION" >"$STAGING/VERSION"
cat >"$STAGING/README.txt" <<EOF
E-Agent Edge runtime bundle
version=$VERSION
platform=$PLATFORM

Started by E-Agent Edge tray; requires Node.js 22+ on PATH.
EOF

mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"
if command -v ditto >/dev/null 2>&1; then
  ditto -c -k --norsrc --keepParent "$STAGING" "$OUT_ZIP"
else
  (cd "$STAGING/.." && zip -ry "$OUT_ZIP" "$(basename "$STAGING")")
fi

echo "==> verify clean extraction and runtime startup"
VERIFY_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/edge-runtime-verify.XXXXXX")"
VERIFY_HOME="$VERIFY_ROOT/home"
VERIFY_LOG="$VERIFY_ROOT/runtime.log"
VERIFY_PORT="${EDGE_RUNTIME_VERIFY_PORT:-15191}"
VERIFY_PID=""
cleanup_verify() {
  if [[ -n "$VERIFY_PID" ]]; then
    kill "$VERIFY_PID" 2>/dev/null || true
    wait "$VERIFY_PID" 2>/dev/null || true
  fi
  rm -rf "$VERIFY_ROOT"
}
trap cleanup_verify EXIT
mkdir -p "$VERIFY_HOME"
if command -v ditto >/dev/null 2>&1; then
  ditto -xk "$OUT_ZIP" "$VERIFY_ROOT/extracted"
else
  unzip -q "$OUT_ZIP" -d "$VERIFY_ROOT/extracted"
fi
VERIFY_RUNTIME="$VERIFY_ROOT/extracted/$(basename "$STAGING")/runtime"
for file in "${required_runtime_files[@]}"; do
  rel="${file#"$STAGING/runtime/"}"
  if [[ ! -f "$VERIFY_RUNTIME/$rel" ]]; then
    echo "error: clean extraction missing required runtime file: $rel" >&2
    exit 1
  fi
done
(
  cd "$VERIFY_RUNTIME"
  HOME="$VERIFY_HOME" PORT="$VERIFY_PORT" HOSTNAME="127.0.0.1" node server.js >"$VERIFY_LOG" 2>&1
) &
VERIFY_PID=$!
healthy=""
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$VERIFY_PORT/api/status?action=health" >"$VERIFY_ROOT/health.json" 2>/dev/null; then
    healthy="yes"
    break
  fi
  if ! kill -0 "$VERIFY_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if [[ -z "$healthy" ]]; then
  echo "error: cleanly extracted runtime failed health startup" >&2
  cat "$VERIFY_LOG" >&2 || true
  exit 1
fi
node -e "const h=require('$VERIFY_ROOT/health.json'); if (h.version !== '$VERSION') throw new Error('health version mismatch: '+JSON.stringify(h)); console.log('clean runtime health OK', h.version)"
cleanup_verify
trap - EXIT

if command -v shasum >/dev/null 2>&1; then
  echo "==> sha256"
  shasum -a 256 "$OUT_ZIP"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT_ZIP"
fi

echo "==> output: $OUT_ZIP"
echo "    attach to GitHub Release tag: edge-runtime-v${VERSION}"
echo "    update releases/edge-runtime-manifest.json platforms.${PLATFORM}"
