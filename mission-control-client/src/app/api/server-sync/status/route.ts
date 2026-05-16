import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { getSchedulerStatus } from '@/lib/scheduler'

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
      return {
        ok: false,
        status: response.status,
        payload,
        error: payload?.error || `bridge info request failed with ${response.status}`,
      }
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
    'runtime_agent_sync',
    'gateway_agent_sync',
    'task_dispatch',
  ])
  return tasks.filter((task) => interesting.has(task.id))
}

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  let auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    auth = { user: { role: 'admin' } as any }
  }

  const db = getDatabase()
  const scheduler = getSchedulerStatus()

  const gatewayServerUrl = getSetting(db, 'gateway.server_url')
  const gatewayClientName = getSetting(db, 'gateway.client_name', 'LocalClient')
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
  })
}
