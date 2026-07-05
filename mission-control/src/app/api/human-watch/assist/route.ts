import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { requireHumanWatchEntitlement } from '@/lib/human-watch-policy'
import { triggerHumanWatchAssist } from '@/lib/human-watch-assist'

export const dynamic = 'force-dynamic'

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

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

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const result = await triggerHumanWatchAssist({
      workspaceId: auth.user.workspace_id ?? 1,
      tenantId,
      clientId: typeof body.client_id === 'string' ? body.client_id.trim() : null,
      bindingId: numberOrNull(body.binding_id),
      workerLocalAgentId: numberOrNull(body.worker_local_agent_id),
      workerSessionId: typeof body.worker_session_id === 'string' ? body.worker_session_id : null,
      sessionKind: typeof body.session_kind === 'string' ? body.session_kind : null,
      title: typeof body.title === 'string' ? body.title : null,
      prompt: String(body.prompt || ''),
      workerName: typeof body.worker_name === 'string' ? body.worker_name : null,
      context:
        body.context && typeof body.context === 'object' && !Array.isArray(body.context)
          ? body.context as Record<string, unknown>
          : null,
      source: 'worker_mcp',
    })
    return NextResponse.json({
      ok: true,
      event_id: result.eventId,
      delivered: result.delivered,
      reply: result.stewardReply,
      session_id: result.sessionId,
      binding_id: result.binding.id,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to trigger human-watch assist'
    const status = /not found/i.test(message) ? 404 : /offline|not connected/i.test(message) ? 503 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
