import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  getHumanWatchBinding,
  updateHumanWatchBinding,
} from '@/lib/human-watch-bindings'
import { requireHumanWatchEntitlement } from '@/lib/human-watch-policy'
import type { HumanWatchBindingMode } from '@/lib/human-watch-types'

export const dynamic = 'force-dynamic'

function serializeBinding(row: NonNullable<ReturnType<typeof getHumanWatchBinding>>) {
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
 * GET /api/human-watch/bindings/:id
 * PATCH /api/human-watch/bindings/:id
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id: idRaw } = await context.params
  const id = Number(idRaw)
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: 'Invalid binding id' }, { status: 400 })
  }

  const binding = getHumanWatchBinding(id, auth.user.workspace_id ?? 1)
  if (!binding) {
    return NextResponse.json({ error: 'Binding not found' }, { status: 404 })
  }

  return NextResponse.json({ binding: serializeBinding(binding) })
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
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

  const { id: idRaw } = await context.params
  const id = Number(idRaw)
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: 'Invalid binding id' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const modeRaw = body.mode != null ? String(body.mode) : undefined
  if (modeRaw && modeRaw !== 'auto_send' && modeRaw !== 'suggest_only') {
    return NextResponse.json({ error: 'mode must be auto_send or suggest_only' }, { status: 400 })
  }

  const updated = updateHumanWatchBinding(id, auth.user.workspace_id ?? 1, {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    mode: modeRaw as HumanWatchBindingMode | undefined,
    workerSessionId:
      typeof body.worker_session_id === 'string' ? body.worker_session_id : undefined,
    rulesOverride:
      body.rules_override === null
        ? null
        : body.rules_override && typeof body.rules_override === 'object'
          ? (body.rules_override as Record<string, unknown>)
          : undefined,
  })

  if (!updated) {
    return NextResponse.json({ error: 'Binding not found' }, { status: 404 })
  }

  return NextResponse.json({ binding: serializeBinding(updated) })
}
