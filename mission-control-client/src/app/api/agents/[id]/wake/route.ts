import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, db_helpers } from '@/lib/db'
import { runOpenClaw } from '@/lib/command'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  executeBoundLocalAgentPrompt,
  getLocalSessionKindForFramework,
} from '@/lib/local-session-executor'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const resolvedParams = await params
    const agentId = resolvedParams.id
    const workspaceId = auth.user.workspace_id ?? 1;
    const body = await request.json().catch(() => ({}))
    const customMessage =
      typeof body?.message === 'string' ? body.message.trim() : ''

    const db = getDatabase()
    const agent: any = isNaN(Number(agentId))
      ? db.prepare('SELECT * FROM agents WHERE name = ? AND workspace_id = ?').get(agentId, workspaceId)
      : db.prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?').get(Number(agentId), workspaceId)

    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
    }

    const localSessionKind = getLocalSessionKindForFramework(agent.framework)
    if (!agent.session_key && !localSessionKind) {
      return NextResponse.json(
        { error: 'Agent has no session key configured' },
        { status: 400 }
      )
    }

    const message =
      customMessage ||
      `Wake up check-in for ${agent.name}. Please review assigned tasks and notifications.`

    let reply = ''
    let resolvedSessionKey = agent.session_key || null
    if (localSessionKind) {
      const result = await executeBoundLocalAgentPrompt(
        agent,
        message,
      )
      reply = result.reply
      resolvedSessionKey = result.sessionId || resolvedSessionKey
    } else {
      const { stdout, stderr } = await runOpenClaw(
        ['gateway', 'sessions_send', '--session', agent.session_key, '--message', message],
        { timeoutMs: 10000 }
      )

      if (stderr && stderr.includes('error')) {
        return NextResponse.json(
          { error: stderr.trim() || 'Failed to wake agent' },
          { status: 500 }
        )
      }
      reply = stdout.trim()
    }

    db_helpers.updateAgentStatus(agent.name, 'idle', 'Manual wake', workspaceId)

    return NextResponse.json({
      success: true,
      session_key: resolvedSessionKey,
      stdout: reply
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/agents/[id]/wake error')
    return NextResponse.json({ error: 'Failed to wake agent' }, { status: 500 })
  }
}
