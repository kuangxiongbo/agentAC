#!/usr/bin/env bash
# 本地客户端端口规划（避免彼此及中心服冲突）
#
#   5001  MC_DEV_PORT         — 开发热更新（pnpm dev / dev-restart）
#   5101  MC_STANDALONE_PORT   — 独立/生产构建运行（start-standalone、install、deploy-standalone）
#   3000  — 留给中心服 / 远程 Gateway，客户端默认不占
#
# 覆盖示例：MC_DEV_PORT=5002 MC_STANDALONE_PORT=5102 bash scripts/dev-restart.sh
#
# 边缘 24h（standalone）：默认 MC_KEEP_AWAKE=1，macOS 用 caffeinate 阻止系统待机（可息屏）
# 关闭：MC_KEEP_AWAKE=0 bash scripts/start-standalone.sh

: "${MC_DEV_PORT:=5001}"
: "${MC_STANDALONE_PORT:=5101}"
export MC_DEV_PORT MC_STANDALONE_PORT
