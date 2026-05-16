import { getDatabase } from './db'
import { logger } from './logger'

const AGENT_REGISTER_TTL_MS = 5 * 60 * 1000
const agentRegistrationCache = new Map<string, { signature: string; lastRegisteredAt: number }>()

function getSetting(key: string, defaultValue: string = ''): string {
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value || defaultValue
  } catch {
    return defaultValue
  }
}

/** 仅允许 http(s) 绝对地址；否则 Node fetch 会在 `new Request` 阶段抛错（如 `127.0.0.1:5000` 漏写协议）。 */
function resolveValidGatewaySyncBase(raw: string): string | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (!u.host) return null
    return u.origin
  } catch {
    return null
  }
}

function setSetting(key: string, value: string): void {
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, strftime('%s', 'now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value)
  } catch (err) {
    logger.error({ err, key, value }, 'Failed to persist setting during sync')
  }
}

/**
 * Ensures we have a persistent, unique ID for this client instance
 * so the upstream gateway can track it across renames or IP changes.
 */
function getOrCreateSyncClientId(): string {
  let id = getSetting('device.client_id')
  if (!id) {
    id = `mc-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`
    setSetting('device.client_id', id)
  }
  return id
}

function buildAgentRegistrationSignature(agent: { status: string; role: string }): string {
  return `${agent.status}|${agent.role || 'agent'}`
}

function shouldRegisterAgent(agentName: string, signature: string, now: number): boolean {
  const cached = agentRegistrationCache.get(agentName)
  if (!cached) return true
  if (cached.signature !== signature) return true
  return now - cached.lastRegisteredAt >= AGENT_REGISTER_TTL_MS
}

function markAgentRegistered(agentName: string, signature: string, now: number): void {
  agentRegistrationCache.set(agentName, { signature, lastRegisteredAt: now })
}

function toHeaderSafeAgentName(value: string): string {
  return encodeURIComponent(value)
}

function slugifyAscii(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function hashSuffix(value: string): string {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return hash.toString(36).slice(0, 8)
}

function buildRemoteAgentRegistrationName(clientName: string, agentName: string): string {
  const clientSlug = slugifyAscii(clientName) || 'edge'
  const agentSlug = slugifyAscii(agentName)
  if (agentSlug) return `${clientSlug}-${agentSlug}`.slice(0, 63)
  return `${clientSlug}-agent-${hashSuffix(agentName)}`.slice(0, 63)
}

function normalizeRemoteRegisterRole(role: string): string {
  const normalized = String(role || '').trim().toLowerCase()
  if (!normalized) return 'agent'
  if (normalized.includes('review')) return 'reviewer'
  if (normalized.includes('test') || normalized.includes('qa')) return 'tester'
  if (normalized.includes('ops') || normalized.includes('devops') || normalized.includes('infra')) return 'devops'
  if (normalized.includes('research')) return 'researcher'
  if (normalized.includes('assistant')) return 'assistant'
  if (normalized.includes('coder') || normalized.includes('developer') || normalized.includes('engineer') || normalized.includes('build')) return 'coder'
  return 'agent'
}

let isSyncing = false

export async function runServerGatewaySync(): Promise<{ ok: boolean; message: string }> {
  if (isSyncing) return { ok: true, message: 'Sync already in progress' }
  isSyncing = true
  try {
    const gatewayUrlRaw = getSetting('gateway.server_url')
    const gatewayUrl = resolveValidGatewaySyncBase(gatewayUrlRaw)
    const gatewayToken = getSetting('gateway.token')
    const clientName = getSetting('gateway.client_name', 'E-Agent-Center')
    const syncClientId = getOrCreateSyncClientId()

    if (!gatewayUrl) {
      if (String(gatewayUrlRaw || '').trim()) {
        logger.warn(
          { gatewayUrlRaw: String(gatewayUrlRaw).trim().slice(0, 120) },
          'gateway.server_url is set but not a valid http(s) URL — skipping gateway sync (use e.g. http://127.0.0.1:5000)',
        )
      }
      return { ok: false, message: 'Gateway URL not configured or invalid (need http:// or https://)' }
    }

    const db = getDatabase()
    const agents = db.prepare('SELECT id, name, status, role FROM agents').all() as Array<{
      id: number
      name: string
      status: string
      role: string
    }>

    logger.info({ agentCount: agents.length, gatewayUrl, clientName, syncClientId }, 'Starting gateway sync push')

    const syncHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-sync-client-id': syncClientId,
      'x-sync-client-name': clientName,
      'x-sync-agent-count': String(agents.length),
      ...(gatewayToken ? { 'x-api-key': gatewayToken } : {}),
    }

    // 1. Heartbeat to upstream to register/update client identity
    try {
      const hbRes = await fetch(`${gatewayUrl}/api/server-sync/heartbeat`, {
        method: 'POST',
        headers: syncHeaders,
        body: JSON.stringify({
          client_id: syncClientId,
          client_name: clientName,
          agent_count: agents.length,
          timestamp: Math.floor(Date.now() / 1000),
        }),
      })
      if (!hbRes.ok) {
        const errText = await hbRes.text().catch(() => '')
        logger.warn({ status: hbRes.status, body: errText }, 'Upstream heartbeat failed')
      }
    } catch (err) {
      logger.warn({ err }, 'Upstream heartbeat failed (network)')
    }

    let syncedCount = 0
    let taskCount = 0
    let skippedRegistrations = 0
    let registerFailures = 0
    let taskPollFailures = 0
    let chatSyncFailures = 0
    let settingsSyncFailures = 0
    let authFailures = 0

    // 2. Sync Agents
    for (const agent of agents) {
      try {
        const fullAgentName = buildRemoteAgentRegistrationName(clientName, agent.name)
        const headerAgentName = toHeaderSafeAgentName(fullAgentName)
        const registrationSignature = buildAgentRegistrationSignature(agent)
        const now = Date.now()

        if (shouldRegisterAgent(fullAgentName, registrationSignature, now)) {
          const res = await fetch(`${gatewayUrl}/api/agents/register`, {
            method: 'POST',
            headers: {
              ...syncHeaders,
              'x-agent-name': headerAgentName,
            },
            body: JSON.stringify({
              name: fullAgentName,
              status: agent.status,
              role: normalizeRemoteRegisterRole(agent.role),
              original_name: agent.name,
            }),
          })

          if (res.ok) {
            syncedCount++
            markAgentRegistered(fullAgentName, registrationSignature, now)
          } else {
            registerFailures++
            if (res.status === 401 || res.status === 403) authFailures++
            const errorText = await res.text().catch(() => '')
            logger.warn(
              { status: res.status, body: errorText, remoteName: fullAgentName, localAgent: agent.name },
              'Upstream agent registration rejected',
            )
          }
        } else {
          skippedRegistrations++
        }

        // 3. Poll Tasks for this agent
        const taskRes = await fetch(`${gatewayUrl}/api/tasks/queue?agent=${encodeURIComponent(fullAgentName)}`, {
          headers: {
            ...syncHeaders,
            'x-agent-name': headerAgentName,
          },
        })

        if (taskRes.ok) {
          const taskData = await taskRes.json()
          if (taskData && taskData.task) {
            try {
              const task = taskData.task
              const existing = db.prepare('SELECT id FROM tasks WHERE remote_id = ?').get(task.id)
              if (!existing) {
                db.prepare(`
                  INSERT INTO tasks (remote_id, title, status, assigned_to, priority, created_at, updated_at)
                  VALUES (?, ?, 'inbox', ?, 'medium', strftime('%s', 'now'), strftime('%s', 'now'))
                `).run(task.id, task.title, agent.name)
                taskCount++
              }
            } catch (err) {
              logger.error({ err, remoteTaskId: taskData.task?.id, agent: agent.name }, 'Failed to save upstream task')
            }
          }
        } else {
          taskPollFailures++
          if (taskRes.status === 401 || taskRes.status === 403) authFailures++
        }
      } catch (err) {
        registerFailures++
        logger.warn({ err, agent: agent.name, gatewayUrl }, 'Failed to sync agent with upstream')
      }
    }

    // 4. Sync Chat Messages (increase limit to 100 for catch-up)
    const unsyncedMessages = db.prepare(`
      SELECT id, conversation_id, from_agent, to_agent, content, message_type, metadata, created_at
      FROM messages
      WHERE workspace_id = 1 AND COALESCE(synced, 0) = 0
      ORDER BY created_at ASC
      LIMIT 100
    `).all() as any[]

    for (const msg of unsyncedMessages) {
      try {
        const res = await fetch(`${gatewayUrl}/api/chat/sync`, {
          method: 'POST',
          headers: syncHeaders,
          body: JSON.stringify({ message: msg }),
        })
        if (res.ok) {
          db.prepare('UPDATE messages SET synced = 1 WHERE id = ?').run(msg.id)
        } else {
          chatSyncFailures++
          if (res.status === 401 || res.status === 403) authFailures++
        }
      } catch (err) {
        chatSyncFailures++
        logger.warn({ err, messageId: msg.id }, 'Failed to sync chat message upstream')
      }
    }

    // 5. Sync Settings
    const globalSettings = db.prepare(`
      SELECT key, value, category
      FROM settings
      WHERE category IN ('global', 'remote', 'gateway', 'chat')
    `).all()

    if (globalSettings.length > 0) {
      try {
        const settingsRes = await fetch(`${gatewayUrl}/api/settings/sync`, {
          method: 'POST',
          headers: syncHeaders,
          body: JSON.stringify({ settings: globalSettings }),
        })
        if (!settingsRes.ok) {
          settingsSyncFailures++
          if (settingsRes.status === 401 || settingsRes.status === 403) authFailures++
        }
      } catch {
        settingsSyncFailures++
      }
    }

    // 6. Notify task completion
    const recentlyCompleted = db.prepare(`
      SELECT id, remote_id, status
      FROM tasks
      WHERE status = 'done' AND remote_notified IS NULL AND remote_id IS NOT NULL
      LIMIT 50
    `).all() as Array<any>

    for (const task of recentlyCompleted) {
      try {
        await fetch(`${gatewayUrl}/api/tasks/${task.remote_id}`, {
          method: 'PUT',
          headers: syncHeaders,
          body: JSON.stringify({ status: 'done', progress: 100 }),
        })
        db.prepare('UPDATE tasks SET remote_notified = 1 WHERE id = ?').run(task.id)
      } catch {
        // ignore
      }
    }

    const totalFailures = registerFailures + taskPollFailures + chatSyncFailures + settingsSyncFailures
    if (totalFailures > 0) {
      const authNote = authFailures > 0 ? `, ${authFailures} auth failure(s)` : ''
      const registerNote = registerFailures > 0 ? `, ${registerFailures} register failure(s)` : ''
      const taskPollNote = taskPollFailures > 0 ? `, ${taskPollFailures} task poll failure(s)` : ''
      const skipNote = skippedRegistrations > 0 ? `, ${skippedRegistrations} registration(s) skipped` : ''
      return {
        ok: false,
        message: `Gateway Sync partial failure: ${syncedCount} agents pushed, ${taskCount} tasks pulled${skipNote}${registerNote}${taskPollNote}, ${chatSyncFailures} chat sync failure(s), ${settingsSyncFailures} settings sync failure(s)${authNote}`,
      }
    }

    // If we hit the limit, there might be more. Schedule another run soon.
    if (unsyncedMessages.length >= 100) {
      setTimeout(() => {
        runServerGatewaySync().catch(() => {})
      }, 1000)
    }

    const skipNote = skippedRegistrations > 0 ? `, ${skippedRegistrations} registration(s) skipped` : ''
    return { ok: true, message: `Gateway Sync: ${syncedCount} agents pushed, ${taskCount} tasks pulled${skipNote}` }
  } catch (err: any) {
    return { ok: false, message: `Gateway sync failed: ${err.message}` }
  } finally {
    isSyncing = false
  }
}
