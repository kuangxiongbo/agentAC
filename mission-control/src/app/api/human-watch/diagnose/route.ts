import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { diagnoseHumanWatchBinding } from '@/lib/human-watch-diagnose'
import { requireHumanWatchEntitlement } from '@/lib/human-watch-policy'

export const dynamic = 'force-dynamic'

/**
 * GET /api/human-watch/diagnose?binding_id=
 * Dry-run why human-watch did or did not intervene for a binding.
 */
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

  const bindingIdRaw = request.nextUrl.searchParams.get('binding_id')?.trim()
  const bindingId = bindingIdRaw ? Number(bindingIdRaw) : NaN
  if (!Number.isFinite(bindingId)) {
    return NextResponse.json({ error: 'binding_id is required' }, { status: 400 })
  }

  const workspaceId = auth.user.workspace_id ?? 1
  const result = await diagnoseHumanWatchBinding(bindingId, workspaceId)
  if (!result) {
    return NextResponse.json({ error: 'Binding not found' }, { status: 404 })
  }

  return NextResponse.json(result)
}
