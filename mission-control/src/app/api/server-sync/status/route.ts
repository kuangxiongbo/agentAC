import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { getSchedulerStatus } from '@/lib/scheduler'
import { listSyncClients } from '@/lib/sync-clients'
import { getBridgeServerStatus } from '@/lib/bridge-server'

type SchedulerSnapshot = ReturnType<typeof getSchedulerStatus>[number]

function getSetting(db: ReturnType<typeof getDatabase>, key: string, fallback = ''): string {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return typeof row?.value === 'string' ? row.value : fallback
  } catch {
    return fallback
  }
}

async function fetchBridgeInfo(serverUrl: string): Promise<{ ok: boolean; status?: number; payload?: any; error?: string }> {
  if (!serverUrl) {
    return { ok: false, error: 'gateway.server_url is not configured' }
  }

  const normalized = serverUrl.replace(/\/+$/, '')
  const url = `${normalized}/api/bridge/info`

  try {
    const response = await fetch(url, { cache: 'no-store' })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      return { ok: false, status: response.status, payload, error: payload?.error || `bridge info request failed with ${response.status}` }
    }
    return { ok: true, status: response.status, payload }
  } catch (error: any) {
    return { ok: false, error: error?.message || 'failed to connect to remote server' }
  }
}

function pickTasks(tasks: SchedulerSnapshot[]) {
  const interesting = new Set([
    'server_gateway_sync',
    'local_agent_sync',
    'gateway_agent_sync',
    'task_dispatch',
  ])
  return tasks.filter((task) => interesting.has(task.id))
}

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const db = getDatabase()
  const scheduler = getSchedulerStatus()

  const gatewayServerUrl = getSetting(db, 'gateway.server_url')
  const gatewayClientName = getSetting(db, 'gateway.client_name', 'E-Agent-Center')
  const gatewayToken = getSetting(db, 'gateway.token')
  const bridgeInfo = await fetchBridgeInfo(gatewayServerUrl)

  const localAgentCounts = {
    total: (db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number } | undefined)?.c ?? 0,
    bridge: (db.prepare("SELECT COUNT(*) as c FROM agents WHERE source = 'bridge'").get() as { c: number } | undefined)?.c ?? 0,
    runtime: (db.prepare("SELECT COUNT(*) as c FROM agents WHERE source = 'runtime'").get() as { c: number } | undefined)?.c ?? 0,
    local: (db.prepare("SELECT COUNT(*) as c FROM agents WHERE source = 'local'").get() as { c: number } | undefined)?.c ?? 0,
  }

  const localSyncBacklog = {
    unsynced_messages: (db.prepare('SELECT COUNT(*) as c FROM messages WHERE COALESCE(synced, 0) = 0').get() as { c: number } | undefined)?.c ?? 0,
    remote_tasks_pending_notify: (db.prepare('SELECT COUNT(*) as c FROM tasks WHERE remote_id IS NOT NULL AND remote_notified IS NULL').get() as { c: number } | undefined)?.c ?? 0,
    remote_tasks_total: (db.prepare('SELECT COUNT(*) as c FROM tasks WHERE remote_id IS NOT NULL').get() as { c: number } | undefined)?.c ?? 0,
  }
  const clients = listSyncClients(auth.user.workspace_id ?? 1)
  const mergedClients = new Map(clients.map((client) => [client.client_id, client]))
  const bridgeClients = getBridgeServerStatus().clients
    .filter((client) => client.kind === 'edge' && client.status === 'connected')
    .map((client) => ({
      client_id: client.clientId,
      client_name: client.clientLabel || client.clientId,
      workspace_id: auth.user.workspace_id ?? 1,
      agent_count: client.agentCount,
      last_seen: Math.floor(client.lastSeenAt / 1000),
      last_sync_source: 'bridge-ws',
      status: 'connected' as const,
    }))
  for (const client of bridgeClients) {
    const existing = mergedClients.get(client.client_id)
    if (!existing || client.last_seen >= existing.last_seen || existing.status !== 'connected') {
      mergedClients.set(client.client_id, client)
    }
  }
  const effectiveClients = Array.from(mergedClients.values())
    .sort((a, b) => b.last_seen - a.last_seen || a.client_name.localeCompare(b.client_name))

  return NextResponse.json({
    upstream: {
      server_url: gatewayServerUrl,
      client_name: gatewayClientName,
      token_configured: Boolean(gatewayToken),
      bridge_info: bridgeInfo,
    },
    scheduler: {
      tasks: pickTasks(scheduler),
    },
    local_counts: localAgentCounts,
    backlog: localSyncBacklog,
    clients: {
      total: effectiveClients.length,
      connected: effectiveClients.filter((client) => client.status === 'connected').length,
      disconnected: effectiveClients.filter((client) => client.status === 'disconnected').length,
      items: effectiveClients,
      realtime_connected: bridgeClients.length,
    },
  })
}
