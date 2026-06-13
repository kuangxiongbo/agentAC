import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { runOpenClaw } from '@/lib/command'
import { requireRole } from '@/lib/auth'
import { validateBody, createMessageSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { scanForInjection } from '@/lib/injection-guard'
import { scanForSecrets } from '@/lib/secret-scanner'
import { logSecurityEvent } from '@/lib/security-events'
import {
  agentBlocksMessageUntilSessionReady,
  enqueueBoundLocalAgentPrompt,
  getLocalSessionKindForFramework,
} from '@/lib/local-session-executor'
import { isBridgeClientOnline, requestBridgeClientAgentMessage } from '@/lib/bridge-server'
import { getBridgeAgentIndexByRecipient } from '@/lib/sync-agent-index'
import { assertLocalCliElevationAllowed } from '@/lib/local-cli-elevation-auth'
import { elevatedFlagToPermissionMode, isLocalCliElevatedFlag } from '@/lib/parse-local-cli-elevated'
import { createLocalCliElevationGrant, logLocalCliElevationDenied } from '@/lib/local-cli-elevation-audit'

/** Edge agent first message may bootstrap Codex/Claude session (up to 5 min). */
export const maxDuration = 300

function bridgeMessageHttpStatus(error: string): number {
  if (/not found/i.test(error)) return 404
  if (/no session key/i.test(error)) return 400
  if (/dedicated session/i.test(error)) return 409
  if (/not connected|socket unavailable/i.test(error)) return 503
  if (/timed out/i.test(error)) return 504
  return 500
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const result = await validateBody(request, createMessageSchema)
    if ('error' in result) return result.error
    const { to, message, local_cli_elevated: localCliElevatedRaw } = result.data
    const from = auth.user.display_name || auth.user.username || 'system'
    const localCliElevated = isLocalCliElevatedFlag(localCliElevatedRaw)

    const elevationGate = await assertLocalCliElevationAllowed({
      user: auth.user,
      elevated: localCliElevated,
    })
    if (!elevationGate.ok) {
      logLocalCliElevationDenied({
        user: auth.user,
        targetType: 'agent_message',
        agentName: to,
        source: 'agents_message_api',
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
    const createElevationGrant = (input?: { clientId?: string | null; targetId?: string | number | null }) =>
      localCliElevated
        ? createLocalCliElevationGrant({
          user: auth.user,
          targetType: 'agent_message',
          targetId: input?.targetId ?? null,
          agentName: to,
          clientId: input?.clientId ?? null,
          source: 'agents_message_api',
        })
        : null

    // Scan message for injection — this gets forwarded directly to an agent
    const injectionReport = scanForInjection(message, { context: 'prompt' })
    if (!injectionReport.safe) {
      const criticals = injectionReport.matches.filter(m => m.severity === 'critical')
      if (criticals.length > 0) {
        logger.warn({ to, rules: criticals.map(m => m.rule) }, 'Blocked agent message: injection detected')
        return NextResponse.json(
          { error: 'Message blocked: potentially unsafe content detected', injection: criticals.map(m => ({ rule: m.rule, description: m.description })) },
          { status: 422 }
        )
      }
    }

    const secretHits = scanForSecrets(message)
    if (secretHits.length > 0) {
      try { logSecurityEvent({ event_type: 'secret_exposure', severity: 'critical', source: 'agent-message', agent_name: from, detail: JSON.stringify({ count: secretHits.length, types: secretHits.map(s => s.type) }), workspace_id: auth.user.workspace_id ?? 1, tenant_id: 1 }) } catch {}
    }

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1;
    const agent = db
      .prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?')
      .get(to, workspaceId) as any

    if (!agent) {
      const indexRow = getBridgeAgentIndexByRecipient(to)
      if (!indexRow) {
        return NextResponse.json({ error: 'Recipient agent not found' }, { status: 404 })
      }
      if (!isBridgeClientOnline(indexRow.client_id)) {
        return NextResponse.json(
          {
            error: `边缘客户端未连接（${indexRow.client_id}），无法向该智能体发消息。请保持本地客户端运行并已连上 Bridge。`,
            code: 'bridge_offline',
            client_id: indexRow.client_id,
          },
          { status: 503 },
        )
      }

      try {
        const remote = await requestBridgeClientAgentMessage({
          clientId: indexRow.client_id,
          localAgentId: indexRow.local_agent_id,
          message,
          from,
          localCliElevated,
          elevationGrant: createElevationGrant({ clientId: indexRow.client_id, targetId: indexRow.local_agent_id }),
        })
        if (!remote.success) {
          return NextResponse.json(
            { error: 'Failed to deliver message to edge agent' },
            { status: 500 },
          )
        }

        db_helpers.logActivity(
          'agent_message',
          'bridge_agent',
          indexRow.id,
          from,
          `Sent message to ${indexRow.remote_name} via ${indexRow.client_id}`,
          {
            to: indexRow.remote_name,
            client_id: indexRow.client_id,
            local_agent_id: indexRow.local_agent_id,
          },
          workspaceId,
        )

        return NextResponse.json({
          success: true,
          source: 'bridge',
          accepted: remote.accepted,
          delivered: remote.delivered,
          agent_id: remote.agent_id ?? indexRow.local_agent_id,
          bridge_index_id: indexRow.id,
          client_id: indexRow.client_id,
          ...(remote.session_key ? { session_key: remote.session_key } : {}),
          ...(remote.session_kind ? { session_kind: remote.session_kind } : {}),
          ...(remote.queued_prompt ? { queued_prompt: remote.queued_prompt } : {}),
          ...(remote.reply_preview ? { reply_preview: remote.reply_preview } : {}),
        })
      } catch (bridgeErr) {
        const errMsg = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr)
        logger.warn({ err: bridgeErr, to, clientId: indexRow.client_id }, 'Bridge agent message failed')
        return NextResponse.json({ error: errMsg }, { status: bridgeMessageHttpStatus(errMsg) })
      }
    }

    const localSessionKind = getLocalSessionKindForFramework(agent.framework)
    if (!agent.session_key && !localSessionKind) {
      return NextResponse.json(
        { error: 'Recipient agent has no session key configured' },
        { status: 400 }
      )
    }

    if (agentBlocksMessageUntilSessionReady(agent)) {
      return NextResponse.json(
        { error: 'Create and bind a dedicated session before sending messages to this agent.' },
        { status: 409 }
      )
    }

    let localSessionKey: string | null = null
    let queuedPrompt: string | null = null
    let queuedSessionKind: string | null = null
    createElevationGrant({ targetId: agent.id })

    if (localSessionKind) {
      queuedPrompt = `Message from ${from}: ${message}`
      const queued = enqueueBoundLocalAgentPrompt(agent, queuedPrompt, { permissionMode })
      localSessionKey = queued.sessionKey
      queuedSessionKind = queued.kind
    } else {
      await runOpenClaw(
        [
          'gateway',
          'sessions_send',
          '--session',
          agent.session_key,
          '--message',
          `Message from ${from}: ${message}`
        ],
        { timeoutMs: 10000 }
      )
    }

    db_helpers.createNotification(
      to,
      'message',
      'Direct Message',
      `${from}: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`,
      'agent',
      agent.id,
      workspaceId
    )

    db_helpers.logActivity(
      'agent_message',
      'agent',
      agent.id,
      from,
      `Sent message to ${to}`,
      { to },
      workspaceId
    )

    return NextResponse.json({
      success: true,
      accepted: Boolean(localSessionKind),
      agent_id: agent.id,
      ...(localSessionKey ? { session_key: localSessionKey } : {}),
      ...(queuedSessionKind ? { session_kind: queuedSessionKind } : {}),
      ...(queuedPrompt ? { queued_prompt: queuedPrompt } : {}),
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/message error')
    const message = (error as Error)?.message || 'Failed to send message'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
