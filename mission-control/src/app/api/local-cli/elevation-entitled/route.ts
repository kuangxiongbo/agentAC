import { NextResponse } from 'next/server'
import { getUserFromRequest, requireRole } from '@/lib/auth'
import { type LocalCliElevationPrincipal, resolveLocalCliElevationEntitled } from '@/lib/local-cli-elevation-auth'
import { validateScopedDistributionEnrollToken } from '@/lib/edge-bootstrap'

function parseEdgeTenantId(request: Request): number | null {
  const raw = (request.headers.get('x-edge-tenant-id') || '').trim()
  if (!/^\d+$/.test(raw)) return null
  const tenantId = Number(raw)
  return Number.isSafeInteger(tenantId) && tenantId > 0 ? tenantId : null
}

export function resolveScopedEdgePrincipal(request: Request): LocalCliElevationPrincipal | null {
  const scopedToken = (request.headers.get('x-edge-enroll-token') || '').trim()
  const scopedClaims = validateScopedDistributionEnrollToken(scopedToken)
  if (!scopedClaims) return null
  return {
    id: scopedClaims.uid,
    tenant_id: scopedClaims.tid,
    portal_tenant_role: null,
  }
}

export async function GET(request: Request) {
  const scopedPrincipal = resolveScopedEdgePrincipal(request)
  if (scopedPrincipal) {
    const result = await resolveLocalCliElevationEntitled({
      user: scopedPrincipal,
    })
    return NextResponse.json(result)
  }

  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const user = getUserFromRequest(request)
  const edgeTenantId = parseEdgeTenantId(request)
  const isApiPrincipal = Boolean(user && user.id <= 0)
  const principal =
    isApiPrincipal && edgeTenantId
      ? { id: null, tenant_id: edgeTenantId, portal_tenant_role: null }
      : auth.user

  const result = await resolveLocalCliElevationEntitled({ user: principal })
  return NextResponse.json(result)
}

export const dynamic = 'force-dynamic'
