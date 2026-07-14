import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getHumanWatchHealthSummary } from '@/lib/human-watch-health'
import { requireHumanWatchEntitlement } from '@/lib/human-watch-policy'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const tenantId = auth.user.tenant_id ?? 1
  const policy = await requireHumanWatchEntitlement(
    tenantId,
    auth.user.id,
    auth.user.portal_tenant_role,
  )
  if (!policy.ok) {
    return NextResponse.json({ error: policy.error }, { status: policy.status })
  }

  const rawWindow = request.nextUrl.searchParams.get('window_seconds')?.trim()
  const windowSeconds = rawWindow ? Number(rawWindow) : undefined
  if (rawWindow && (!Number.isFinite(windowSeconds) || Number(windowSeconds) <= 0)) {
    return NextResponse.json({ error: 'Invalid window_seconds' }, { status: 400 })
  }

  return NextResponse.json(getHumanWatchHealthSummary({
    workspaceId: auth.user.workspace_id ?? 1,
    tenantId,
    windowSeconds,
  }))
}
