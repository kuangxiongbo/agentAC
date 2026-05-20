import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/auth'
import {
  APP_STAGE,
  LICENSE_APP_ID,
  OIDC_APPLICATION_ID,
  OIDC_INSTANCE_CLIENT_ID,
} from '@/lib/license-verifier'
import {
  getLicenseSetting,
  LICENSE_CENTER_URL_KEY,
  setLicenseSetting,
} from '@/lib/license-settings-store'

function readCenterUrl(): string {
  const stored = getLicenseSetting(LICENSE_CENTER_URL_KEY)
  if (stored != null && String(stored).trim()) return String(stored).trim()
  return String(process.env.USER_CENTER_API_URL || process.env.USERCENTER_ORIGIN || '').trim()
}

export async function GET(request: Request) {
  const user = getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  return NextResponse.json({
    licenseCenterUrl: readCenterUrl() || null,
    appId: LICENSE_APP_ID,
    oidcClientId: OIDC_INSTANCE_CLIENT_ID || null,
    applicationId: OIDC_APPLICATION_ID || null,
    stage: APP_STAGE || null,
  })
}

export async function PATCH(request: NextRequest) {
  const user = getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  if (user.role !== 'admin') {
    return NextResponse.json({ error: 'Requires admin role' }, { status: 403 })
  }

  const body = (await request.json().catch(() => ({}))) as { licenseCenterUrl?: unknown }
  const url = typeof body.licenseCenterUrl === 'string' ? body.licenseCenterUrl.trim() : ''

  setLicenseSetting(LICENSE_CENTER_URL_KEY, url, {
    category: 'license',
    description: 'User center API URL for license verification',
    updatedBy: user.username,
  })
  if (url) {
    process.env.USER_CENTER_API_URL = url
  }

  return NextResponse.json({ ok: true, licenseCenterUrl: url || null })
}
