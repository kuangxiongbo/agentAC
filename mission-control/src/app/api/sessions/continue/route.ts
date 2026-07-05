import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { requireRole } from '@/lib/auth'
import { requestBridgeClientSessionContinue, type BridgeSessionContinueKind } from '@/lib/bridge-server'
import { logger } from '@/lib/logger'
import { config } from '@/lib/config'
import { notifySessionTranscriptUpdated } from '@/lib/session-realtime'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  enqueueLocalSessionPrompt,
  isLocalSessionKind,
  type LocalSessionKind,
} from '@/lib/local-session-executor'
import { assertLocalCliElevationAllowed } from '@/lib/local-cli-elevation-auth'
import { elevatedFlagToPermissionMode, isLocalCliElevatedFlag } from '@/lib/parse-local-cli-elevated'
import { createLocalCliElevationGrant, logLocalCliElevationDenied } from '@/lib/local-cli-elevation-audit'
import { createEdgeMessage } from '@/lib/edge-messages'
import { sendEdgeMessageWakeup } from '@/lib/bridge-server'

const BRIDGE_CONTINUE_KINDS = new Set<BridgeSessionContinueKind>([
  'claude-code',
  'codex-cli',
  'cursor',
  'opencode',
  'hermes',
])

function sanitizePrompt(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isBridgeContinueKind(kind: string): kind is BridgeSessionContinueKind {
  return BRIDGE_CONTINUE_KINDS.has(kind as BridgeSessionContinueKind)
}

function bridgeOfflineResponse(clientId: string, message: string) {
  return NextResponse.json({
    error: message,
    code: 'bridge_offline',
    client_id: clientId,
  }, { status: 503 })
}

function reliableMessagesEnabled(): boolean {
  return process.env.MC_RELIABLE_EDGE_MESSAGES === '1'
}

function promptFingerprint(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function queueSessionContinue(input: {
  workspaceId: number
  tenantId: number | null
  clientId: string
  kind: BridgeSessionContinueKind
  sessionId: string
  prompt: string
  workingDirectory?: string | null
  permissionMode?: string | null
  localCliElevated?: boolean
  idempotencyKey?: string | null
  correlationId?: string | null
}) {
  const idempotencyKey = input.idempotencyKey
    || `continue:${input.clientId}:${input.kind}:${input.sessionId}:${promptFingerprint(input.prompt)}`
  const correlationId = input.correlationId
    || `session-continue:${input.clientId}:${input.kind}:${input.sessionId}:${Date.now()}`
  const result = createEdgeMessage({
    workspaceId: input.workspaceId,
    tenantId: input.tenantId,
    clientId: input.clientId,
    type: 'session.continue.requested',
    direction: 'cloud_to_edge',
    correlationId,
    idempotencyKey,
    sessionRef: {
      session_id: input.sessionId,
      session_kind: input.kind,
      serial_key: `${input.clientId}:${input.kind}:${input.sessionId}`,
    },
    payload: {
      session_id: input.sessionId,
      session_kind: input.kind,
      content: input.prompt,
      working_directory: input.workingDirectory || null,
      permission_mode: input.permissionMode || null,
      local_cli_elevated: input.localCliElevated === true,
    },
  })
  if (result.created) {
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
  }
}

/**
 * POST /api/sessions/continue
 * Body: { kind, id, prompt, client_id? }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const body = await request.json().catch(() => ({}))
    const kind = typeof body?.kind === 'string' ? body.kind.trim() : ''
    const sessionId = typeof body?.id === 'string' ? body.id.trim() : ''
    const prompt = sanitizePrompt(body?.prompt)
    const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : ''
    const workingDir = typeof body?.working_dir === 'string' ? body.working_dir.trim() : ''
    const localCliElevated = isLocalCliElevatedFlag(body?.local_cli_elevated)
    const deliveryMode = typeof body?.delivery_mode === 'string' ? body.delivery_mode : 'sync'
    const queueIfOffline = body?.queue_if_offline === true || deliveryMode === 'auto' || deliveryMode === 'queue'
    const shouldUseQueue = reliableMessagesEnabled() || queueIfOffline

    const elevationGate = await assertLocalCliElevationAllowed({
      user: auth.user,
      elevated: localCliElevated,
    })
    if (!elevationGate.ok) {
      logLocalCliElevationDenied({
        user: auth.user,
        targetType: 'session_continue',
        targetId: sessionId,
        sessionKind: kind,
        sessionId,
        clientId,
        source: 'sessions_continue_api',
        reason: elevationGate.code,
      })
      return NextResponse.json(
        {
          error: elevationGate.error,
          code: elevationGate.code,
          subscriptionsUrl: elevationGate.subscriptionsUrl,
        },
        { status: elevationGate.status },
      )
    }
    const permissionMode = elevatedFlagToPermissionMode(localCliElevated)
    const elevationGrant = localCliElevated
      ? createLocalCliElevationGrant({
        user: auth.user,
        targetType: 'session_continue',
        targetId: sessionId,
        sessionKind: kind,
        sessionId,
        clientId,
        source: 'sessions_continue_api',
      })
      : null

    if (!sessionId || !/^[a-zA-Z0-9._:-]+$/.test(sessionId)) {
      return NextResponse.json({ error: 'Invalid session id' }, { status: 400 })
    }
    if (!isBridgeContinueKind(kind)) {
      return NextResponse.json({ error: 'Invalid kind' }, { status: 400 })
    }
    if (!prompt || prompt.length > 6000) {
      return NextResponse.json({ error: 'prompt is required (max 6000 chars)' }, { status: 400 })
    }

    if (clientId || config.centralMode) {
      if (!clientId) {
        return NextResponse.json({
          error: 'client_id is required to continue a remote edge session',
          code: 'client_id_required',
        }, { status: 400 })
      }

      if (deliveryMode === 'queue' && shouldUseQueue) {
        const queued = queueSessionContinue({
          workspaceId: auth.user.workspace_id ?? 1,
          tenantId: auth.user.tenant_id ?? 1,
          clientId,
          kind,
          sessionId,
          prompt,
          workingDirectory: workingDir || null,
          permissionMode,
          localCliElevated,
          idempotencyKey: typeof body?.idempotency_key === 'string' ? body.idempotency_key.trim() : null,
          correlationId: typeof body?.correlation_id === 'string' ? body.correlation_id.trim() : null,
        })
        return NextResponse.json({ ok: true, delivery: queued, remote: true, client_id: clientId })
      }

      try {
        const remote = await requestBridgeClientSessionContinue({
          clientId,
          kind,
          sessionId,
          prompt,
          workingDirectory: workingDir || null,
          localCliElevated,
          elevationGrant,
          timeoutMs: 180000,
        })
        const resolvedSessionId = remote.sessionId || sessionId
        notifySessionTranscriptUpdated(kind, resolvedSessionId, 'continue_api')
        return NextResponse.json({
          ok: true,
          reply: remote.reply || 'Session continued, but no text response was returned.',
          session_id: resolvedSessionId,
          source: remote.source,
          remote: true,
          client_id: clientId,
        })
      } catch (bridgeErr) {
        const msg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr)
        if (/not connected|socket unavailable|timed out/i.test(msg)) {
          if (shouldUseQueue) {
            const queued = queueSessionContinue({
              workspaceId: auth.user.workspace_id ?? 1,
              tenantId: auth.user.tenant_id ?? 1,
              clientId,
              kind,
              sessionId,
              prompt,
              workingDirectory: workingDir || null,
              permissionMode,
              localCliElevated,
              idempotencyKey: typeof body?.idempotency_key === 'string' ? body.idempotency_key.trim() : null,
              correlationId: typeof body?.correlation_id === 'string' ? body.correlation_id.trim() : null,
            })
            return NextResponse.json({ ok: true, delivery: queued, remote: true, client_id: clientId })
          }
          return bridgeOfflineResponse(
            clientId,
            '边缘客户端未通过 Bridge 连接，无法在本机继续会话。请保持 Mac 代理客户端运行并已连接 Bridge。',
          )
        }
        throw bridgeErr
      }
    }

    if (isLocalSessionKind(kind)) {
      enqueueLocalSessionPrompt(kind as LocalSessionKind, sessionId, prompt, {
        workingDirectory: workingDir || null,
        permissionMode,
      })
      return NextResponse.json({ ok: true, accepted: true, sessionId })
    }

    return NextResponse.json({ error: `Local continue not supported for kind: ${kind}` }, { status: 400 })
  } catch (error: any) {
    logger.error({ err: error }, 'POST /api/sessions/continue error')
    return NextResponse.json({ error: error?.message || 'Failed to continue session' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
