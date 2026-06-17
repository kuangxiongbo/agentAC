import fs from 'node:fs'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { resolveDistributionEnrollToken } from '@/lib/edge-bootstrap'
import { loadEdgeTrayManifest, resolveBundledTrayFromManifest, resolveManifestPublicUrl } from '@/lib/edge-tray-manifest'
import { getDatabase } from '@/lib/db'
import type { User } from '@/lib/auth'
import { APP_VERSION } from '@/lib/version'

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
  if (bundled?.tray_version) return bundled.tray_version
  return (process.env.MC_EDGE_TRAY_VERSION || process.env.npm_package_version || APP_VERSION).trim()
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

export type TrayPlatformDownload = {
  platform: string
  arch_label: string
  cpu_family: 'apple_silicon' | 'intel' | 'unknown'
  tray_version: string
  download_url: string | null
  filename: string | null
  sha256: string | null
  available: boolean
}

function inferCpuFamily(platform: string): TrayPlatformDownload['cpu_family'] {
  if (platform === 'darwin-aarch64') return 'apple_silicon'
  if (platform === 'darwin-x86_64') return 'intel'
  return 'unknown'
}

function inferArchLabel(platform: string): string {
  if (platform === 'darwin-aarch64') return 'Apple Silicon (M1 / M2 / M3 / M4)'
  if (platform === 'darwin-x86_64') return 'Intel Mac'
  return platform
}

export function resolveTrayDownloads(centerUrl: string): TrayPlatformDownload[] {
  const manifest = loadEdgeTrayManifest()
  if (!manifest?.platforms || typeof manifest.platforms !== 'object') {
    return [
      {
        platform: 'darwin-aarch64',
        arch_label: inferArchLabel('darwin-aarch64'),
        cpu_family: 'apple_silicon',
        tray_version: resolveTrayVersion(centerUrl),
        download_url: resolveTrayDownloadUrl(centerUrl),
        filename: 'E-Agent-Edge.dmg',
        sha256: null,
        available: Boolean(resolveTrayDownloadUrl(centerUrl)),
      },
      {
        platform: 'darwin-x86_64',
        arch_label: inferArchLabel('darwin-x86_64'),
        cpu_family: 'intel',
        tray_version: resolveTrayVersion(centerUrl),
        download_url: null,
        filename: 'E-Agent-Edge.dmg',
        sha256: null,
        available: false,
      },
    ]
  }

  const preferredOrder = ['darwin-aarch64', 'darwin-x86_64']
  const seen = new Set<string>()
  const result: TrayPlatformDownload[] = []

  for (const platform of [...preferredOrder, ...Object.keys(manifest.platforms)]) {
    if (seen.has(platform)) continue
    seen.add(platform)
    const entry = manifest.platforms[platform]
    result.push({
      platform,
      arch_label: inferArchLabel(platform),
      cpu_family: inferCpuFamily(platform),
      tray_version: manifest.tray_version,
      download_url: entry?.url ? resolveManifestPublicUrl(entry.url, centerUrl) : null,
      filename: entry?.filename || 'E-Agent-Edge.dmg',
      sha256: entry?.sha256 || null,
      available: Boolean(entry?.url),
    })
  }

  return result
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
