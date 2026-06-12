#!/usr/bin/env bash
# 生产多架构 manifest：amd64（云 x86）+ arm64（Mac 本地）
# 解决 exec format error：此前 docker-publish-local 仅 arm64，x86 服务器无法启动。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
REG="${MC_REGISTRY:-crpi-c9b9bml2ajb23n5d.cn-shenzhen.personal.cr.aliyuncs.com/1sheng/agentcenter}"
TAG_AMD64="${REG}:${VERSION}-amd64"
TAG_ARM64="${REG}:${VERSION}-arm64"
TAG="${REG}:${VERSION}"

bash scripts/sync-edge-runtime-bundle.sh --skip-build 2>/dev/null || bash scripts/sync-edge-runtime-bundle.sh
bash scripts/sync-edge-tray-bundle.sh --skip-build 2>/dev/null || bash scripts/sync-edge-tray-bundle.sh

if [[ ! -f public/edge-tray/manifest.json ]]; then
  echo "error: missing public/edge-tray/manifest.json — run scripts/sync-edge-tray-bundle.sh on macOS" >&2
  exit 1
fi

echo "==> [1/3] linux/amd64 → $TAG_AMD64"
docker pull --platform linux/amd64 node:22.22.0-slim >/dev/null 2>&1 || true
docker buildx build --builder desktop-linux --platform linux/amd64 \
  -f Dockerfile \
  --build-arg "MC_VERSION=$VERSION" \
  --build-arg APT_MIRROR=mirrors.aliyun.com \
  -t "$TAG_AMD64" --push .

echo "==> [2/3] linux/arm64 → $TAG_ARM64"
MC_IMAGE="$TAG_ARM64" MC_DOCKER_PUSH=1 bash scripts/docker-publish-local.sh

echo "==> [3/3] 合并 manifest → $TAG"
docker buildx imagetools create -t "$TAG" "$TAG_AMD64" "$TAG_ARM64"

echo "==> [4/4] 更新 latest → $TAG"
docker buildx imagetools create -t "${REG}:latest" "$TAG"

echo "==> done"
docker buildx imagetools inspect "$TAG"
