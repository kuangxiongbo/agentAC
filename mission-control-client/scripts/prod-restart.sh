#!/usr/bin/env bash
# 长期运行 standalone（默认 127.0.0.1:5101，与 dev 5001 分离）
# 用法:
#   ./scripts/prod-restart.sh           # 需已 pnpm build；后台启动
#   ./scripts/prod-restart.sh --stop    # 仅停止
#   ./scripts/prod-restart.sh --build   # 先 build 再启动

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=mc-ports.sh
source "$ROOT/scripts/mc-ports.sh"

HOST="${MC_STANDALONE_HOST:-0.0.0.0}"
PORT="${PORT:-$MC_STANDALONE_PORT}"
DISPLAY_HOST="${VERIFY_HOST:-127.0.0.1}"
PID_FILE="$ROOT/.standalone-server.pid"
LOG_FILE="$ROOT/.standalone-server.log"
STOP_ONLY=0
DO_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stop) STOP_ONLY=1; shift ;;
    --build) DO_BUILD=1; shift ;;
    -h|--help)
      echo "用法: $(basename "$0") [--build] [--stop]"
      echo "  端口默认 ${PORT}（MC_STANDALONE_PORT），开发请用 pnpm dev:restart（${MC_DEV_PORT}）"
      exit 0
      ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

stop_pid() {
  local pid="$1"
  [[ -z "$pid" ]] && return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  echo "==> 停止 pid=${pid}"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || return
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
  return 0
}

stop_all() {
  if [[ -f "$PID_FILE" ]]; then
    stop_pid "$(cat "$PID_FILE" 2>/dev/null || true)"
    rm -f "$PID_FILE"
  fi
  if command -v lsof >/dev/null 2>&1; then
    while IFS= read -r pid; do
      [[ -n "$pid" ]] && stop_pid "$pid"
    done < <(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
  fi
  echo "==> 端口 ${PORT} 已释放"
}

start_standalone() {
  if [[ ! -f "$ROOT/.next/standalone/server.js" ]]; then
    echo "error: 未找到 standalone，请先: pnpm build 或 $0 --build" >&2
    exit 1
  fi
  echo "==> 后台启动 standalone (${DISPLAY_HOST}:${PORT})"
  echo "    日志: ${LOG_FILE}"
  MISSION_CONTROL_DATA_DIR="${MISSION_CONTROL_DATA_DIR:-$ROOT/.data}" \
  MISSION_CONTROL_DB_PATH="${MISSION_CONTROL_DB_PATH:-$ROOT/.data/mission-control.db}" \
  MISSION_CONTROL_TOKENS_PATH="${MISSION_CONTROL_TOKENS_PATH:-$ROOT/.data/mission-control-tokens.json}" \
  MC_STANDALONE_HOST="$HOST" PORT="$PORT" \
  nohup bash "$ROOT/scripts/start-standalone.sh" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 30); do
    if curl -sf "http://${DISPLAY_HOST}:${PORT}/" >/dev/null 2>&1; then
      echo "==> 就绪: http://${DISPLAY_HOST}:${PORT}  PID=$(cat "$PID_FILE")"
      echo "==> 停止: $0 --stop"
      return 0
    fi
    sleep 1
  done
  echo "警告: 等待超时，请查看 ${LOG_FILE}" >&2
}

echo "==> standalone 长期运行 (port=${PORT}, dev=${MC_DEV_PORT})"
stop_all
[[ "$STOP_ONLY" -eq 1 ]] && exit 0
[[ "$DO_BUILD" -eq 1 ]] && pnpm build
start_standalone
