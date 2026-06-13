import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { requireRole } from '@/lib/auth'
import { config } from '@/lib/config'
import { logger } from '@/lib/logger'
import { createPermissionRequest, getPermissionRequest } from '@/lib/permission-requests'
import path from 'node:path'

function gatewayUrl(p: string): string {
  return `http://${config.gatewayHost}:${config.gatewayPort}${p}`
}

function execApprovalsPath(): string {
  return path.join(config.openclawHome, 'exec-approvals.json')
}

function computeHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/**
 * GET /api/exec-approvals - Fetch pending execution approval requests
 * GET /api/exec-approvals?action=allowlist - Fetch per-agent allowlists
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const action = request.nextUrl.searchParams.get('action')

  if (action === 'allowlist') {
    return getAllowlist()
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await fetch(gatewayUrl('/api/exec-approvals'), {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    })
    clearTimeout(timeout)

    if (!res.ok) {
      logger.warn({ status: res.status }, 'Gateway exec-approvals endpoint returned error')
      return NextResponse.json({ approvals: [] })
    }

    const data = await res.json()
    syncExecApprovalsToPermissionRequests(data?.approvals, auth.user.workspace_id ?? 1, auth.user.tenant_id ?? 1)
    return NextResponse.json(data)
  } catch (err: any) {
    clearTimeout(timeout)
    if (err.name === 'AbortError') {
      logger.warn('Gateway exec-approvals request timed out')
    } else {
      logger.warn({ err }, 'Gateway exec-approvals unreachable')
    }
    return NextResponse.json({ approvals: [] })
  }
}

function syncExecApprovalsToPermissionRequests(approvals: unknown, workspaceId: number, tenantId: number) {
  if (!Array.isArray(approvals)) return
  for (const approval of approvals) {
    if (!approval || typeof approval !== 'object') continue
    const item = approval as Record<string, any>
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : ''
    if (!id) continue
    const requestId = `exec:${id}`
    if (getPermissionRequest(requestId, workspaceId)) continue
    const nested = item.request && typeof item.request === 'object' ? item.request as Record<string, any> : item
    const command = String(nested.command || item.command || item.toolName || item.name || 'Execution approval').trim()
    try {
      createPermissionRequest({
        id: requestId,
        workspaceId,
        tenantId,
        clientId: typeof item.client_id === 'string' ? item.client_id : null,
        workerName: String(nested.agentId || item.agentName || '').trim() || null,
        workerSessionId: String(nested.sessionKey || item.sessionId || '').trim() || null,
        requestType: 'gateway_exec_approval',
        title: 'Execution approval required',
        prompt: command,
        risk: ['low', 'medium', 'high', 'critical'].includes(item.risk) ? item.risk : 'medium',
        options: [
          { id: 'approve_once', label: 'Allow once', action: 'approve' },
          { id: 'always_allow', label: 'Always allow', action: 'approve' },
          { id: 'deny', label: 'Deny', action: 'deny' },
        ],
        context: {
          gateway_exec_approval_id: id,
          command,
          cwd: nested.cwd || item.cwd || null,
          host: nested.host || item.host || null,
          resolvedPath: nested.resolvedPath || item.resolvedPath || null,
        },
        expiresAt:
          typeof item.expiresAt === 'number'
            ? Math.floor(item.expiresAt / (item.expiresAt > 10_000_000_000 ? 1000 : 1))
            : null,
      })
    } catch (err) {
      logger.debug({ err, approvalId: id }, 'Failed to mirror exec approval as permission request')
    }
  }
}

async function getAllowlist(): Promise<NextResponse> {
  const filePath = execApprovalsPath()
  try {
    const { readFile } = require('fs/promises')
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    const agents: Record<string, { pattern: string }[]> = {}
    if (parsed?.agents && typeof parsed.agents === 'object') {
      for (const [agentId, agentConfig] of Object.entries(parsed.agents)) {
        const cfg = agentConfig as any
        if (Array.isArray(cfg?.allowlist)) {
          agents[agentId] = cfg.allowlist.map((e: any) => ({ pattern: String(e?.pattern ?? '') }))
        } else {
          agents[agentId] = []
        }
      }
    }
    return NextResponse.json({ agents, hash: computeHash(raw) })
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return NextResponse.json({ agents: {}, hash: computeHash('') })
    }
    logger.warn({ err }, 'Failed to read exec-approvals config')
    return NextResponse.json({ error: `Failed to read config: ${err.message}` }, { status: 500 })
  }
}

/**
 * PUT /api/exec-approvals - Save allowlist changes
 * Body: { agents: Record<string, { pattern: string }[]>, hash?: string }
 */
export async function PUT(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: { agents: Record<string, { pattern: string }[]>; hash?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.agents || typeof body.agents !== 'object') {
    return NextResponse.json({ error: 'Missing required field: agents' }, { status: 400 })
  }

  const filePath = execApprovalsPath()
  try {
    const { readFile, writeFile, mkdir } = require('fs/promises')
    const { existsSync } = require('fs')

    let parsed: any = { version: 1, agents: {} }
    try {
      const raw = await readFile(filePath, 'utf-8')
      parsed = JSON.parse(raw)

      if (body.hash) {
        const serverHash = computeHash(raw)
        if (body.hash !== serverHash) {
          return NextResponse.json(
            { error: 'Config has been modified. Please reload and try again.', code: 'CONFLICT' },
            { status: 409 },
          )
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }

    if (!parsed.agents) parsed.agents = {}

    for (const [agentId, patterns] of Object.entries(body.agents)) {
      if (!parsed.agents[agentId]) parsed.agents[agentId] = {}
      if (patterns.length === 0) {
        delete parsed.agents[agentId].allowlist
      } else {
        parsed.agents[agentId].allowlist = patterns.map((p: { pattern: string }) => ({
          pattern: String(p.pattern ?? ''),
        }))
      }
    }

    const dir = path.dirname(filePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }

    const newRaw = JSON.stringify(parsed, null, 2) + '\n'
    await writeFile(filePath, newRaw, { mode: 0o600 })

    return NextResponse.json({ ok: true, hash: computeHash(newRaw) })
  } catch (err: any) {
    logger.error({ err }, 'Failed to save exec-approvals config')
    return NextResponse.json({ error: `Failed to save: ${err.message}` }, { status: 500 })
  }
}

/**
 * POST /api/exec-approvals - Respond to an execution approval request
 * Body: { id: string, action: 'approve' | 'deny' | 'always_allow', reason?: string }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: { id: string; action: string; reason?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.id || typeof body.id !== 'string') {
    return NextResponse.json({ error: 'Missing required field: id' }, { status: 400 })
  }

  const validActions = ['approve', 'deny', 'always_allow']
  if (!validActions.includes(body.action)) {
    return NextResponse.json({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` }, { status: 400 })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await fetch(gatewayUrl('/api/exec-approvals/respond'), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: body.id,
        action: body.action,
        reason: body.reason,
      }),
    })
    clearTimeout(timeout)

    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch (err: any) {
    clearTimeout(timeout)
    if (err.name === 'AbortError') {
      logger.error('Gateway exec-approvals respond request timed out')
      return NextResponse.json({ error: 'Gateway request timed out' }, { status: 504 })
    }
    logger.error({ err }, 'Gateway exec-approvals respond failed')
    return NextResponse.json({ error: 'Gateway unreachable' }, { status: 502 })
  }
}
