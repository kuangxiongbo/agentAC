import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  decidePermissionRequest,
  getPermissionRequest,
  type PermissionDeciderType,
} from '@/lib/permission-requests'
import { pushPermissionDecisionToUpstream } from '@/lib/remote-server-bridge'
import { forwardPermissionDecisionToExecApproval } from '@/lib/permission-request-exec-bridge'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { id } = await context.params
  const requestId = String(id || '').trim()
  const optionId = String(body.optionId || body.option_id || '').trim()
  if (!requestId) return NextResponse.json({ error: 'request id is required' }, { status: 400 })
  if (!optionId) return NextResponse.json({ error: 'optionId is required' }, { status: 400 })

  const workspaceId = auth.user.workspace_id ?? 1
  const current = getPermissionRequest(requestId, workspaceId)
  if (!current) return NextResponse.json({ error: 'Permission request not found' }, { status: 404 })

  const deciderType = normalizeDeciderType(body.deciderType ?? body.decider_type)
  if (!deciderType) {
    return NextResponse.json({ error: 'deciderType must be human_user, steward_agent, or system' }, { status: 400 })
  }

  if (deciderType === 'steward_agent') {
    const option = current.options.find((item) => item.id === optionId)
    if (!option) return NextResponse.json({ error: 'Invalid optionId for permission request' }, { status: 400 })
    if (option.action === 'approve' && (current.risk === 'high' || current.risk === 'critical')) {
      return NextResponse.json(
        { error: 'Steward agent cannot approve high or critical permission requests' },
        { status: 403 },
      )
    }
  }

  try {
    if (deciderType === 'steward_agent') {
      const pushed = pushPermissionDecisionToUpstream({
        requestId,
        optionId,
        reason: typeof body.reason === 'string' ? body.reason : null,
        deciderAgentId:
          typeof body.deciderAgentId === 'string'
            ? body.deciderAgentId
            : typeof body.decider_agent_id === 'string'
              ? body.decider_agent_id
              : null,
      })
      if (pushed) {
        return NextResponse.json({
          accepted: true,
          upstream: true,
          request: current,
        })
      }
    }

    const decided = decidePermissionRequest({
      requestId,
      workspaceId,
      optionId,
      reason: typeof body.reason === 'string' ? body.reason : null,
      deciderType,
      deciderUserId: auth.user.id,
      deciderAgentId:
        typeof body.deciderAgentId === 'string'
          ? body.deciderAgentId
          : typeof body.decider_agent_id === 'string'
            ? body.decider_agent_id
            : null,
    })
    const selectedOption = decided.options.find((item) => item.id === optionId)
    let gatewayForward: Awaited<ReturnType<typeof forwardPermissionDecisionToExecApproval>> | null = null
    if (selectedOption) {
      gatewayForward = await forwardPermissionDecisionToExecApproval({
        request: decided,
        option: selectedOption,
        reason: typeof body.reason === 'string' ? body.reason : null,
      })
    }
    return NextResponse.json({
      request: decided,
      ...(gatewayForward ? { gatewayForward } : {}),
      ...(gatewayForward?.status === 'failed' ? { warning: gatewayForward.error } : {}),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to decide permission request'
    const status = message.includes('not found') ? 404 : message.includes('pending') ? 409 : 400
    return NextResponse.json({ error: message }, { status })
  }
}

function normalizeDeciderType(value: unknown): PermissionDeciderType | null {
  const raw = String(value || 'human_user').trim()
  return raw === 'human_user' || raw === 'steward_agent' || raw === 'system' ? raw : null
}
