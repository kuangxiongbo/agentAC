import { NextRequest, NextResponse } from 'next/server'
import {
  loadEdgeRuntimeManifest,
  requestPublicOrigin,
  resolveManifestPublicUrls,
} from '@/lib/edge-runtime-manifest'

/**
 * Edge tray first-run manifest: platforms → zip URL + sha256.
 * Priority: EDGE_RUNTIME_MANIFEST_JSON → EDGE_RUNTIME_MANIFEST_PATH → bundled public/edge-runtime/manifest.json
 */
export async function GET(request: NextRequest) {
  const manifest = loadEdgeRuntimeManifest()
  if (!manifest) {
    return NextResponse.json(
      {
        error:
          'Edge runtime manifest not configured. Run mission-control/scripts/sync-edge-runtime-bundle.sh before docker build, or set EDGE_RUNTIME_MANIFEST_PATH.',
      },
      { status: 503 },
    )
  }

  const origin = requestPublicOrigin(request)
  const body = resolveManifestPublicUrls(manifest, origin)

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
