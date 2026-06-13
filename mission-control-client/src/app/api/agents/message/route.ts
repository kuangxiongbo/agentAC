import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { validateBody, createMessageSchema } from '@/lib/validation'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { scanForInjection } from '@/lib/injection-guard'
import { scanForSecrets } from '@/lib/secret-scanner'
import { logSecurityEvent } from '@/lib/security-events'
import { deliverAgentMessage } from '@/lib/deliver-agent-message'
import { assertLocalCliElevationAllowed } from '@/lib/local-cli-elevation-auth'
import { isLocalCliElevatedFlag } from '@/lib/parse-local-cli-elevated'
import { createLocalCliElevationGrant, logLocalCliElevationDenied } from '@/lib/local-cli-elevation-audit'

/** First message without a bound session may run Codex/Claude bootstrap. */
export const maxDuration = 300

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
    const elevationGate = await assertLocalCliElevationAllowed({ elevated: localCliElevated })
    if (!elevationGate.ok) {
      logLocalCliElevationDenied({
        targetType: 'agent_message',
        agentName: to,
        source: 'edge_agents_message_api',
        reason: elevationGate.code,
      })
      return NextResponse.json(
        {
          error: elevationGate.error,
          code: elevationGate.code,
          subscriptionsUrl: elevationGate.subscriptionsUrl,
        },
        { status: elevationGate.status }
      )
    }
    if (localCliElevated) {
      createLocalCliElevationGrant({
        targetType: 'agent_message',
        agentName: to,
        source: 'edge_agents_message_api',
      })
    }

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
      return NextResponse.json({ error: 'Recipient agent not found' }, { status: 404 })
    }

    const delivered = await deliverAgentMessage({
      agent,
      message,
      from,
      workspaceId,
      localCliElevated,
    })
    if (!delivered.ok) {
      return NextResponse.json({ error: delivered.error }, { status: delivered.status })
    }

    return NextResponse.json({
      success: true,
      accepted: delivered.accepted,
      delivered: delivered.delivered,
      agent_id: delivered.agent_id,
      ...(delivered.session_key ? { session_key: delivered.session_key } : {}),
      ...(delivered.session_kind ? { session_kind: delivered.session_kind } : {}),
      ...(delivered.queued_prompt ? { queued_prompt: delivered.queued_prompt } : {}),
      ...(delivered.reply_preview ? { reply_preview: delivered.reply_preview } : {}),
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/message error')
    const message = (error as Error)?.message || 'Failed to send message'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
