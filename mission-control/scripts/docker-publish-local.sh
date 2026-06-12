#!/usr/bin/env bash
# 本机 pnpm build 后打 runtime 镜像并推送（跳过 Docker 内 apt/pnpm，适合国内网络）
# ⚠ 仅本机 CPU 架构（Mac M → linux/arm64）。生产 x86 服务器请用 scripts/docker-publish-multiarch.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
IMAGE="${MC_IMAGE:-crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter:${VERSION}}"
PUSH="${MC_DOCKER_PUSH:-1}"

bash scripts/sync-edge-runtime-bundle.sh --skip-build 2>/dev/null || bash scripts/sync-edge-runtime-bundle.sh
bash scripts/sync-edge-tray-bundle.sh --skip-build 2>/dev/null || bash scripts/sync-edge-tray-bundle.sh

if [[ ! -f public/edge-tray/manifest.json ]]; then
  echo "error: missing public/edge-tray/manifest.json — run scripts/sync-edge-tray-bundle.sh on macOS" >&2
  exit 1
fi

echo "==> pnpm build (local)"
pnpm install --frozen-lockfile
pnpm build

if [[ ! -f .next/standalone/server.js ]]; then
  echo "error: missing .next/standalone/server.js" >&2
  exit 1
fi

echo "==> docker build (runtime-only) → $IMAGE"
IGNORE_BACKUP=""
if [[ -f .dockerignore ]]; then
  IGNORE_BACKUP=".dockerignore.bak.$$"
  cp .dockerignore "$IGNORE_BACKUP"
  trap '[[ -n "$IGNORE_BACKUP" && -f "$IGNORE_BACKUP" ]] && mv "$IGNORE_BACKUP" .dockerignore' EXIT
  cp .dockerignore.publish .dockerignore
fi
docker build -f Dockerfile.runtime-only \
  --build-arg MC_VERSION="$VERSION" \
  -t "$IMAGE" .

if [[ "$PUSH" == "1" ]]; then
  echo "==> docker push $IMAGE"
  docker push "$IMAGE"
  echo "==> done: $IMAGE"
else
  echo "==> built locally (MC_DOCKER_PUSH=0, skip push)"
fi
