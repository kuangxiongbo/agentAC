import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import {
  agentRequiresDedicatedSession,
  getLocalSessionKindForFramework,
  provisionAgentDedicatedSession,
} from '@/lib/local-session-executor'

/**
 * POST /api/agents/[id]/provision-session
 * Create a dedicated local CLI session (bootstrap only) and bind it to the agent.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const db = getDatabase()
    const { id } = await params
    const workspaceId = auth.user.workspace_id ?? 1

    const agent = (
      Number.isNaN(Number(id))
        ? db.prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?').get(id, workspaceId)
        : db.prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?').get(Number(id), workspaceId)
    ) as Record<string, unknown> | undefined

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const kind = getLocalSessionKindForFramework(agent.framework as string)
    if (!kind) {
      return NextResponse.json(
        { error: 'Agent framework does not support local dedicated sessions' },
        { status: 400 },
      )
    }

    if (!agentRequiresDedicatedSession(agent)) {
      const sessionKey = String(agent.session_key || '').trim()
      return NextResponse.json({
        success: true,
        session_key: sessionKey,
        already_bound: true,
        reply: 'Session is already bound to this agent.',
      })
    }

    const result = await provisionAgentDedicatedSession(agent)
    const rebound = (
      db.prepare('SELECT session_key, config, status FROM agents WHERE id = ?').get(agent.id) as {
        session_key?: string | null
        config?: string | null
        status?: string | null
      } | undefined
    )

    return NextResponse.json({
      success: true,
      session_key: rebound?.session_key || result.sessionId,
      status: rebound?.status || 'idle',
      reply: result.reply,
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/[id]/provision-session error')
    const message = (error as Error)?.message || 'Failed to provision dedicated session'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
