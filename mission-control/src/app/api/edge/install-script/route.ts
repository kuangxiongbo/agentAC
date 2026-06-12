import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { buildMacInstallScript, inferCenterUrl, resolveEnrollTokenMeta } from '@/lib/edge-download'

export const dynamic = 'force-dynamic'

/**
 * GET /api/edge/install-script — macOS config bootstrap script (session required).
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const enrollToken = resolveEnrollTokenMeta(auth.user).token
  if (!enrollToken) {
    return NextResponse.json(
      { error: 'Edge enroll token not configured (set MC_EDGE_ENROLL_TOKEN or API_KEY)' },
      { status: 503 },
    )
  }

  const centerUrl = inferCenterUrl(request)
  const script = buildMacInstallScript(centerUrl, enrollToken)

  return new NextResponse(script, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="e-agent-edge-config.command"',
      'Cache-Control': 'private, no-store',
    },
  })
}
