import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { isBindableSessionKind } from '@/lib/agent-session-binding'
import {
  isBridgeClientOnline,
  requestBridgeClientStewardCreate,
  type BridgeStewardCreateFramework,
} from '@/lib/bridge-server'
import { createHumanWatchBinding } from '@/lib/human-watch-bindings'
import { requireHumanWatchEntitlement } from '@/lib/human-watch-policy'

export const dynamic = 'force-dynamic'

/**
 * POST /api/human-watch/stewards
 * Create a human-watch steward agent on an edge client via Bridge.
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

  let body: {
    client_id?: string
    name?: string
    framework?: string
    soul_content?: string
    workspace_path?: string
    worker_local_agent_id?: number | string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const clientId = String(body.client_id || '').trim()
  const name = String(body.name || '').trim()
  const framework = String(body.framework || '').trim() as BridgeStewardCreateFramework

  if (!clientId) {
    return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
  }
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (!isBindableSessionKind(framework) || (framework !== 'claude-code' && framework !== 'codex-cli')) {
    return NextResponse.json(
      { error: 'framework must be claude-code or codex-cli' },
      { status: 400 },
    )
  }

  if (!isBridgeClientOnline(clientId)) {
    return NextResponse.json({ error: 'Bridge client is offline' }, { status: 503 })
  }

  try {
    const result = await requestBridgeClientStewardCreate({
      clientId,
      name,
      framework,
      soulContent: body.soul_content || null,
      workspacePath: body.workspace_path || null,
      authorized: true,
    })

    if (!result.agent) {
      return NextResponse.json({ error: 'Edge did not return steward agent' }, { status: 502 })
    }

    const stewardLocalId = Number((result.agent as { id?: unknown }).id)
    let binding: Awaited<ReturnType<typeof createHumanWatchBinding>> | null = null

    const workerLocalRaw = body.worker_local_agent_id
    const workerLocalId =
      workerLocalRaw != null && workerLocalRaw !== ''
        ? Number(workerLocalRaw)
        : NaN

    if (Number.isFinite(workerLocalId) && workerLocalId > 0 && Number.isFinite(stewardLocalId)) {
      const createdBinding = await createHumanWatchBinding({
        workspaceId: auth.user.workspace_id ?? 1,
        tenantId,
        clientId,
        stewardLocalAgentId: stewardLocalId,
        workerLocalAgentId: workerLocalId,
        mode: 'auto_send',
      })
      if ('error' in createdBinding) {
        return NextResponse.json(
          {
            error: createdBinding.error,
            steward: result.agent,
            binding_failed: true,
          },
          { status: createdBinding.status },
        )
      }
      binding = createdBinding
    }

    return NextResponse.json({
      client_id: clientId,
      agent: result.agent,
      session_provisioning: result.sessionProvisioning,
      source: result.source,
      binding: binding
        ? {
            id: binding.id,
            worker_local_agent_id: binding.worker_local_agent_id,
            steward_local_agent_id: binding.steward_local_agent_id,
          }
        : null,
    }, { status: 201 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create steward on edge'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
