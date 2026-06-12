import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { resolveAgentEdgeIdentity } from '@/lib/resolve-agent-edge-identity'
import { getDatabase } from '@/lib/db'
import { enrichAgentConfigFromWorkspace } from '@/lib/agent-sync'

export const dynamic = 'force-dynamic'

/**
 * GET /api/agents/[id]/edge-identity
 * Resolve bridge client_id + edge local_agent_id for human-watch bind tabs.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id } = await params
  const numericId = Number(id)
  if (!Number.isFinite(numericId)) {
    return NextResponse.json({ error: 'Invalid agent id' }, { status: 400 })
  }

  const identity = resolveAgentEdgeIdentity({ id: numericId })
  if (identity.client_id && identity.local_agent_id != null) {
    return NextResponse.json(identity)
  }

  const db = getDatabase()
  const workspaceId = auth.user.workspace_id ?? 1
  const row = db
    .prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?')
    .get(numericId, workspaceId) as Record<string, unknown> | undefined

  if (row) {
    let config: Record<string, unknown> = {}
    if (row.config) {
      try {
        config = enrichAgentConfigFromWorkspace(
          typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
        )
      } catch {
        config = {}
      }
    }
    const fromDb = resolveAgentEdgeIdentity({
      id: numericId,
      name: String(row.name || ''),
      source: typeof row.source === 'string' ? row.source : undefined,
      node_id: typeof row.node_id === 'string' ? row.node_id : null,
      config,
    })
    return NextResponse.json(fromDb)
  }

  return NextResponse.json(identity)
}
