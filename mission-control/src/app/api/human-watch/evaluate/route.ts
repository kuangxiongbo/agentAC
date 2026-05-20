import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { getHumanWatchBinding } from '@/lib/human-watch-bindings'
import { evaluateHumanWatchBinding } from '@/lib/human-watch-orchestrator'
import { requireHumanWatchEntitlement } from '@/lib/human-watch-policy'

export const dynamic = 'force-dynamic'

/**
 * POST /api/human-watch/evaluate
 * Manually trigger orchestrator evaluation for one binding (operator/admin).
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const tenantId = auth.user.tenant_id ?? 1
  const policy = await requireHumanWatchEntitlement(
    tenantId,
    auth.user.id,
    auth.user.portal_tenant_role,
  )
  if (!policy.ok) {
    return NextResponse.json({ error: policy.error }, { status: policy.status })
  }

  let body: { binding_id?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const bindingId = Number(body.binding_id)
  if (!Number.isFinite(bindingId)) {
    return NextResponse.json({ error: 'binding_id is required' }, { status: 400 })
  }

  const workspaceId = auth.user.workspace_id ?? 1
  const binding = getHumanWatchBinding(bindingId, workspaceId)
  if (!binding) {
    return NextResponse.json({ error: 'Binding not found' }, { status: 404 })
  }
  if (binding.tenant_id != null && binding.tenant_id !== tenantId) {
    return NextResponse.json({ error: 'Binding not found' }, { status: 404 })
  }

  await evaluateHumanWatchBinding(binding, { trigger: 'manual_api' })

  return NextResponse.json({
    ok: true,
    binding_id: bindingId,
    worker_session_id: binding.worker_session_id,
  })
}
