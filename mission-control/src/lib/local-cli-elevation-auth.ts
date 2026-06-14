import type { User } from '@/lib/auth'
import { resolveEffectiveLicense, hasEntitlement, resolveUserCenterSubscriptionsUrl } from '@/lib/effective-license'
import { getProviderSubjectForUser } from '@/lib/license-resolve-context'

export type LocalCliElevationPrincipal = Pick<User, 'id' | 'tenant_id' | 'portal_tenant_role'> | {
  id?: null
  tenant_id: number
  portal_tenant_role?: string | null
}

export type LocalCliElevationGateResult =
  | { ok: true }
  | {
      ok: false
      status: number
      error: string
      code: 'elevation_requires_subscription'
      subscriptionsUrl: string
    }

export async function assertLocalCliElevationAllowed(input: {
  user: LocalCliElevationPrincipal
  elevated: boolean
}): Promise<LocalCliElevationGateResult> {
  if (!input.elevated) return { ok: true }

  const license = await resolveEffectiveLicense({
    tenantId: input.user.tenant_id,
    zitadelSub: input.user.id ? getProviderSubjectForUser(input.user.id) : null,
    portalTenantRole: input.user.portal_tenant_role,
  })

  if (hasEntitlement(license, 'enableLocalCliElevation')) {
    return { ok: true }
  }

  return {
    ok: false,
    status: 403,
    error: '本地 CLI 提权需要订阅 enableLocalCliElevation 权益，请先前往用户中心订阅。',
    code: 'elevation_requires_subscription',
    subscriptionsUrl: resolveUserCenterSubscriptionsUrl(),
  }
}

export async function resolveLocalCliElevationEntitled(input: {
  user: LocalCliElevationPrincipal
}): Promise<{ entitled: boolean; subscriptionsUrl: string }> {
  const license = await resolveEffectiveLicense({
    tenantId: input.user.tenant_id,
    zitadelSub: input.user.id ? getProviderSubjectForUser(input.user.id) : null,
    portalTenantRole: input.user.portal_tenant_role,
  })

  return {
    entitled: hasEntitlement(license, 'enableLocalCliElevation'),
    subscriptionsUrl: resolveUserCenterSubscriptionsUrl(),
  }
}
