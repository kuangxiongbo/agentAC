import { NextRequest, NextResponse } from 'next/server'
import { fetchCenterRuntimeManifestViaWebClient } from '@/lib/edge-center-proxy'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function isLoopback(request: NextRequest): boolean {
  const forwarded = (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim()
  const host = forwarded || request.headers.get('x-real-ip') || ''
  if (!host) return true
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

export async function GET(request: NextRequest) {
  if (!isLoopback(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const result = await fetchCenterRuntimeManifestViaWebClient()
  if ('error' in result) {
    return NextResponse.json({ error: result.error, meta: { via: 'web-client' } }, { status: result.status })
  }
  return NextResponse.json({
    ...(typeof result.manifest === 'object' && result.manifest ? result.manifest : {}),
    _meta: result.meta,
  })
}
