import { getDatabase, db_helpers } from '@/lib/db'
import { runOpenClaw } from '@/lib/command'
import {
  agentBlocksMessageUntilSessionReady,
  enqueueBoundLocalAgentPrompt,
  executeBoundLocalAgentPrompt,
  getLocalSessionKindForFramework,
} from '@/lib/local-session-executor'
import { elevatedFlagToPermissionMode } from '@/lib/parse-local-cli-elevated'

export type DeliverAgentMessageInput = {
  agent: {
    id: number
    name: string
    framework?: string | null
    session_key?: string | null
    config?: unknown
  }
  message: string
  from: string
  workspaceId?: number
  /** Skip notification/activity when invoked from Bridge (center already logs). */
  skipAudit?: boolean
  localCliElevated?: boolean
}

export type DeliverAgentMessageSuccess = {
  ok: true
  accepted: boolean
  delivered: boolean
  agent_id: number
  agent_name: string
  session_key?: string
  session_kind?: string
  queued_prompt?: string
  reply_preview?: string
}

export type DeliverAgentMessageFailure = {
  ok: false
  status: number
  error: string
}

export async function deliverAgentMessage(
  input: DeliverAgentMessageInput,
): Promise<DeliverAgentMessageSuccess | DeliverAgentMessageFailure> {
  const { agent, message, from } = input
  const workspaceId = input.workspaceId ?? 1
  const to = agent.name
  const permissionMode = elevatedFlagToPermissionMode(Boolean(input.localCliElevated))

  const localSessionKind = getLocalSessionKindForFramework(agent.framework)
  if (!agent.session_key && !localSessionKind) {
    return { ok: false, status: 400, error: 'Recipient agent has no session key configured' }
  }

  if (agentBlocksMessageUntilSessionReady(agent)) {
    return {
      ok: false,
      status: 409,
      error: 'Create and bind a dedicated session before sending messages to this agent.',
    }
  }

  let localSessionKey: string | null = null
  let queuedPrompt: string | null = null
  let queuedSessionKind: string | null = null
  let delivered = false
  let replyPreview: string | null = null

  try {
    if (localSessionKind) {
      queuedPrompt = `Message from ${from}: ${message}`
      const existingSessionKey = String(agent.session_key || '').trim()
      if (existingSessionKey) {
        const queued = enqueueBoundLocalAgentPrompt(agent, queuedPrompt, { permissionMode })
        localSessionKey = queued.sessionKey
        queuedSessionKind = queued.kind
      } else {
        const result = await executeBoundLocalAgentPrompt(agent, queuedPrompt, { permissionMode })
        delivered = true
        replyPreview = (result.reply || '').trim().slice(0, 500) || null
        const db = getDatabase()
        const rebound = db
          .prepare('SELECT session_key FROM agents WHERE id = ?')
          .get(agent.id) as { session_key?: string | null } | undefined
        localSessionKey = String(rebound?.session_key || result.sessionId || '').trim() || null
        queuedSessionKind = localSessionKey
        if (!localSessionKey) {
          return {
            ok: false,
            status: 500,
            error: 'Message was executed but no session was bound to this agent. Check runtime logs.',
          }
        }
      }
    } else {
      const sessionKey = String(agent.session_key || '').trim()
      await runOpenClaw(
        [
          'gateway',
          'sessions_send',
          '--session',
          sessionKey,
          '--message',
          `Message from ${from}: ${message}`,
        ],
        { timeoutMs: 10000 },
      )
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Failed to send message'
    return { ok: false, status: 500, error: errMsg }
  }

  if (!input.skipAudit) {
    db_helpers.createNotification(
      to,
      'message',
      'Direct Message',
      `${from}: ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`,
      'agent',
      agent.id,
      workspaceId,
    )

    db_helpers.logActivity(
      'agent_message',
      'agent',
      agent.id,
      from,
      `Sent message to ${to}`,
      { to },
      workspaceId,
    )
  }

  return {
    ok: true,
    accepted: Boolean(localSessionKind) && !delivered,
    delivered,
    agent_id: agent.id,
    agent_name: to,
    ...(localSessionKey ? { session_key: localSessionKey } : {}),
    ...(queuedSessionKind ? { session_kind: queuedSessionKind } : {}),
    ...(queuedPrompt ? { queued_prompt: queuedPrompt } : {}),
    ...(replyPreview ? { reply_preview: replyPreview } : {}),
  }
}
