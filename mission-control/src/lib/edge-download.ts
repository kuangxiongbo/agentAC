import fs from 'node:fs'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { resolveDistributionEnrollToken } from '@/lib/edge-bootstrap'
import { resolveBundledTrayFromManifest } from '@/lib/edge-tray-manifest'
import { getDatabase } from '@/lib/db'
import type { User } from '@/lib/auth'

export function inferCenterUrl(request: NextRequest): string {
  const forwardedProto = request.headers.get('x-forwarded-proto')
  const forwardedHost = request.headers.get('x-forwarded-host')
  const host = forwardedHost || request.headers.get('host') || 'localhost:5000'
  const proto = forwardedProto || (host.includes('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
  return `${proto}://${host}`.replace(/\/+$/, '')
}

export function resolveEnrollToken(user?: Pick<User, 'id' | 'tenant_id' | 'workspace_id'>): string {
  return resolveDistributionEnrollToken(user).token
}

export function resolveEnrollTokenMeta(user?: Pick<User, 'id' | 'tenant_id' | 'workspace_id'>) {
  return resolveDistributionEnrollToken(user)
}

export function resolveEnterpriseName(user?: Pick<User, 'tenant_id'>): string {
  if (user?.tenant_id) {
    try {
      const db = getDatabase()
      const row = db
        .prepare('SELECT display_name, slug FROM tenants WHERE id = ? LIMIT 1')
        .get(user.tenant_id) as { display_name?: string; slug?: string } | undefined
      const name = String(row?.display_name || row?.slug || '').trim()
      if (name) return name
    } catch {
      // ignore
    }
  }
  return (
    (process.env.MC_EDGE_ENTERPRISE_NAME || process.env.MC_EDGE_ORGANIZATION_NAME || '').trim() ||
    'E-Agent Enterprise'
  )
}

export function resolveTrayVersion(centerUrl: string): string {
  const bundled = resolveBundledTrayFromManifest(centerUrl)
  if (bundled?.center_version) return bundled.center_version
  return (process.env.MC_EDGE_TRAY_VERSION || process.env.npm_package_version || '2.0.1').trim()
}

export function maskSecret(value: string): string {
  const v = value.trim()
  if (!v) return ''
  if (v.length <= 8) return '••••••••'
  return `${v.slice(0, 4)}${'•'.repeat(Math.min(12, v.length - 8))}${v.slice(-4)}`
}

export function resolveTrayDownloadUrl(centerUrl: string): string | null {
  const explicit = (process.env.MC_EDGE_TRAY_DOWNLOAD_URL || process.env.EDGE_TRAY_DOWNLOAD_URL || '').trim()
  if (explicit) {
    if (explicit.startsWith('http://') || explicit.startsWith('https://')) return explicit
    const pathPart = explicit.startsWith('/') ? explicit : `/${explicit}`
    return `${centerUrl.replace(/\/+$/, '')}${pathPart}`
  }

  const bundled = resolveBundledTrayFromManifest(centerUrl)
  if (bundled?.download_url) return bundled.download_url

  const legacy = path.join(process.cwd(), 'public', 'edge-tray', 'E-Agent-Edge.dmg')
  if (fs.existsSync(legacy)) {
    return `${centerUrl.replace(/\/+$/, '')}/edge-tray/E-Agent-Edge.dmg`
  }

  return null
}

export function buildMacInstallScript(centerUrl: string, enrollToken: string): string {
  const config = JSON.stringify(
    {
      center_url: centerUrl.replace(/\/+$/, ''),
      enroll_token: enrollToken,
    },
    null,
    2,
  )

  return `#!/bin/bash
set -euo pipefail
EDGE_DIR="$HOME/.e-agent-edge"
mkdir -p "$EDGE_DIR"
cat > "$EDGE_DIR/config.json" <<'MC_EDGE_CONFIG_EOF'
${config}
MC_EDGE_CONFIG_EOF
echo "已写入 $EDGE_DIR/config.json"
echo "请安装 E-Agent Edge 后启动，将自动连接服务中心。"
`
}
