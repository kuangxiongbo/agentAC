import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import {
  inferCenterUrl,
  maskSecret,
  resolveEnterpriseName,
  resolveEnrollTokenMeta,
  resolveTrayDownloads,
  resolveTrayDownloadUrl,
  resolveTrayVersion,
} from '@/lib/edge-download'

export const dynamic = 'force-dynamic'

/**
 * GET /api/edge/download-info — Edge tray download page data (session required).
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const centerUrl = inferCenterUrl(request)
  const enrollMeta = resolveEnrollTokenMeta(auth.user)
  const enrollToken = enrollMeta.token
  const trayDownloadUrl = resolveTrayDownloadUrl(centerUrl)
  const trayVersion = resolveTrayVersion(centerUrl)

  return NextResponse.json(
    {
      center_url: centerUrl,
      enterprise_name: resolveEnterpriseName(auth.user),
      enroll_token_configured: Boolean(enrollToken),
      enroll_token: enrollToken,
      enroll_token_source: enrollMeta.source,
      enroll_token_options: enrollMeta.multiTokens || [],
      enroll_token_masked: enrollToken ? maskSecret(enrollToken) : '',
      tray_download_url: trayDownloadUrl,
      tray_version: trayVersion,
      tray_downloads: resolveTrayDownloads(centerUrl),
      platform: 'darwin',
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
