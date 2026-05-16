import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  isLocalSessionKind,
  executeLocalSessionPrompt,
  type LocalSessionKind,
} from '@/lib/local-session-executor'

/**
 * POST /api/sessions/continue
 * Body: { kind: 'claude-code'|'codex-cli'|'cursor'|'opencode'|'hermes', id: string, prompt: string }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const body = await request.json().catch(() => ({}))
    const kind = body?.kind as LocalSessionKind
    const sessionId = typeof body?.id === 'string' ? body.id.trim() : ''
    const prompt = typeof body?.prompt === 'string' ? body.prompt : ''

    if (!isLocalSessionKind(kind)) {
      return NextResponse.json({ error: 'Invalid kind' }, { status: 400 })
    }
    const result = await executeLocalSessionPrompt(kind, sessionId, prompt)

    return NextResponse.json({ ok: true, reply: result.reply })
  } catch (error: any) {
    logger.error({ err: error }, 'POST /api/sessions/continue error')
    return NextResponse.json({ error: error?.message || 'Failed to continue session' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
