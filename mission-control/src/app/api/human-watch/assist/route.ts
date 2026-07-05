import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { requireHumanWatchEntitlement } from '@/lib/human-watch-policy'
import { resolveHumanWatchAssistBinding, triggerHumanWatchAssist } from '@/lib/human-watch-assist'
import { createEdgeMessage } from '@/lib/edge-messages'
import { sendEdgeMessageWakeup } from '@/lib/bridge-server'
import { logHumanWatchIntervention } from '@/lib/human-watch-audit'

export const dynamic = 'force-dynamic'

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function reliableMessagesEnabled(): boolean {
  return process.env.MC_RELIABLE_EDGE_MESSAGES === '1'
}

function promptFingerprint(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
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

  const assistInput = {
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
    } as const
  const deliveryMode = typeof body.delivery_mode === 'string' ? body.delivery_mode : 'sync'
  const queueIfOffline = body.queue_if_offline === true || deliveryMode === 'auto' || deliveryMode === 'queue'
  const shouldUseQueue = reliableMessagesEnabled() || queueIfOffline

  try {
    if (deliveryMode === 'queue' && shouldUseQueue) {
      const queued = queueHumanWatchAssist(assistInput)
      return NextResponse.json({
        ok: true,
        delivery: queued,
        binding_id: queued.binding_id,
      })
    }

    const result = await triggerHumanWatchAssist(assistInput)
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
    if (shouldUseQueue && /offline|not connected/i.test(message)) {
      try {
        const queued = queueHumanWatchAssist(assistInput)
        return NextResponse.json({
          ok: true,
          delivery: queued,
          binding_id: queued.binding_id,
        })
      } catch (queueErr) {
        const queueMessage = queueErr instanceof Error ? queueErr.message : 'Failed to queue human-watch assist'
        return NextResponse.json({ error: queueMessage }, { status: 400 })
      }
    }
    const status = /not found/i.test(message) ? 404 : /offline|not connected/i.test(message) ? 503 : 400
    return NextResponse.json({ error: message }, { status })
  }
}

function queueHumanWatchAssist(input: Parameters<typeof triggerHumanWatchAssist>[0]) {
  const binding = resolveHumanWatchAssistBinding(input)
  if (!binding) throw new Error('Human-watch binding not found for worker session')
  if (!binding.enabled) throw new Error('Human-watch binding is disabled')
  if (!binding.steward_local_agent_id) throw new Error('Human-watch steward is not configured')

  const sessionId = String(input.workerSessionId || binding.worker_session_id || '').trim()
  if (!sessionId) throw new Error('worker_session_id is required')
  const sessionKind = String(input.sessionKind || '').trim()
  if (!sessionKind) throw new Error('session_kind is required for queued assist')
  const prompt = String(input.prompt || '').trim()
  if (!prompt) throw new Error('prompt is required')

  const idempotencyKey = `assist:${binding.id}:${sessionId}:${promptFingerprint(prompt)}`
  const correlationId = `hw-assist:${binding.id}:${sessionId}:${Date.now()}`
  const result = createEdgeMessage({
    workspaceId: binding.workspace_id,
    tenantId: binding.tenant_id,
    clientId: binding.client_id,
    type: 'human_watch.assist.requested',
    direction: 'cloud_to_edge',
    correlationId,
    idempotencyKey,
    agentRef: {
      local_agent_id: binding.worker_local_agent_id,
      agent_name: input.workerName || binding.worker_name,
    },
    sessionRef: {
      session_id: sessionId,
      session_kind: sessionKind,
      serial_key: `${binding.client_id}:${sessionKind}:${sessionId}`,
    },
    payload: {
      binding_id: binding.id,
      client_id: binding.client_id,
      worker_local_agent_id: binding.worker_local_agent_id,
      worker_name: input.workerName || binding.worker_name,
      worker_session_id: sessionId,
      session_kind: sessionKind,
      steward_local_agent_id: binding.steward_local_agent_id,
      steward_name: binding.steward_name,
      prompt,
      title: input.title || null,
      context: input.context || null,
      source: input.source || 'worker_mcp',
    },
  })
  if (result.created) {
    logHumanWatchIntervention({
      workspaceId: binding.workspace_id,
      tenantId: binding.tenant_id,
      clientId: binding.client_id,
      bindingId: binding.id,
      workerSyncIndexId: binding.worker_sync_index_id,
      workerLocalAgentId: binding.worker_local_agent_id,
      workerName: input.workerName || binding.worker_name,
      stewardSyncIndexId: binding.steward_sync_index_id,
      stewardLocalAgentId: binding.steward_local_agent_id,
      stewardName: binding.steward_name,
      workerSessionId: sessionId,
      eventType: 'intervention_attempt',
      decision: binding.mode,
      promptPreview: prompt,
      messageId: result.message.id,
      correlationId: result.message.correlation_id,
    })
    sendEdgeMessageWakeup(result.message.client_id, {
      message_id: result.message.id,
      type: result.message.type,
      correlation_id: result.message.correlation_id,
    })
  }

  return {
    mode: 'queued',
    message_id: result.message.id,
    correlation_id: result.message.correlation_id,
    queued: true,
    delivered: false,
    duplicate: result.duplicate,
    binding_id: binding.id,
  }
}
