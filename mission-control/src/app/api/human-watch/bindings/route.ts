import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  createHumanWatchBinding,
  listHumanWatchBindings,
} from '@/lib/human-watch-bindings'
import { requireHumanWatchEntitlement } from '@/lib/human-watch-policy'
import type { HumanWatchBindingMode } from '@/lib/human-watch-types'
import { buildDefaultBindingRulesOverride } from '@/lib/human-watch-defaults'

export const dynamic = 'force-dynamic'

function serializeBinding(row: {
  id: number
  workspace_id: number
  tenant_id: number | null
  client_id: string
  worker_sync_index_id: number | null
  worker_local_agent_id: number | null
  worker_name: string | null
  steward_sync_index_id: number | null
  steward_local_agent_id: number | null
  steward_name: string | null
  worker_session_id: string | null
  enabled: number
  mode: string
  rules_override: string | null
  created_at: number
  updated_at: number
}) {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    rules_override: row.rules_override ? safeParseJson(row.rules_override) : null,
  }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * GET /api/human-watch/bindings
 * POST /api/human-watch/bindings
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const workspaceId = auth.user.workspace_id ?? 1
  const params = request.nextUrl.searchParams
  const clientId = params.get('client_id')?.trim() || undefined
  const enabledParam = params.get('enabled')
  const enabled =
    enabledParam === '1' || enabledParam === 'true'
      ? true
      : enabledParam === '0' || enabledParam === 'false'
        ? false
        : undefined

  const bindings = listHumanWatchBindings({ workspaceId, clientId, enabled })
  return NextResponse.json({
    bindings: bindings.map(serializeBinding),
    count: bindings.length,
  })
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

  const clientId = String(body.client_id || '').trim()
  if (!clientId) {
    return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
  }

  const mode = String(body.mode || 'auto_send') as HumanWatchBindingMode
  if (mode !== 'auto_send' && mode !== 'suggest_only') {
    return NextResponse.json({ error: 'mode must be auto_send or suggest_only' }, { status: 400 })
  }

  const created = await createHumanWatchBinding({
    workspaceId: auth.user.workspace_id ?? 1,
    tenantId,
    clientId,
    workerSyncIndexId: numOrNull(body.worker_sync_index_id),
    workerLocalAgentId: numOrNull(body.worker_local_agent_id),
    stewardSyncIndexId: numOrNull(body.steward_sync_index_id),
    stewardLocalAgentId: numOrNull(body.steward_local_agent_id),
    workerSessionId: typeof body.worker_session_id === 'string' ? body.worker_session_id : null,
    enabled: body.enabled !== false,
    mode,
    rulesOverride:
      body.rules_override && typeof body.rules_override === 'object'
        ? (body.rules_override as Record<string, unknown>)
        : buildDefaultBindingRulesOverride(),
  })

  if ('error' in created) {
    return NextResponse.json({ error: created.error }, { status: created.status })
  }

  return NextResponse.json({ binding: serializeBinding(created) }, { status: 201 })
}

function numOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
