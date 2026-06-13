import { randomUUID } from 'node:crypto'
import type { User } from '@/lib/auth'
import { logSecurityEvent } from '@/lib/security-events'

export interface LocalCliElevationGrantContext {
  grantId: string
  actorUserId?: number | null
  actorName?: string | null
  targetType: 'agent_message' | 'session_continue'
  targetId?: string | number | null
  agentName?: string | null
  sessionKind?: string | null
  sessionId?: string | null
  clientId?: string | null
  workspaceId: number
  tenantId: number
}

export function createLocalCliElevationGrant(input: {
  user?: Pick<User, 'id' | 'display_name' | 'username' | 'workspace_id' | 'tenant_id'> | null
  targetType: LocalCliElevationGrantContext['targetType']
  targetId?: string | number | null
  agentName?: string | null
  sessionKind?: string | null
  sessionId?: string | null
  clientId?: string | null
  source: string
}): LocalCliElevationGrantContext {
  const workspaceId = input.user?.workspace_id ?? 1
  const tenantId = input.user?.tenant_id ?? 1
  const grant: LocalCliElevationGrantContext = {
    grantId: `elev_${randomUUID()}`,
    actorUserId: input.user?.id ?? null,
    actorName: input.user?.display_name || input.user?.username || null,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    agentName: input.agentName ?? null,
    sessionKind: input.sessionKind ?? null,
    sessionId: input.sessionId ?? null,
    clientId: input.clientId ?? null,
    workspaceId,
    tenantId,
  }

  logSecurityEvent({
    event_type: 'local_cli_elevation_granted',
    severity: 'warning',
    source: input.source,
    agent_name: input.agentName ?? undefined,
    detail: JSON.stringify(grant),
    workspace_id: workspaceId,
    tenant_id: tenantId,
  })

  return grant
}

export function logLocalCliElevationDenied(input: {
  user?: Pick<User, 'id' | 'display_name' | 'username' | 'workspace_id' | 'tenant_id'> | null
  targetType: LocalCliElevationGrantContext['targetType']
  targetId?: string | number | null
  agentName?: string | null
  sessionKind?: string | null
  sessionId?: string | null
  clientId?: string | null
  source: string
  reason: string
}) {
  logSecurityEvent({
    event_type: 'local_cli_elevation_denied',
    severity: 'warning',
    source: input.source,
    agent_name: input.agentName ?? undefined,
    detail: JSON.stringify({
      actorUserId: input.user?.id ?? null,
      actorName: input.user?.display_name || input.user?.username || null,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      agentName: input.agentName ?? null,
      sessionKind: input.sessionKind ?? null,
      sessionId: input.sessionId ?? null,
      clientId: input.clientId ?? null,
      reason: input.reason,
    }),
    workspace_id: input.user?.workspace_id ?? 1,
    tenant_id: input.user?.tenant_id ?? 1,
  })
}

export function validateLocalCliElevationGrant(value: unknown): LocalCliElevationGrantContext | null {
  if (!value || typeof value !== 'object') return null
  const grant = value as Partial<LocalCliElevationGrantContext>
  if (typeof grant.grantId !== 'string' || !grant.grantId.startsWith('elev_')) return null
  if (grant.targetType !== 'agent_message' && grant.targetType !== 'session_continue') return null
  if (!Number.isFinite(Number(grant.workspaceId)) || !Number.isFinite(Number(grant.tenantId))) return null
  return {
    grantId: grant.grantId,
    actorUserId: typeof grant.actorUserId === 'number' ? grant.actorUserId : null,
    actorName: typeof grant.actorName === 'string' ? grant.actorName : null,
    targetType: grant.targetType,
    targetId: typeof grant.targetId === 'string' || typeof grant.targetId === 'number' ? grant.targetId : null,
    agentName: typeof grant.agentName === 'string' ? grant.agentName : null,
    sessionKind: typeof grant.sessionKind === 'string' ? grant.sessionKind : null,
    sessionId: typeof grant.sessionId === 'string' ? grant.sessionId : null,
    clientId: typeof grant.clientId === 'string' ? grant.clientId : null,
    workspaceId: Number(grant.workspaceId),
    tenantId: Number(grant.tenantId),
  }
}
