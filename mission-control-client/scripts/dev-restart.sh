#!/usr/bin/env bash
# 快速重启本地客户端 dev 服务（默认 127.0.0.1:5001）
# 用法:
#   ./scripts/dev-restart.sh           # 杀进程后在后台启动
#   ./scripts/dev-restart.sh -f      # 前台启动（占用当前终端）
#   ./scripts/dev-restart.sh --stop    # 仅停止

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=mc-ports.sh
source "$ROOT/scripts/mc-ports.sh"

HOST="${MC_DEV_HOST:-127.0.0.1}"
PORT="${MC_DEV_PORT}"
PID_FILE="$ROOT/.dev-server.pid"
LOG_FILE="$ROOT/.dev-server.log"
FOREGROUND=0
STOP_ONLY=0

usage() {
  cat <<EOF
用法: $(basename "$0") [选项]

  停止占用 ${HOST}:${PORT} 的进程及本项目的 next dev，然后重新执行 pnpm dev。

选项:
  -f, --foreground   前台运行（默认后台 + 日志写入 ${LOG_FILE})
  --stop             仅停止，不启动
  -h, --help         显示帮助

环境变量:
  MC_DEV_HOST        监听地址（默认 127.0.0.1）
  MC_DEV_PORT        开发端口（默认 5001；standalone 用 5101，见 scripts/mc-ports.sh）
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--foreground) FOREGROUND=1; shift ;;
    --stop) STOP_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

list_port_pids() {
  local combined=""
  if command -v lsof >/dev/null 2>&1; then
    combined+="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"$'\n'
  fi
  printf '%s\n' "$combined" | awk '/^[0-9]+$/ { if (!seen[$0]++) print $0 }'
}

list_project_dev_pids() {
  if ! command -v pgrep >/dev/null 2>&1; then
    return
  fi
  pgrep -f "next dev --hostname ${HOST} --port ${PORT}" 2>/dev/null || true
  pgrep -f "next dev.*--port ${PORT}" 2>/dev/null || true
  pgrep -f "${ROOT}.*next dev" 2>/dev/null || true
}

stop_pid() {
  local pid="$1"
  local label="$2"
  [[ -z "$pid" ]] && return
  if ! kill -0 "$pid" 2>/dev/null; then
    return
  fi
  echo "==> 停止 ${label} (pid=${pid})"
  kill "$pid" 2>/dev/null || true
  local i=0
  while kill -0 "$pid" 2>/dev/null && [[ $i -lt 10 ]]; do
    sleep 0.5
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "==> 强制结束 (pid=${pid})"
    kill -9 "$pid" 2>/dev/null || true
  fi
}

stop_all() {
  local -a pids=()
  local pid

  if [[ -f "$PID_FILE" ]]; then
    stop_pid "$(cat "$PID_FILE" 2>/dev/null || true)" "上次 dev (pid 文件)"
    rm -f "$PID_FILE"
  fi

  while IFS= read -r pid; do
    pids+=("$pid")
  done < <(list_port_pids)

  while IFS= read -r pid; do
    pids+=("$pid")
  done < <(list_project_dev_pids)

  if [[ ${#pids[@]} -eq 0 ]]; then
    echo "==> 未发现 ${HOST}:${PORT} 相关进程"
    return
  fi

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    stop_pid "$pid" "端口 ${PORT} / next dev"
  done < <(printf '%s\n' "${pids[@]}" | awk '/^[0-9]+$/' | sort -u)

  sleep 1
  if list_port_pids | grep -q .; then
    echo "警告: 端口 ${PORT} 仍被占用，请手动检查: lsof -iTCP:${PORT} -sTCP:LISTEN" >&2
    exit 1
  fi
  echo "==> 端口 ${PORT} 已释放"
}

wait_ready() {
  local url="http://${HOST}:${PORT}/"
  local i=0
  while [[ $i -lt 90 ]]; do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then
      echo "==> 服务就绪: ${url}"
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  echo "警告: 等待超时，请查看日志: ${LOG_FILE}" >&2
  return 1
}

start_dev() {
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "错误: 未找到 pnpm" >&2
    exit 1
  fi

  if [[ "$FOREGROUND" -eq 1 ]]; then
    echo "==> 前台启动: pnpm dev (${HOST}:${PORT})"
    exec pnpm dev
  fi

  echo "==> 后台启动: pnpm dev (${HOST}:${PORT})"
  echo "    日志: ${LOG_FILE}"
  nohup pnpm dev >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  wait_ready || true
  echo "==> PID: $(cat "$PID_FILE")  |  停止: $0 --stop"
}

echo "==> mission-control-client dev 重启 (${HOST}:${PORT}) | standalone=${MC_STANDALONE_PORT}"
stop_all

if [[ "$STOP_ONLY" -eq 1 ]]; then
  exit 0
fi

start_dev
