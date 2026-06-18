import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  getHumanWatchEvent,
  updateHumanWatchEvent,
} from '@/lib/human-watch-events'
import type { HumanWatchEventAction } from '@/lib/human-watch-types'
import { getPermissionRequest, decidePermissionRequest } from '@/lib/permission-requests'
import { requestBridgeClientSessionContinue } from '@/lib/bridge-server'
import { notifySessionTranscriptUpdated } from '@/lib/session-realtime'
import { enqueueLocalSessionPrompt, isLocalSessionKind } from '@/lib/local-session-executor'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { id } = await context.params
  const eventId = String(id || '').trim()
  const action = String(body.action || '').trim() as HumanWatchEventAction
  const workspaceId = auth.user.workspace_id ?? 1

  if (!eventId) {
    return NextResponse.json({ error: 'event id is required' }, { status: 400 })
  }
  if (!['send_message_to_worker', 'approve_request', 'deny_request', 'dismiss'].includes(action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  const event = getHumanWatchEvent(eventId, workspaceId)
  if (!event) {
    return NextResponse.json({ error: 'Human watch event not found' }, { status: 404 })
  }

  if (event.status === 'resolved' || event.status === 'dismissed' || event.status === 'expired') {
    return NextResponse.json({ error: `Event already ${event.status}` }, { status: 409 })
  }

  try {
    if (action === 'send_message_to_worker') {
      const message = String(body.message || '').trim()
      if (!message) {
        return NextResponse.json({ error: 'message is required' }, { status: 400 })
      }
      if (!event.client_id || !event.worker_session_id) {
        return NextResponse.json({ error: 'Event missing client_id or worker_session_id' }, { status: 400 })
      }
      const contextJson = event.context
      const kind = typeof contextJson?.session_kind === 'string' ? contextJson.session_kind.trim() : ''
      if (!kind || !['claude-code', 'codex-cli', 'hermes', 'cursor', 'opencode'].includes(kind)) {
        return NextResponse.json({ error: 'Event missing valid session_kind' }, { status: 400 })
      }
      updateHumanWatchEvent(eventId, workspaceId, {
        status: 'claimed',
        claimedByType: 'human_user',
        claimedByUserId: auth.user.id,
      })
      let continued: unknown
      try {
        continued = await requestBridgeClientSessionContinue({
          clientId: event.client_id,
          kind: kind as 'claude-code' | 'codex-cli' | 'hermes' | 'cursor' | 'opencode',
          sessionId: event.worker_session_id,
          prompt: message,
          timeoutMs: 180000,
        })
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err)
        if (!/not connected|socket unavailable|timed out/i.test(messageText) || !isLocalSessionKind(kind)) {
          throw err
        }
        continued = enqueueLocalSessionPrompt(kind, event.worker_session_id, message)
      }
      notifySessionTranscriptUpdated(
        kind as 'claude-code' | 'codex-cli' | 'hermes',
        event.worker_session_id,
        'human_watch_action',
      )
      const updated = updateHumanWatchEvent(eventId, workspaceId, {
        status: 'resolved',
        resolvedAction: 'send_message_to_worker',
        resolvedNote: message,
        resolvedByType: 'human_user',
        resolvedByUserId: auth.user.id,
      })
      return NextResponse.json({ event: updated, continueResult: continued })
    }

    if (action === 'dismiss') {
      updateHumanWatchEvent(eventId, workspaceId, {
        status: 'claimed',
        claimedByType: 'human_user',
        claimedByUserId: auth.user.id,
      })
      const updated = updateHumanWatchEvent(eventId, workspaceId, {
        status: 'dismissed',
        resolvedAction: 'dismiss',
        resolvedNote: typeof body.note === 'string' ? body.note : null,
        resolvedByType: 'human_user',
        resolvedByUserId: auth.user.id,
      })
      return NextResponse.json({ event: updated })
    }

    const permissionRequestId = event.permission_request_id
    if (!permissionRequestId) {
      return NextResponse.json({ error: 'Event is not linked to a permission request' }, { status: 400 })
    }
    const currentRequest = getPermissionRequest(permissionRequestId, workspaceId)
    if (!currentRequest) {
      return NextResponse.json({ error: 'Permission request not found' }, { status: 404 })
    }
    const option = currentRequest.options.find((item) => item.action === (action === 'approve_request' ? 'approve' : 'deny'))
    if (!option) {
      return NextResponse.json({ error: `Permission request has no ${action} option` }, { status: 400 })
    }
    updateHumanWatchEvent(eventId, workspaceId, {
      status: 'claimed',
      claimedByType: 'human_user',
      claimedByUserId: auth.user.id,
    })
    const decided = decidePermissionRequest({
      requestId: permissionRequestId,
      workspaceId,
      optionId: option.id,
      reason: typeof body.note === 'string' ? body.note : null,
      deciderType: 'human_user',
      deciderUserId: auth.user.id,
      decisionSource: 'human_watch_event_action',
    })
    if (event.worker_session_id) {
      const kind = typeof event.context?.session_kind === 'string' ? event.context.session_kind.trim() : ''
      if (kind === 'claude-code' || kind === 'codex-cli' || kind === 'hermes') {
        notifySessionTranscriptUpdated(kind, event.worker_session_id, 'human_watch_permission_decided')
      }
    }
    const updated = getHumanWatchEvent(eventId, workspaceId)
    return NextResponse.json({ event: updated, request: decided })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to handle human watch event action'
    const rolledBack = updateHumanWatchEvent(eventId, workspaceId, {
      status: 'pending',
      claimedByType: null,
      claimedByUserId: null,
      claimedByAgentId: null,
    })
    const normalized = /not connected|socket unavailable|timed out/i.test(message)
      ? '边缘客户端当前未在线，无法把值守消息回写到 Worker 会话。请先恢复 Bridge 连接后重试。'
      : message
    return NextResponse.json({ error: normalized, event: rolledBack }, { status: 500 })
  }
}
