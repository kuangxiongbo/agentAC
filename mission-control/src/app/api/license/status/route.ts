import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/auth'
import { resolveEffectiveLicense, resolveUserCenterSubscriptionsUrl } from '@/lib/effective-license'
import { getProviderSubjectForUser } from '@/lib/license-resolve-context'

export async function GET(request: Request) {
  const user = getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const license = await resolveEffectiveLicense({
    tenantId: user.tenant_id,
    zitadelSub: getProviderSubjectForUser(user.id),
    portalTenantRole: user.portal_tenant_role,
  })

  return NextResponse.json({
    mode: license.source,
    licensed: license.licensed,
    allowed: license.allowed,
    reason: license.reason,
    entitlements: license.entitlements,
    expiresAt: license.expiresAt,
    requiresSubscription: license.requiresSubscription,
    appId: license.appId,
    displayName: license.displayName,
    subscriptionsUrl: resolveUserCenterSubscriptionsUrl(),
  })
}
