import { NextRequest, NextResponse } from 'next/server'
import { getTenantIdFromRequest, requireRole } from '@/lib/auth'
import { resolveUserCenterSubscriptionsUrl } from '@/lib/effective-license'
import {
  isHumanWatchEnabledForTenant,
  resolveHumanWatchAvailability,
  setHumanWatchEnabledForTenant,
} from '@/lib/human-watch-policy'

export const dynamic = 'force-dynamic'

/**
 * GET /api/human-watch/policy — tenant human-watch feature flag
 * PATCH (admin) — enable/disable for current tenant
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const tenantId = auth.user.tenant_id ?? getTenantIdFromRequest(request)
  const state = await resolveHumanWatchAvailability(
    tenantId,
    auth.user.id,
    auth.user.portal_tenant_role,
  )
  return NextResponse.json({
    tenant_id: tenantId,
    /** @deprecated 与 available 相同；保留兼容 */
    enabled: state.available,
    available: state.available,
    subscription_entitled: state.subscriptionEntitled,
    tenant_flag: state.tenantFlag,
    env_override: state.envOverride,
    subscriptions_url: resolveUserCenterSubscriptionsUrl(),
  })
}

export async function PATCH(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: { enabled?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled (boolean) is required' }, { status: 400 })
  }

  const tenantId = auth.user.tenant_id ?? getTenantIdFromRequest(request)
  setHumanWatchEnabledForTenant(tenantId, body.enabled)

  return NextResponse.json({
    tenant_id: tenantId,
    enabled: isHumanWatchEnabledForTenant(tenantId),
  })
}
