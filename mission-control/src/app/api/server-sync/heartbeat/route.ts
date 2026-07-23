import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { upsertSyncClientHeartbeat } from '@/lib/sync-clients'
import { cleanupDuplicateClientAgents, parseAgentInventory, reconcileClientAgentInventory } from '@/lib/sync-agent-inventory'
import { replaceBridgeAgentIndex } from '@/lib/sync-agent-index'
import { config } from '@/lib/config'

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

  const clientName = typeof body?.client_name === 'string' ? body.client_name.trim() : ''
  const clientIdRaw = typeof body?.client_id === 'string' ? body.client_id.trim() : ''
  const clientId = clientIdRaw || clientName
  const previousClientName = typeof body?.previous_client_name === 'string' ? body.previous_client_name.trim() : ''
  const agentCount = typeof body?.agent_count === 'number' ? body.agent_count : 0

  if (!clientId || !clientName) {
    return NextResponse.json({ error: 'client_id and client_name are required' }, { status: 400 })
  }

  if (previousClientName && previousClientName !== clientName) {
    const { getDatabase } = await import('@/lib/db')
    const db = getDatabase()
    db.prepare(`
      DELETE FROM sync_clients
      WHERE client_id = ? OR client_name = ?
    `).run(previousClientName, previousClientName)
  }

  const client = upsertSyncClientHeartbeat({
    clientId,
    clientName,
    workspaceId: auth.user.workspace_id ?? 1,
    agentCount,
    source: 'heartbeat',
  })

  const agentSyncMode = config.centralMode ? 'clients-only' : 'full'
  let agentsPruned = 0
  let duplicateAgentsRemoved = 0
  let agentIndexUpdated = 0
  if (body?.agent_inventory !== undefined) {
    const workspaceId = auth.user.workspace_id ?? 1
    const inventory = parseAgentInventory(body.agent_inventory)
    if (agentSyncMode === 'clients-only') {
      const indexableInventory = inventory.filter(
        (agent): agent is typeof agent & { local_agent_id: number } =>
          typeof agent.local_agent_id === 'number' && Number.isFinite(agent.local_agent_id),
      )
      if (indexableInventory.length === inventory.length) {
        agentIndexUpdated = replaceBridgeAgentIndex(
          clientId,
          clientName,
          indexableInventory.map((agent) => ({
            id: agent.local_agent_id,
            name: agent.original_name,
            role: agent.role || 'agent',
            status: agent.status || 'idle',
            framework: agent.framework,
          })),
        ).upserted
      }
    } else {
      const result = reconcileClientAgentInventory(workspaceId, clientId, clientName, inventory)
      agentsPruned = result.removed
      duplicateAgentsRemoved = cleanupDuplicateClientAgents(workspaceId, clientId).removed
    }
  }

  return NextResponse.json({
    ok: true,
    client,
    agent_sync_mode: agentSyncMode,
    agents_pruned: agentsPruned,
    duplicate_agents_removed: duplicateAgentsRemoved,
    agent_index_updated: agentIndexUpdated,
  })
}
