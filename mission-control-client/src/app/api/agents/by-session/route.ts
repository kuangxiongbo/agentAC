import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { findAgentsBoundToSession } from '@/lib/agents-by-session'

/**
 * GET /api/agents/by-session?session_id=...&session_key=...
 * Find agents bound to a local CLI session id/key.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const sessionId = request.nextUrl.searchParams.get('session_id')?.trim() || ''
  const sessionKey = request.nextUrl.searchParams.get('session_key')?.trim() || ''
  if (!sessionId && !sessionKey) {
    return NextResponse.json({ error: 'session_id or session_key required' }, { status: 400 })
  }

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    const agents = findAgentsBoundToSession(db, workspaceId, sessionId, sessionKey)
    return NextResponse.json({ agents })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to lookup agents' }, { status: 500 })
  }
}
