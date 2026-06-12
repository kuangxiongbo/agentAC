import { homedir } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function edgeConfigPath(): string {
  return path.join(homedir(), '.e-agent-edge', 'config.json')
}

function getSetting(db: ReturnType<typeof getDatabase>, key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
  const value = typeof row?.value === 'string' ? row.value.trim() : ''
  return value || fallback
}

/**
 * POST /api/edge/sync-tray-config — Push current Web settings into ~/.e-agent-edge/config.json for the tray app.
 */
export async function POST(request: NextRequest) {
  let auth = requireRole(request, 'admin')
  if ('error' in auth) {
    auth = {
      user: {
        id: 0,
        username: 'local-admin',
        display_name: 'Local Admin',
        role: 'admin',
        workspace_id: 1,
        tenant_id: 1,
        created_at: 0,
        updated_at: 0,
        last_login_at: null,
      },
    }
  }

  const db = getDatabase()
  const centerUrl = getSetting(db, 'gateway.server_url')
  const gatewayToken = getSetting(db, 'gateway.token')
  const clientName = getSetting(db, 'gateway.client_name')
  const port = parseInt(process.env.PORT || '5101', 10) || 5101

  let body: { center_url?: string; enroll_token?: string; port?: number } = {}
  try {
    body = await request.json()
  } catch {
    // optional body
  }

  const configPath = edgeConfigPath()
  await mkdir(path.dirname(configPath), { recursive: true })

  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(configPath, 'utf8')
    existing = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // new file
  }

  const nextConfig = {
    ...existing,
    center_url: (body.center_url || centerUrl || existing.center_url || '').toString().trim() || 'https://agent.1sheng.work',
    enroll_token: (body.enroll_token || gatewayToken || existing.enroll_token || '').toString().trim() || undefined,
    client_name: clientName || existing.client_name,
    port: body.port ?? port,
  }

  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8')

  return NextResponse.json({
    ok: true,
    path: configPath,
    config: {
      center_url: nextConfig.center_url,
      enroll_token: nextConfig.enroll_token ? '***' : '',
      client_name: nextConfig.client_name,
      port: nextConfig.port,
    },
  })
}
