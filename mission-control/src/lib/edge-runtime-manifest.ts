import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export type EdgeRuntimeManifest = {
  schema: number
  client_version: string
  tray_min_version?: string
  published_at?: string
  platforms: Record<string, { url: string; sha256: string }>
}

const BUNDLED_MANIFEST = path.join(process.cwd(), 'public', 'edge-runtime', 'manifest.json')

function parseManifest(raw: string): EdgeRuntimeManifest | null {
  try {
    const body = JSON.parse(raw) as EdgeRuntimeManifest
    if (!body?.platforms || typeof body.platforms !== 'object') return null
    return body
  } catch {
    return null
  }
}

/** Resolve relative zip URLs (`/edge-runtime/...`) against public site origin. */
export function resolveManifestPublicUrls(
  manifest: EdgeRuntimeManifest,
  publicOrigin: string,
): EdgeRuntimeManifest {
  const base = publicOrigin.replace(/\/+$/, '')
  const platforms: EdgeRuntimeManifest['platforms'] = {}
  for (const [key, art] of Object.entries(manifest.platforms)) {
    const url = art.url.trim()
    platforms[key] = {
      ...art,
      url: url.startsWith('/') ? `${base}${url}` : url,
    }
  }
  return { ...manifest, platforms }
}

export function requestPublicOrigin(request: Request): string {
  const headers = request.headers
  const proto = (headers.get('x-forwarded-proto') || 'https').split(',')[0]?.trim() || 'https'
  const host =
    (headers.get('x-forwarded-host') || headers.get('host') || 'localhost').split(',')[0]?.trim() ||
    'localhost'
  return `${proto}://${host}`
}

/** Env file / JSON → bundled public/edge-runtime/manifest.json */
export function loadEdgeRuntimeManifest(): EdgeRuntimeManifest | null {
  const inline = process.env.EDGE_RUNTIME_MANIFEST_JSON?.trim()
  if (inline) {
    return parseManifest(inline)
  }

  const filePath =
    process.env.EDGE_RUNTIME_MANIFEST_PATH?.trim() ||
    process.env.EDGE_RUNTIME_MANIFEST_FILE?.trim() ||
    (existsSync(BUNDLED_MANIFEST) ? BUNDLED_MANIFEST : '')

  if (!filePath) return null

  try {
    return parseManifest(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}
