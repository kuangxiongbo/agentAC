import { config } from './config'
import { logger } from './logger'
import type Database from 'better-sqlite3'
import {
  patchPermissionRequestContext,
  type PermissionRequestOption,
  type PermissionRequestView,
} from './permission-requests'

function gatewayUrl(p: string): string {
  return `http://${config.gatewayHost}:${config.gatewayPort}${p}`
}

function contextString(request: PermissionRequestView, key: string): string | null {
  const value = request.context?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function mapPermissionOptionToExecAction(option: PermissionRequestOption): 'approve' | 'deny' | 'always_allow' {
  if (option.action === 'deny' || option.action === 'ask_human') return 'deny'
  if (option.id === 'always_allow' || option.id === 'approve_always') return 'always_allow'
  return 'approve'
}

export async function forwardPermissionDecisionToExecApproval(input: {
  request: PermissionRequestView
  option: PermissionRequestOption
  reason?: string | null
  database?: Database.Database
}): Promise<{ status: 'skipped' | 'applied' | 'failed'; execApprovalId?: string; error?: string }> {
  const execApprovalId = contextString(input.request, 'gateway_exec_approval_id')
  if (!execApprovalId) return { status: 'skipped' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(gatewayUrl('/api/exec-approvals/respond'), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: execApprovalId,
        action: mapPermissionOptionToExecAction(input.option),
        reason: input.reason ?? input.request.decision_reason ?? undefined,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Gateway exec approval respond failed: HTTP ${res.status} ${text.slice(0, 160)}`)
    }
    patchPermissionRequestContext(
      {
        requestId: input.request.id,
        workspaceId: input.request.workspace_id,
        patch: {
          gateway_exec_forward: {
            status: 'applied',
            exec_approval_id: execApprovalId,
            action: mapPermissionOptionToExecAction(input.option),
            applied_at: Math.floor(Date.now() / 1000),
          },
        },
      },
      input.database,
    )
    return { status: 'applied', execApprovalId }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to forward permission decision to exec approval'
    logger.warn({ err, requestId: input.request.id, execApprovalId }, 'Failed to forward permission decision to exec approval')
    patchPermissionRequestContext(
      {
        requestId: input.request.id,
        workspaceId: input.request.workspace_id,
        patch: {
          gateway_exec_forward: {
            status: 'failed',
            exec_approval_id: execApprovalId,
            action: mapPermissionOptionToExecAction(input.option),
            error: message,
            failed_at: Math.floor(Date.now() / 1000),
            retryable: true,
          },
        },
      },
      input.database,
    )
    return { status: 'failed', execApprovalId, error: message }
  } finally {
    clearTimeout(timeout)
  }
}
