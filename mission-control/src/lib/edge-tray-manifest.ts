import fs from 'node:fs'
import path from 'node:path'

export type EdgeTrayManifest = {
  schema: number
  center_version: string
  tray_version: string
  published_at: string
  platforms: Record<
    string,
    {
      url: string
      sha256: string
      filename?: string
    }
  >
}

const BUNDLED_MANIFEST = path.join(process.cwd(), 'public', 'edge-tray', 'manifest.json')
const DEFAULT_PLATFORM = 'darwin-aarch64'

export function loadEdgeTrayManifest(): EdgeTrayManifest | null {
  const envPath = (process.env.EDGE_TRAY_MANIFEST_PATH || '').trim()
  const candidates = [envPath, BUNDLED_MANIFEST].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) as EdgeTrayManifest
      if (raw?.platforms && typeof raw.platforms === 'object') return raw
    } catch {
      // try next
    }
  }
  return null
}

export function resolveTrayPlatformEntry(
  manifest: EdgeTrayManifest | null,
  platform = DEFAULT_PLATFORM,
): { url: string; sha256: string; filename: string } | null {
  if (!manifest?.platforms) return null
  const entry = manifest.platforms[platform] || manifest.platforms[DEFAULT_PLATFORM]
  if (!entry?.url) return null
  return {
    url: entry.url,
    sha256: entry.sha256,
    filename: entry.filename || 'E-Agent-Edge.dmg',
  }
}

export function resolveManifestPublicUrl(relativeOrAbsolute: string, centerUrl: string): string {
  const trimmed = relativeOrAbsolute.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  const base = centerUrl.replace(/\/+$/, '')
  return `${base}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`
}

export function resolveBundledTrayFromManifest(centerUrl: string): {
  download_url: string
  center_version: string
  tray_version: string
  sha256: string
  filename: string
} | null {
  const manifest = loadEdgeTrayManifest()
  const entry = resolveTrayPlatformEntry(manifest)
  if (!manifest || !entry) return null
  return {
    download_url: resolveManifestPublicUrl(entry.url, centerUrl),
    center_version: manifest.center_version,
    tray_version: manifest.tray_version,
    sha256: entry.sha256,
    filename: entry.filename,
  }
}
