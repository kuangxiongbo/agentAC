import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { replaceSyncedSessions, type SyncedSessionInput } from '@/lib/sync-sessions'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : ''
  const clientName = typeof body?.client_name === 'string' ? body.client_name.trim() : ''
  const sessions = Array.isArray(body?.sessions)
    ? (body.sessions as any[]).flatMap((session) => {
        if (!session || typeof session !== 'object') return []
        const sessionId = typeof session.session_id === 'string' ? session.session_id.trim() : ''
        const sessionKind = typeof session.session_kind === 'string' ? session.session_kind.trim() : ''
        if (!sessionId || !sessionKind) return []
        return [{
          clientId,
          clientName,
          sessionId,
          sessionKey: typeof session.session_key === 'string' ? session.session_key : null,
          sessionKind,
          runtimeGroup: typeof session.runtime_group === 'string' ? session.runtime_group : null,
          agent: typeof session.agent === 'string' ? session.agent : null,
          model: typeof session.model === 'string' ? session.model : null,
          tokens: typeof session.tokens === 'string' ? session.tokens : null,
          age: typeof session.age === 'string' ? session.age : null,
          active: session.active === true,
          startTime: typeof session.start_time === 'number' ? session.start_time : null,
          lastActivity: typeof session.last_activity === 'number' ? session.last_activity : null,
          workingDir: typeof session.working_dir === 'string' ? session.working_dir : null,
          lastUserPrompt: typeof session.last_user_prompt === 'string' ? session.last_user_prompt : null,
        } satisfies SyncedSessionInput]
      })
    : null

  if (!clientId || !clientName || !sessions) {
    return NextResponse.json({ error: 'client_id, client_name, and sessions are required' }, { status: 400 })
  }

  replaceSyncedSessions(clientId, clientName, sessions)
  return NextResponse.json({ ok: true, synced: sessions.length })
}
