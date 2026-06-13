#!/usr/bin/env bash
# Sync core release documents into mission-control/public so the Docker image
# can serve the exact documentation snapshot shipped with the release.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MC_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MC_ROOT/.." && pwd)"
OUT_DIR="$MC_ROOT/public/project-docs"
VERSION="$(node -p "require('$MC_ROOT/package.json').version")"

mkdir -p "$OUT_DIR/core" "$OUT_DIR/releases/mission-control" "$OUT_DIR/releases/mission-control-client"

copy_required() {
  local src="$1"
  local dest="$2"
  if [[ ! -f "$src" ]]; then
    echo "error: missing required document: $src" >&2
    exit 1
  fi
  cp -f "$src" "$dest"
}

copy_required "$REPO_ROOT/文档/00-核心主文档/01-主需求文档.md" "$OUT_DIR/core/01-主需求文档.md"
copy_required "$REPO_ROOT/文档/00-核心主文档/02-主架构文档.md" "$OUT_DIR/core/02-主架构文档.md"
copy_required "$REPO_ROOT/文档/00-核心主文档/03-主接口文档.md" "$OUT_DIR/core/03-主接口文档.md"
copy_required "$MC_ROOT/docs/releases/$VERSION.md" "$OUT_DIR/releases/mission-control/$VERSION.md"
copy_required "$REPO_ROOT/mission-control-client/docs/releases/$VERSION.md" "$OUT_DIR/releases/mission-control-client/$VERSION.md"

PUBLISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

VERSION="$VERSION" PUBLISHED_AT="$PUBLISHED_AT" OUT_DIR="$OUT_DIR" node <<'NODE'
const fs = require('fs')
const path = require('path')
const manifest = {
  schema: 1,
  version: process.env.VERSION,
  published_at: process.env.PUBLISHED_AT,
  documents: {
    master_prd: '/project-docs/core/01-主需求文档.md',
    master_architecture: '/project-docs/core/02-主架构文档.md',
    master_api: '/project-docs/core/03-主接口文档.md',
    server_release_notes: `/project-docs/releases/mission-control/${process.env.VERSION}.md`,
    client_release_notes: `/project-docs/releases/mission-control-client/${process.env.VERSION}.md`,
  },
}
fs.writeFileSync(path.join(process.env.OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
NODE

echo "==> synced project docs to $OUT_DIR"
