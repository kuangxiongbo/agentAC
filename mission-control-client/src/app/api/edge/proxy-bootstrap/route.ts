import { NextRequest, NextResponse } from 'next/server'
import { fetchCenterBootstrapViaWebClient } from '@/lib/edge-center-proxy'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function isLoopback(request: NextRequest): boolean {
  const forwarded = (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim()
  const host = forwarded || request.headers.get('x-real-ip') || ''
  if (!host) return true
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * GET /api/edge/proxy-bootstrap — Tray uses the web client's existing center connection config
 * (gateway.server_url + gateway.token) to fetch bootstrap; avoids separate tray enroll/TLS path.
 */
export async function GET(request: NextRequest) {
  if (!isLoopback(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const hostname = request.nextUrl.searchParams.get('hostname')?.trim() || ''
  const deviceId = request.nextUrl.searchParams.get('device_id')?.trim() || ''

  const result = await fetchCenterBootstrapViaWebClient({
    hostname: hostname || undefined,
    deviceId: deviceId || undefined,
  })

  if ('error' in result) {
    return NextResponse.json(
      { error: result.error, meta: { via: 'web-client' } },
      { status: result.status },
    )
  }

  return NextResponse.json({
    ...(typeof result.payload === 'object' && result.payload ? result.payload : {}),
    _meta: result.meta,
  })
}
