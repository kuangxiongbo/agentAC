#!/usr/bin/env bash
# Cross-platform OCI image: linux/amd64 + linux/arm64 (manifest list).
# Requires: Docker Buildx (docker-container driver so QEMU can build foreign arches).
#
# Examples:
#   MC_IMAGE=ghcr.io/myorg/agentcenter:2.0.1 MC_DOCKER_PUSH=1 bash scripts/docker-buildx-multiarch.sh
#   MC_IMAGE=ghcr.io/myorg/agentcenter:2.0.1 MC_IMAGE_LATEST=ghcr.io/myorg/agentcenter:latest MC_DOCKER_PUSH=1 bash scripts/docker-buildx-multiarch.sh
#
# Local single-arch load (e.g. test amd64 image on disk):
#   MC_DOCKER_PLATFORM=linux/amd64 MC_IMAGE=agentcenter:test MC_DOCKER_LOAD=1 bash scripts/docker-buildx-multiarch.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Edge 托盘 runtime zip（与 client 同版本）；缺失则自动 sync
if [[ ! -f public/edge-runtime/manifest.json ]] || [[ ! -f public/edge-runtime/client-runtime-"$(node -p "require('./package.json').version")"-darwin-aarch64.zip ]]; then
  printf '[docker-buildx] syncing edge runtime bundle…\n'
  bash scripts/sync-edge-runtime-bundle.sh
fi

BUILDER_NAME="${MC_DOCKER_BUILDX_BUILDER:-mc-multiarch}"
PLATFORM="${MC_DOCKER_PLATFORM:-linux/amd64,linux/arm64}"
IMAGE="${MC_IMAGE:-}"
IMAGE_LATEST="${MC_IMAGE_LATEST:-}"
PUSH="${MC_DOCKER_PUSH:-0}"
LOAD="${MC_DOCKER_LOAD:-0}"

usage() {
  cat <<'EOF'
用法 / Usage:
  MC_IMAGE=<registry/repo:tag> [MC_IMAGE_LATEST=...] [MC_DOCKER_PUSH=1] bash scripts/docker-buildx-multiarch.sh

环境变量 / Environment:
  MC_IMAGE              必填（推送或 load 时）完整镜像名含 tag
  MC_IMAGE_LATEST       可选，额外打 latest（或第二 tag）并写入同一 manifest
  MC_DOCKER_PUSH=1       推送到仓库（多架构必须用 push，不能 --load 多平台）
  MC_DOCKER_LOAD=1       仅单平台时：构建并 docker load 到本机（需 MC_DOCKER_PLATFORM=linux/amd64 或 linux/arm64）
  MC_DOCKER_PLATFORM      默认 linux/amd64,linux/arm64
  MC_DOCKER_BUILDX_BUILDER  默认 mc-multiarch
  MC_VERSION            可选，覆盖镜像 label（默认读取 package.json version）

推送前请先: docker login <registry>
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "error: docker buildx 不可用，请升级 Docker Desktop / Docker Engine" >&2
  exit 1
fi

VERSION="${MC_VERSION:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo dev)"
fi

if [[ -z "$IMAGE" ]]; then
  echo "error: 请设置 MC_IMAGE，例如 MC_IMAGE=ghcr.io/org/agentcenter:2.0.1" >&2
  usage
  exit 1
fi

if [[ "$LOAD" == "1" ]]; then
  if [[ "$PLATFORM" == *","* ]]; then
    echo "error: MC_DOCKER_LOAD=1 时 MC_DOCKER_PLATFORM 只能为单一架构，例如 linux/amd64" >&2
    exit 1
  fi
  PUSH=0
fi

if [[ "$PUSH" != "1" && "$LOAD" != "1" ]]; then
  echo "error: 请设置 MC_DOCKER_PUSH=1（推多架构）或 MC_DOCKER_LOAD=1（单架构载入本机）" >&2
  usage
  exit 1
fi

if docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker buildx use "$BUILDER_NAME"
  docker buildx inspect "$BUILDER_NAME" --bootstrap >/dev/null 2>&1 || true
else
  echo "creating buildx builder: $BUILDER_NAME (driver=docker-container)"
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --use --bootstrap
fi

TAG_ARGS=( -t "$IMAGE" )
if [[ -n "$IMAGE_LATEST" ]]; then
  TAG_ARGS+=( -t "$IMAGE_LATEST" )
fi

BUILD_ARGS=(
  build
  --network=host
  --platform "$PLATFORM"
  -f Dockerfile
  --build-arg "MC_VERSION=$VERSION"
  --build-arg "APT_MIRROR=mirrors.aliyun.com"
  "${TAG_ARGS[@]}"
  --provenance=false
  --sbom=false
)

if [[ "$PUSH" == "1" ]]; then
  echo "buildx push: platform=$PLATFORM tags=$IMAGE${IMAGE_LATEST:+ $IMAGE_LATEST}"
  docker buildx "${BUILD_ARGS[@]}" --push .
elif [[ "$LOAD" == "1" ]]; then
  echo "buildx load: platform=$PLATFORM tag=$IMAGE"
  docker buildx "${BUILD_ARGS[@]}" --load .
fi

echo "done."
