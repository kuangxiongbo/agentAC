import { basename, dirname, join } from 'node:path'
import { NextResponse } from 'next/server'
import type { User } from './auth'
import { config } from './config'
import { getDatabase, logAuditEvent } from './db'
import type { WorkspaceIsolation } from './workspaces'

export type WorkspaceResource = 'agent_filesystem' | 'local_sessions' | 'gateway_sessions'
  | 'host_administration' | 'runtime_configuration' | 'runtime_tasks'
  | 'session_transcripts' | 'session_preferences' | 'terminal_sessions' | 'runtime_memory'
  | 'permission_requests'

interface IsolationRecord { id: number; tenant_id: number; isolation: WorkspaceIsolation }
export interface EdgeResourceOwnership {
  clientId?: string | null
  localAgentId?: number | null
  sessionId?: string | null
  sessionKind?: string | null
}

function readIsolation(user: User): IsolationRecord | null {
  return getDatabase().prepare(`
    SELECT id, tenant_id, isolation FROM workspaces
    WHERE id = ? AND tenant_id = ? LIMIT 1
  `).get(user.workspace_id, user.tenant_id) as IsolationRecord | undefined || null
}

export function getWorkspaceIsolation(user: User): WorkspaceIsolation | null {
  return readIsolation(user)?.isolation ?? null
}

export function resolveSharedRuntimeWorkspaceId(): number | null {
  const rows = getDatabase().prepare(`SELECT id FROM workspaces WHERE isolation = 'shared' ORDER BY id LIMIT 2`)
    .all() as Array<{ id: number }>
  return rows.length === 1 ? rows[0].id : null
}

function auditDenial(user: User, resource: WorkspaceResource, route: string, reason: string): void {
  try {
    logAuditEvent({
      action: 'workspace_isolation_denied', actor: user.username || 'unknown', actor_id: user.id,
      target_type: 'workspace', target_id: user.workspace_id, workspace_id: user.workspace_id,
      detail: { resource, route, tenant_id: user.tenant_id, reason },
    })
  } catch { /* access control must not depend on audit availability */ }
}

function edgeOwnershipMatches(user: User, ownership: EdgeResourceOwnership): boolean {
  const db = getDatabase()
  if (!ownership.clientId) {
    if (ownership.localAgentId == null) return false
    return Boolean(db.prepare(`SELECT 1 FROM agents WHERE id = ? AND workspace_id = ? LIMIT 1`)
      .get(ownership.localAgentId, user.workspace_id))
  }
  const client = db.prepare(`SELECT workspace_id FROM sync_clients WHERE client_id = ? LIMIT 1`)
    .get(ownership.clientId) as { workspace_id?: number } | undefined
  if (!client || client.workspace_id !== user.workspace_id) return false

  if (ownership.localAgentId != null) {
    const agent = db.prepare(`SELECT 1 FROM sync_agent_index WHERE client_id = ? AND local_agent_id = ? LIMIT 1`)
      .get(ownership.clientId, ownership.localAgentId)
    if (!agent) return false
  }
  if (ownership.sessionId || ownership.sessionKind) {
    if (!ownership.sessionId || !ownership.sessionKind) return false
    const session = db.prepare(`
      SELECT 1 FROM sync_sessions
      WHERE client_id = ? AND session_id = ? AND session_kind = ? LIMIT 1
    `).get(ownership.clientId, ownership.sessionId, ownership.sessionKind)
    if (!session) return false
  }
  return true
}

export function denyResourceOutsideWorkspace(
  user: User,
  resource: WorkspaceResource,
  route: string,
  ownership?: EdgeResourceOwnership | null,
): NextResponse | null {
  const workspace = readIsolation(user)
  if (!workspace) {
    auditDenial(user, resource, route, 'workspace_context_unavailable')
    return NextResponse.json({ error: 'Workspace isolation context is unavailable' }, { status: 403 })
  }
  if (ownership) {
    if (edgeOwnershipMatches(user, ownership)) return null
    auditDenial(user, resource, route, 'edge_resource_ownership_mismatch')
    return NextResponse.json({ error: 'Edge resource does not belong to this workspace' }, { status: 403 })
  }
  if (workspace.isolation === 'shared') return null
  auditDenial(user, resource, route, 'resource_has_no_workspace_ownership')
  return NextResponse.json({ error: 'This resource has no authoritative workspace ownership' }, { status: 403 })
}

export function resolveWorkspaceMemoryAccess(user: User) {
  const base = config.memoryDir
  const workspace = readIsolation(user)
  if (!base || !workspace) return null
  if (workspace.isolation === 'strict') {
    return {
      isolation: 'strict' as const,
      root: join(dirname(base), `${basename(base)}-workspaces`, String(workspace.id)),
      scope: `workspace:${workspace.id}`,
    }
  }
  return { isolation: 'shared' as const, root: base, scope: 'shared' }
}
