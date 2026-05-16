import { randomUUID } from 'node:crypto'
import { getDatabase } from './db'
import { logger } from './logger'
import { getSyncableSessions } from './session-sync'
import { getSyncableSkills } from './skill-sync-export'
import { getSyncableMemoryAgents } from './memory-sync'

const AGENT_REGISTER_TTL_MS = 5 * 60 * 1000
const AGENT_REGISTRATION_CACHE_SCHEMA_VERSION = '3'
const agentRegistrationCache = new Map<string, { signature: string; lastRegisteredAt: number }>()

// Helper to fetch settings
function getSetting(key: string, defaultValue: string = ''): string {
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value || defaultValue
  } catch {
    return defaultValue
  }
}

function getOrCreateSyncClientId(): string {
  try {
    const db = getDatabase()
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'device.client_id'`).get() as { value?: string } | undefined
    const existing = typeof row?.value === 'string' ? row.value.trim() : ''
    if (existing) return existing
    const created = `mc-local-${randomUUID()}`
    db.prepare(`INSERT OR IGNORE INTO settings (key, value, category) VALUES ('device.client_id', ?, 'device')`).run(created)
    return created
  } catch {
    return 'mc-local-static'
  }
}

function getLastPublishedClientName(): string {
  try {
    const db = getDatabase()
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'device.client_last_published_name'`).get() as { value?: string } | undefined
    return typeof row?.value === 'string' ? row.value.trim() : ''
  } catch {
    return ''
  }
}

function setLastPublishedClientName(value: string): void {
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO settings (key, value, category, updated_at, updated_by)
      VALUES ('device.client_last_published_name', ?, 'device', unixepoch(), 'system')
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(value)
  } catch {
    // ignore
  }
}

function getLastServerAgentSyncMode(): string {
  try {
    const db = getDatabase()
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'device.server_agent_sync_mode'`).get() as { value?: string } | undefined
    return typeof row?.value === 'string' ? row.value.trim() : ''
  } catch {
    return ''
  }
}

function setLastServerAgentSyncMode(value: string): void {
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO settings (key, value, category, updated_at, updated_by)
      VALUES ('device.server_agent_sync_mode', ?, 'device', unixepoch(), 'system')
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(value)
  } catch {
    // ignore
  }
}

function getLastAgentRegistrationCacheVersion(): string {
  try {
    const db = getDatabase()
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'device.agent_registration_cache_version'`).get() as { value?: string } | undefined
    return typeof row?.value === 'string' ? row.value.trim() : ''
  } catch {
    return ''
  }
}

function setLastAgentRegistrationCacheVersion(value: string): void {
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO settings (key, value, category, updated_at, updated_by)
      VALUES ('device.agent_registration_cache_version', ?, 'device', unixepoch(), 'system')
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(value)
  } catch {
    // ignore
  }
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

export async function runServerGatewaySync(): Promise<{ ok: boolean; message: string }> {
  try {
    const gatewayUrl = getSetting('gateway.server_url')
    const gatewayToken = getSetting('gateway.token')
    const clientName = getSetting('gateway.client_name', 'LocalClient')
    const clientId = getOrCreateSyncClientId()
    const previousClientName = getLastPublishedClientName()
    const previousAgentSyncMode = getLastServerAgentSyncMode()
    const previousCacheVersion = getLastAgentRegistrationCacheVersion()

    if (previousCacheVersion !== AGENT_REGISTRATION_CACHE_SCHEMA_VERSION) {
      agentRegistrationCache.clear()
      setLastAgentRegistrationCacheVersion(AGENT_REGISTRATION_CACHE_SCHEMA_VERSION)
    }

    if (!gatewayUrl) {
      return { ok: false, message: 'Gateway URL not configured' }
    }

    const db = getDatabase()
    const agents = db.prepare(`
      SELECT id, name, status, role, framework, parent_id
      FROM agents
      WHERE hidden = 0
      ORDER BY
        CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END,
        CASE WHEN source = 'runtime' THEN 0 ELSE 1 END,
        name COLLATE NOCASE ASC
    `).all() as Array<{
      id: number
      name: string
      status: string
      role: string
      framework: string | null
      parent_id: number | null
    }>
    const agentNameById = new Map<number, string>()
    for (const agent of agents) {
      agentNameById.set(agent.id, agent.name)
    }
    const syncHeaders = {
      'x-sync-client-id': clientId,
      'x-sync-client-name': clientName,
      'x-sync-agent-count': String(agents.length),
    }

    logger.info({ agentCount: agents.length, gatewayUrl }, 'Starting gateway sync push')

    let syncedCount = 0
    let taskCount = 0
    let skippedRegistrations = 0
    let registerFailures = 0
    let taskPollFailures = 0
    let chatSyncFailures = 0
    let settingsSyncFailures = 0
    let authFailures = 0
    let sessionSyncFailures = 0
    let skillSyncFailures = 0
    let memorySyncFailures = 0
    let clientsOnlyMode = false

    try {
      const heartbeatRes = await fetch(`${gatewayUrl}/api/server-sync/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...syncHeaders,
          ...(gatewayToken ? { 'x-api-key': gatewayToken } : {}),
        },
        body: JSON.stringify({
          client_id: clientId,
          client_name: clientName,
          previous_client_name: previousClientName || undefined,
          agent_count: agents.length,
        }),
      })
      if (heartbeatRes.ok) {
        const heartbeatData = await heartbeatRes.json().catch(() => null)
        clientsOnlyMode = heartbeatData?.agent_sync_mode === 'clients-only'
        const currentAgentSyncMode = clientsOnlyMode ? 'clients-only' : 'full'
        if (previousAgentSyncMode !== currentAgentSyncMode) {
          agentRegistrationCache.clear()
        }
        setLastPublishedClientName(clientName)
        setLastServerAgentSyncMode(currentAgentSyncMode)
      } else if (heartbeatRes.status === 401 || heartbeatRes.status === 403) {
        authFailures++
      }
    } catch (err) {
      logger.warn({ err, gatewayUrl }, 'Failed to publish client heartbeat upstream')
    }

    // 1.5 Sync Session Snapshots Upstream
    try {
      const sessions = await getSyncableSessions()
      const sessionRes = await fetch(`${gatewayUrl}/api/sessions/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...syncHeaders,
          ...(gatewayToken ? { 'x-api-key': gatewayToken } : {}),
        },
        body: JSON.stringify({
          client_id: clientId,
          client_name: clientName,
          sessions,
        }),
      })
      if (!sessionRes.ok) {
        sessionSyncFailures++
        if (sessionRes.status === 401 || sessionRes.status === 403) authFailures++
      }
    } catch (err) {
      sessionSyncFailures++
      logger.warn({ err, gatewayUrl }, 'Failed to sync session snapshots upstream')
    }

    // 1.6 Sync Skill Index Upstream
    try {
      const skills = getSyncableSkills()
      const skillRes = await fetch(`${gatewayUrl}/api/skills/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...syncHeaders,
          ...(gatewayToken ? { 'x-api-key': gatewayToken } : {}),
        },
        body: JSON.stringify({
          client_id: clientId,
          client_name: clientName,
          skills,
        }),
      })
      if (!skillRes.ok) {
        skillSyncFailures++
        if (skillRes.status === 401 || skillRes.status === 403) authFailures++
      }
    } catch (err) {
      skillSyncFailures++
      logger.warn({ err, gatewayUrl }, 'Failed to sync skills upstream')
    }

    // 1.7 Sync Memory Summaries Upstream
    try {
      const memoryAgents = getSyncableMemoryAgents()
      const memoryRes = await fetch(`${gatewayUrl}/api/memory/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...syncHeaders,
          ...(gatewayToken ? { 'x-api-key': gatewayToken } : {}),
        },
        body: JSON.stringify({
          client_id: clientId,
          client_name: clientName,
          agents: memoryAgents,
        }),
      })
      if (!memoryRes.ok) {
        memorySyncFailures++
        if (memoryRes.status === 401 || memoryRes.status === 403) authFailures++
      }
    } catch (err) {
      memorySyncFailures++
      logger.warn({ err, gatewayUrl }, 'Failed to sync memory summaries upstream')
    }

    // 2. Sync Agents Upstream
    for (const agent of clientsOnlyMode ? [] : agents) {
      try {
        const fullAgentName = buildRemoteAgentRegistrationName(clientName, agent.name)
        const headerAgentName = toHeaderSafeAgentName(fullAgentName)
        const registrationSignature = buildAgentRegistrationSignature(agent)
        const now = Date.now()
        if (shouldRegisterAgent(fullAgentName, registrationSignature, now)) {
          const res = await fetch(`${gatewayUrl}/api/agents/register`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-agent-name': headerAgentName,
              ...syncHeaders,
              ...(gatewayToken ? { 'x-api-key': gatewayToken } : {})
            },
            body: JSON.stringify({
              name: fullAgentName,
              status: agent.status,
              role: normalizeRemoteRegisterRole(agent.role),
              framework: agent.framework || undefined,
              original_name: agent.name,
              parent_name: agent.parent_id ? (agentNameById.get(agent.parent_id) || undefined) : undefined,
            })
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

        // 2. Poll tasks from Gateway for this agent
        const taskRes = await fetch(`${gatewayUrl}/api/tasks/queue?agent=${fullAgentName}`, {
          headers: {
            'x-agent-name': headerAgentName,
            ...syncHeaders,
            ...(gatewayToken ? { 'x-api-key': gatewayToken } : {})
          }
        })
        if (taskRes.ok) {
          const taskData = await taskRes.json()
          if (taskData && taskData.task) {
            // Task assigned from Gateway! Create it in local DB so local agent can pick it up.
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

    // 3. Sync Chat Messages Upstream
    const unsyncedMessages = db.prepare(`
      SELECT id, conversation_id, from_agent, to_agent, content, message_type, metadata, created_at
      FROM messages 
      WHERE workspace_id = 1 AND synced = 0
      ORDER BY created_at ASC
      LIMIT 20
    `).all() as any[]

    for (const msg of unsyncedMessages) {
      try {
        const res = await fetch(`${gatewayUrl}/api/chat/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...syncHeaders,
            ...(gatewayToken ? { 'x-api-key': gatewayToken } : {})
          },
          body: JSON.stringify({ message: msg })
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

    // 4. Sync Global Settings Upstream (once an hour or triggered)
    // For simplicity, we just push all 'global' and 'remote' category settings
    const globalSettings = db.prepare(`SELECT key, value, category FROM settings WHERE category IN ('global', 'remote')`).all()
    if (globalSettings.length > 0) {
      try {
        const settingsRes = await fetch(`${gatewayUrl}/api/settings/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...syncHeaders,
            ...(gatewayToken ? { 'x-api-key': gatewayToken } : {})
          },
          body: JSON.stringify({ settings: globalSettings })
        })
        if (!settingsRes.ok) {
          settingsSyncFailures++
          if (settingsRes.status === 401 || settingsRes.status === 403) authFailures++
        }
      } catch (err) {
        settingsSyncFailures++
      }
    }

    // 5. Push completed task state upstream (simplistic sync, pushing locally finished tasks back to gateway)
    const recentlyCompleted = db.prepare(`SELECT id, remote_id, status FROM tasks WHERE status = 'done' AND remote_notified is null AND remote_id IS NOT NULL limit 50`).all() as Array<any>
    for (const task of recentlyCompleted) {
      try {
         await fetch(`${gatewayUrl}/api/tasks/${task.remote_id}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...syncHeaders,
              ...(gatewayToken ? { 'x-api-key': gatewayToken } : {})
            },
            body: JSON.stringify({ status: 'done', progress: 100 })
          })
          db.prepare('UPDATE tasks SET remote_notified = 1 WHERE id = ?').run(task.id)
      } catch (e) {
         // ignore
      }
    }

    const totalFailures = registerFailures + taskPollFailures + chatSyncFailures + settingsSyncFailures + sessionSyncFailures + skillSyncFailures + memorySyncFailures
    if (totalFailures > 0) {
      const authNote = authFailures > 0 ? `, ${authFailures} auth failure(s)` : ''
      const registerNote = registerFailures > 0 ? `, ${registerFailures} register failure(s)` : ''
      const taskPollNote = taskPollFailures > 0 ? `, ${taskPollFailures} task poll failure(s)` : ''
      const sessionSyncNote = sessionSyncFailures > 0 ? `, ${sessionSyncFailures} session sync failure(s)` : ''
      const skillSyncNote = skillSyncFailures > 0 ? `, ${skillSyncFailures} skill sync failure(s)` : ''
      const memorySyncNote = memorySyncFailures > 0 ? `, ${memorySyncFailures} memory sync failure(s)` : ''
      const skipNote = skippedRegistrations > 0 ? `, ${skippedRegistrations} registration(s) skipped` : ''
      return {
        ok: false,
        message: `Gateway Sync partial failure: ${syncedCount} agents pushed, ${taskCount} tasks pulled${skipNote}${registerNote}${taskPollNote}${sessionSyncNote}${skillSyncNote}${memorySyncNote}, ${chatSyncFailures} chat sync failure(s), ${settingsSyncFailures} settings sync failure(s)${authNote}`,
      }
    }

    if (clientsOnlyMode) {
      return { ok: true, message: 'Gateway Sync: client heartbeat updated, local agent mirroring disabled by server policy' }
    }

    const skipNote = skippedRegistrations > 0 ? `, ${skippedRegistrations} registration(s) skipped` : ''
    return { ok: true, message: `Gateway Sync: ${syncedCount} agents pushed, ${taskCount} tasks pulled${skipNote}` }
  } catch (err: any) {
    return { ok: false, message: `Gateway sync failed: ${err.message}` }
  }
}
