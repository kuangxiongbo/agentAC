import { NextRequest, NextResponse } from 'next/server'
import os from 'node:os'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { getDatabase } from '@/lib/db'
import { getAllGatewaySessions } from '@/lib/sessions'
import { requireRole } from '@/lib/auth'
import { detectProviderSubscriptions, getPrimarySubscription } from '@/lib/provider-subscriptions'
import { APP_VERSION } from '@/lib/version'
import { isHermesInstalled } from '@/lib/hermes-sessions'
import { config } from '@/lib/config'
import { enrichAgentConfigFromWorkspace } from '@/lib/agent-sync'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const workspaceId = auth.user.workspace_id ?? 1

  try {
    const db = getDatabase()

    // 1. Fetch Agents (with task stats)
    const agents = db.prepare('SELECT * FROM agents WHERE workspace_id = ? AND hidden = 0 ORDER BY created_at DESC').all(workspaceId) as any[]
    const agentNames = agents.map(a => a.name).filter(Boolean)
    const taskStatsByAgent = new Map<string, any>()

    if (agentNames.length > 0) {
      const placeholders = agentNames.map(() => '?').join(', ')
      const groupedTaskStats = db.prepare(`
        SELECT
          assigned_to,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) as assigned,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status = 'quality_review' THEN 1 ELSE 0 END) as quality_review,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
        FROM tasks
        WHERE workspace_id = ? AND assigned_to IN (${placeholders})
        GROUP BY assigned_to
      `).all(workspaceId, ...agentNames) as any[]

      for (const row of groupedTaskStats) {
        taskStatsByAgent.set(row.assigned_to, {
          total: row.total || 0,
          assigned: row.assigned || 0,
          in_progress: row.in_progress || 0,
          quality_review: row.quality_review || 0,
          done: row.done || 0,
          completed: row.done || 0,
        })
      }
    }

    const agentsWithStats = agents.map(agent => ({
      ...agent,
      config: enrichAgentConfigFromWorkspace(agent.config ? JSON.parse(agent.config) : {}),
      taskStats: taskStatsByAgent.get(agent.name) || { total: 0, assigned: 0, in_progress: 0, quality_review: 0, done: 0, completed: 0 }
    }))

    // 2. Fetch Sessions
    const sessions = getAllGatewaySessions()

    // 3. Fetch Projects
    const projects = db.prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY id ASC').all(workspaceId) as any[]

    // 4. Fetch Capabilities (from status/route.ts logic)
    const openclawHome = Boolean(
      (config.openclawStateDir && existsSync(config.openclawStateDir)) ||
      (config.openclawConfigPath && existsSync(config.openclawConfigPath))
    )
    const claudeHome = existsSync(path.join(config.claudeHome, 'projects'))
    const primary = getPrimarySubscription()
    const subscription = primary ? { type: primary.type, provider: primary.provider } : null
    
    // Interface mode preference
    let interfaceMode = 'essential'
    const modeRow = db.prepare("SELECT value FROM settings WHERE key = 'general.interface_mode'").get() as { value: string } | undefined
    if (modeRow?.value === 'full' || modeRow?.value === 'essential') {
      interfaceMode = modeRow.value
    }

    const hermesInstalled = isHermesInstalled()
    const processUser = process.env.MC_DEFAULT_ORG_NAME || os.userInfo().username

    // 5. Fetch Settings (for clientName)
    const settings = db.prepare('SELECT * FROM settings').all() as any[]
    const clientName = settings.find(s => s.key === 'gateway.client_name')?.value || 'LocalClient'

    // 6. Fetch Skills (simplified list for init)
    let skillsList: any[] = []
    try {
      const skillRows = db.prepare('SELECT name, source, path, description, registry_slug, security_status FROM skills ORDER BY name').all() as any[]
      skillsList = skillRows.map(r => ({
        id: `${r.source}:${r.name}`,
        name: r.name,
        source: r.source,
        path: r.path,
        description: r.description || undefined,
        registry_slug: r.registry_slug,
        security_status: r.security_status,
      }))
    } catch { /* skills table may not exist */ }

    return NextResponse.json({
      version: APP_VERSION,
      agents: agentsWithStats,
      sessions,
      projects,
      settings,
      clientName,
      skills: skillsList,
      capabilities: {
        gateway: true,
        openclawHome,
        claudeHome,
        subscription,
        processUser,
        interfaceMode,
        hermesInstalled
      }
    })
  } catch (error) {
    console.error('Init API error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
