import { NextRequest, NextResponse } from 'next/server'
import { buildEdgeBootstrap } from '@/lib/edge-bootstrap'

export const dynamic = 'force-dynamic'

function inferCenterUrl(request: NextRequest): string {
  const forwardedProto = request.headers.get('x-forwarded-proto')
  const forwardedHost = request.headers.get('x-forwarded-host')
  const host = forwardedHost || request.headers.get('host') || 'localhost:5000'
  const proto = forwardedProto || (host.includes('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
  return `${proto}://${host}`
}

/**
 * GET /api/edge/bootstrap — Tray first-run: enterprise + bridge + runtime manifest + client name.
 *
 * Auth: x-edge-enroll-token header or ?enroll=
 * Query: hostname= (OS hostname), device_id= (stable tray id, optional)
 */
export async function GET(request: NextRequest) {
  const enrollToken =
    (request.headers.get('x-edge-enroll-token') || '').trim() ||
    (request.nextUrl.searchParams.get('enroll') || '').trim()

  const hostname =
    (request.nextUrl.searchParams.get('hostname') || '').trim() ||
    (request.headers.get('x-edge-hostname') || '').trim()

  const deviceId = (request.nextUrl.searchParams.get('device_id') || '').trim()

  const centerOverride = (request.nextUrl.searchParams.get('center_url') || '').trim()
  const centerUrl = centerOverride || inferCenterUrl(request)

  const result = buildEdgeBootstrap({
    centerUrl,
    enrollToken,
    hostname,
    deviceId,
  })

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error === 'Invalid or missing edge enroll token' ? 'Unauthorized' : result.error },
      { status: result.status },
    )
  }

  return NextResponse.json(result.payload, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
