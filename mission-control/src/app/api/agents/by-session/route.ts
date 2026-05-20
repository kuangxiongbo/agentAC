import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'
import { findAgentsBoundToSession } from '@/lib/agents-by-session'
import { isBridgeClientOnline, requestBridgeClientAgentsBySession } from '@/lib/bridge-server'
import { mapEdgeAgentsToBindingRows } from '@/lib/sync-agent-index'
import { logger } from '@/lib/logger'

/**
 * GET /api/agents/by-session?session_id=...&session_key=...&client_id=...
 * Find agents bound to a local CLI session id/key.
 * When client_id is set and Bridge is online, also queries the edge client DB.
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const sessionId = request.nextUrl.searchParams.get('session_id')?.trim() || ''
  const sessionKey = request.nextUrl.searchParams.get('session_key')?.trim() || ''
  const clientId = request.nextUrl.searchParams.get('client_id')?.trim() || ''
  if (!sessionId && !sessionKey) {
    return NextResponse.json({ error: 'session_id or session_key required' }, { status: 400 })
  }

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id ?? 1
    let agents = findAgentsBoundToSession(db, workspaceId, sessionId, sessionKey)

    if (clientId && isBridgeClientOnline(clientId)) {
      try {
        const remote = await requestBridgeClientAgentsBySession({
          clientId,
          sessionId,
          sessionKey,
        })
        const edgeAgents = mapEdgeAgentsToBindingRows(clientId, remote.agents)
        if (edgeAgents.length > 0) {
          agents = edgeAgents
        }
      } catch (err) {
        logger.warn({ err, clientId, sessionId }, 'Bridge agents-by-session lookup failed; using central DB only')
      }
    }

    return NextResponse.json({ agents })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/agents/by-session error')
    return NextResponse.json({ error: 'Failed to lookup agents' }, { status: 500 })
  }
}
