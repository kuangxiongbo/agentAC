import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function isLoopback(request: NextRequest): boolean {
  const forwarded = (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim()
  const host = forwarded || request.headers.get('x-real-ip') || ''
  if (!host) return true
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function getSetting(db: ReturnType<typeof getDatabase>, key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
  const value = typeof row?.value === 'string' ? row.value.trim() : ''
  return value || fallback
}

/**
 * GET /api/edge/tray-config — Tray reads local Web client connection settings (loopback only).
 */
export async function GET(request: NextRequest) {
  if (!isLoopback(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = getDatabase()
  const centerUrl = getSetting(db, 'gateway.server_url')
  const gatewayToken = getSetting(db, 'gateway.token')
  const enrollToken = getSetting(db, 'edge.enroll_token') || gatewayToken
  const clientName = getSetting(db, 'gateway.client_name', 'LocalClient')
  const deviceClientId = getSetting(db, 'device.client_id')
  const enterpriseName = getSetting(db, 'edge.enterprise_name')
  const enterpriseSlug = getSetting(db, 'edge.enterprise_slug')
  const tenantId = getSetting(db, 'edge.tenant_id')
  const port = parseInt(process.env.PORT || '5101', 10) || 5101

  return NextResponse.json({
    center_url: centerUrl,
    enroll_token: enrollToken,
    gateway_token: gatewayToken,
    client_name: clientName,
    device_client_id: deviceClientId,
    enterprise_name: enterpriseName,
    enterprise_slug: enterpriseSlug,
    tenant_id: tenantId ? Number(tenantId) : null,
    port,
    source: 'mission-control-client',
  })
}
