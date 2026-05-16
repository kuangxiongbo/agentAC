import { getDatabase, logAuditEvent } from './db'
import { detectAllRuntimes } from './agent-runtimes'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { getMainAgentRuntimeMeta } from './runtime-agents'

interface RuntimeAgentSyncResult {
  created: number
  updated: number
  hidden: number
  detected: string[]
  message: string
}

function buildRuntimeConfig(runtime: ReturnType<typeof detectAllRuntimes>[number]) {
  return {
    runtime_managed: true,
    main_agent: true,
    runtime_id: runtime.id,
    detected: runtime.installed,
    installed: runtime.installed,
    version: runtime.version,
    running: runtime.running,
    auth_required: runtime.authRequired,
    authenticated: runtime.authenticated,
    install_supported: runtime.installSupported,
    description: runtime.description,
  }
}

export async function syncRuntimeAgents(actor = 'system'): Promise<RuntimeAgentSyncResult> {
  const db = getDatabase()
  const runtimes = detectAllRuntimes()
  const now = Math.floor(Date.now() / 1000)

  const existing = db.prepare(`
    SELECT id, name, framework, hidden, config
    FROM agents
    WHERE source = 'runtime' AND parent_id IS NULL
  `).all() as Array<{
    id: number
    name: string
    framework: string | null
    hidden: number | null
    config: string | null
  }>

  const existingByFramework = new Map<string, typeof existing[number]>()
  for (const row of existing) {
    if (row.framework) existingByFramework.set(row.framework, row)
  }

  const findNameConflict = db.prepare(`
    SELECT id FROM agents WHERE name = ? AND source != 'runtime' LIMIT 1
  `)
  const childCountStmt = db.prepare(`SELECT COUNT(*) as c FROM agents WHERE parent_id = ?`)

  const insertStmt = db.prepare(`
    INSERT INTO agents (name, role, status, source, last_seen, created_at, updated_at, config, framework, hidden)
    VALUES (?, ?, ?, 'runtime', ?, ?, ?, ?, ?, 0)
  `)
  const updateStmt = db.prepare(`
    UPDATE agents
    SET name = ?, role = ?, status = ?, last_seen = ?, updated_at = ?, config = ?, framework = ?, hidden = ?
    WHERE id = ?
  `)

  let created = 0
  let updated = 0
  let hidden = 0
  const detected = runtimes.filter((runtime) => runtime.installed).map((runtime) => runtime.id)

  db.transaction(() => {
    for (const runtime of runtimes) {
      const meta = getMainAgentRuntimeMeta(runtime.id)
      if (!meta) continue

      const existingRow = existingByFramework.get(runtime.id)
      const configJson = JSON.stringify(buildRuntimeConfig(runtime))
      const status = runtime.installed ? 'idle' : 'offline'

      let runtimeName = meta.mainAgentName
      if (!existingRow && findNameConflict.get(runtimeName)) {
        runtimeName = `${meta.label} Runtime`
      }

      if (runtime.installed) {
        if (existingRow) {
          updateStmt.run(runtimeName, 'main-agent', status, now, now, configJson, runtime.id, 0, existingRow.id)
          updated++
        } else {
          insertStmt.run(runtimeName, 'main-agent', status, now, now, now, configJson, runtime.id)
          created++
        }
        continue
      }

      if (!existingRow) continue

      const childCountRow = childCountStmt.get(existingRow.id) as { c: number }
      const shouldHide = (childCountRow?.c || 0) === 0 ? 1 : 0
      updateStmt.run(existingRow.name, 'main-agent', 'offline', 0, now, configJson, runtime.id, shouldHide, existingRow.id)
      updated++
      if (shouldHide) hidden++
    }
  })()

  if (created > 0 || updated > 0) {
    logAuditEvent({
      action: 'runtime_agent_sync',
      actor,
      detail: { created, updated, hidden, detected },
    })

    eventBus.broadcast('agent.synced', {
      source: 'runtime',
      created,
      updated,
      hidden,
      detected,
    })
  }

  const message = `Runtime agent sync: ${created} created, ${updated} updated, ${hidden} hidden (${detected.length} detected)`
  logger.info({ created, updated, hidden, detected }, 'Runtime agent sync complete')

  return { created, updated, hidden, detected, message }
}
