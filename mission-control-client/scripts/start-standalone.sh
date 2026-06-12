#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=mc-ports.sh
source "$PROJECT_ROOT/scripts/mc-ports.sh"
# shellcheck source=mc-keep-awake.sh
source "$PROJECT_ROOT/scripts/mc-keep-awake.sh"

# Edge / 24h: block macOS system sleep while client runs; screen off is OK (MC_KEEP_AWAKE=0 to disable)
export MC_KEEP_AWAKE="${MC_KEEP_AWAKE:-1}"
# Allow E-Agent Edge tray POST /api/edge/apply-bootstrap on this standalone instance
export MC_EDGE_ALLOW_BOOTSTRAP="${MC_EDGE_ALLOW_BOOTSTRAP:-1}"
STANDALONE_DIR="$PROJECT_ROOT/.next/standalone"
STANDALONE_NEXT_DIR="$STANDALONE_DIR/.next"
STANDALONE_STATIC_DIR="$STANDALONE_NEXT_DIR/static"
SOURCE_STATIC_DIR="$PROJECT_ROOT/.next/static"
SOURCE_PUBLIC_DIR="$PROJECT_ROOT/public"
STANDALONE_PUBLIC_DIR="$STANDALONE_DIR/public"

if [[ ! -f "$STANDALONE_DIR/server.js" ]]; then
  echo "error: standalone server missing at $STANDALONE_DIR/server.js" >&2
  echo "run 'pnpm build' first" >&2
  exit 1
fi

mkdir -p "$STANDALONE_NEXT_DIR"

if [[ -d "$SOURCE_STATIC_DIR" ]]; then
  rm -rf "$STANDALONE_STATIC_DIR"
  cp -R "$SOURCE_STATIC_DIR" "$STANDALONE_STATIC_DIR"
fi

if [[ -d "$SOURCE_PUBLIC_DIR" ]]; then
  rm -rf "$STANDALONE_PUBLIC_DIR"
  cp -R "$SOURCE_PUBLIC_DIR" "$STANDALONE_PUBLIC_DIR"
fi

# 与 pnpm dev 共用项目根目录 .data，避免 standalone 在 .next/standalone 下新建空库导致设置丢失
export MISSION_CONTROL_DATA_DIR="${MISSION_CONTROL_DATA_DIR:-$PROJECT_ROOT/.data}"
export MISSION_CONTROL_DB_PATH="${MISSION_CONTROL_DB_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control.db}"
export MISSION_CONTROL_TOKENS_PATH="${MISSION_CONTROL_TOKENS_PATH:-$MISSION_CONTROL_DATA_DIR/mission-control-tokens.json}"

cd "$STANDALONE_DIR"
# Next.js standalone reads HOSTNAME for bind address. macOS sets HOSTNAME to
# "MachineName.local" which often fails DNS lookup — always override unless set explicitly.
BIND_HOST="${MC_STANDALONE_HOST:-0.0.0.0}"
export HOSTNAME="$BIND_HOST"
export PORT="${PORT:-$MC_STANDALONE_PORT}"

# Edge tray / proxy-bootstrap: honor ~/.e-agent-edge/config.json tls_insecure (self-signed upstream)
if [[ -z "${NODE_TLS_REJECT_UNAUTHORIZED:-}" && -z "${MC_EDGE_TLS_INSECURE:-}" ]]; then
  TRAY_CFG="${HOME:-}/.e-agent-edge/config.json"
  if [[ -f "$TRAY_CFG" ]] && grep -q '"tls_insecure"[[:space:]]*:[[:space:]]*true' "$TRAY_CFG" 2>/dev/null; then
    export NODE_TLS_REJECT_UNAUTHORIZED=0
    echo "==> edge upstream TLS verify disabled (tray config tls_insecure)"
  fi
fi
if [[ "${MC_EDGE_TLS_INSECURE:-}" == "1" && -z "${NODE_TLS_REJECT_UNAUTHORIZED:-}" ]]; then
  export NODE_TLS_REJECT_UNAUTHORIZED=0
fi
DISPLAY_HOST="$BIND_HOST"
if [[ "$DISPLAY_HOST" == "0.0.0.0" || "$DISPLAY_HOST" == "::" ]]; then
  DISPLAY_HOST="127.0.0.1"
fi
echo "==> standalone: http://${DISPLAY_HOST}:${PORT}"
mc_exec_keep_awake node server.js
