import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getAgentLocalSessionKind, isBindableSessionKind } from './agent-session-binding'
import {
  listEnabledBindingsForWorkerSession,
  listHumanWatchBindings,
  type HumanWatchBindingRow,
} from './human-watch-bindings'
import { createHumanWatchEvent, updateHumanWatchEvent } from './human-watch-events'
import {
  buildStewardJudgePrompt,
  buildWorkerJudgeContext,
  buildWorkerSummaryForJudge,
  parseStewardJudgeDecision,
  parseStewardConfigFromAgent,
} from './human-watch-judge'
import type { HumanWatchBindingMode } from './human-watch-types'
import { getBridgeAgentIndexByLocalId } from './sync-agent-index'
import {
  isBridgeClientOnline,
  requestBridgeClientAgentDetail,
  requestBridgeClientSessionContinue,
  requestBridgeClientSessionTranscript,
  requestBridgeClientStewardJudge,
} from './bridge-server'
import type { LocalSessionTranscriptKind, TranscriptMessage } from './session-transcript'
import { logHumanWatchIntervention } from './human-watch-audit'

export interface HumanWatchAssistInput {
  workspaceId: number
  tenantId?: number | null
  clientId?: string | null
  bindingId?: number | null
  workerLocalAgentId?: number | null
  workerSessionId?: string | null
  sessionKind?: string | null
  title?: string | null
  prompt: string
  workerName?: string | null
  context?: Record<string, unknown> | null
  source?: 'worker_mcp' | 'manual_api'
}

export interface HumanWatchAssistResult {
  ok: true
  binding: HumanWatchBindingRow
  eventId: string
  stewardReply: string
  delivered: boolean
  sessionId: string | null
}

export function resolveHumanWatchAssistBinding(input: HumanWatchAssistInput, database?: Database.Database): HumanWatchBindingRow | null {
  if (input.bindingId != null) {
    const bindings = listHumanWatchBindings({ workspaceId: input.workspaceId }, database)
    return bindings.find((binding) => binding.id === input.bindingId) ?? null
  }

  const sessionId = String(input.workerSessionId || '').trim()
  if (sessionId) {
    const matches = listEnabledBindingsForWorkerSession(input.workspaceId, sessionId, database)
      .filter((binding) => !input.clientId || binding.client_id === input.clientId)
    if (matches.length > 0) return matches[0]!
  }

  const clientId = String(input.clientId || '').trim()
  const workerLocalAgentId = Number(input.workerLocalAgentId)
  if (clientId && Number.isFinite(workerLocalAgentId)) {
    return listHumanWatchBindings({ workspaceId: input.workspaceId, clientId, enabled: true }, database)
      .find((binding) => binding.worker_local_agent_id === workerLocalAgentId) ?? null
  }

  return null
}

function resolveSessionKind(
  binding: HumanWatchBindingRow,
  hint?: string | null,
): LocalSessionTranscriptKind | null {
  if (isBindableSessionKind(hint) && (hint === 'claude-code' || hint === 'codex-cli' || hint === 'hermes')) {
    return hint
  }
  const indexRow = binding.worker_local_agent_id
    ? getBridgeAgentIndexByLocalId(binding.client_id, binding.worker_local_agent_id)
    : undefined
  const kind = getAgentLocalSessionKind(indexRow?.framework)
  return kind === 'claude-code' || kind === 'codex-cli' || kind === 'hermes' ? kind : null
}

function buildFallbackMessages(input: HumanWatchAssistInput): TranscriptMessage[] {
  const now = new Date().toISOString()
  return [
    {
      role: 'assistant',
      parts: [{ type: 'text', text: input.prompt }],
      timestamp: now,
    },
  ]
}

function auditBase(binding: HumanWatchBindingRow) {
  return {
    workspaceId: binding.workspace_id,
    tenantId: binding.tenant_id,
    clientId: binding.client_id,
    bindingId: binding.id,
    workerSyncIndexId: binding.worker_sync_index_id,
    workerLocalAgentId: binding.worker_local_agent_id,
    workerName: binding.worker_name,
    stewardSyncIndexId: binding.steward_sync_index_id,
    stewardLocalAgentId: binding.steward_local_agent_id,
    stewardName: binding.steward_name,
    workerSessionId: binding.worker_session_id,
  }
}

export async function triggerHumanWatchAssist(
  input: HumanWatchAssistInput,
  database?: Database.Database,
): Promise<HumanWatchAssistResult> {
  const prompt = String(input.prompt || '').trim()
  if (!prompt) throw new Error('prompt is required')

  const binding = resolveHumanWatchAssistBinding(input, database)
  if (!binding) throw new Error('Human-watch binding not found for worker session')
  if (!binding.enabled) throw new Error('Human-watch binding is disabled')
  if (!binding.steward_local_agent_id) throw new Error('Human-watch steward is not configured')
  if (!isBridgeClientOnline(binding.client_id)) throw new Error(`Bridge client is offline: ${binding.client_id}`)

  const sessionId = String(input.workerSessionId || binding.worker_session_id || '').trim()
  if (!sessionId) throw new Error('worker_session_id is required')

  const sessionKind = resolveSessionKind(binding, input.sessionKind)
  if (!sessionKind) throw new Error('Unable to resolve worker session kind')

  const event = createHumanWatchEvent({
    workspaceId: binding.workspace_id,
    tenantId: binding.tenant_id,
    clientId: binding.client_id,
    bindingId: binding.id,
    workerSyncIndexId: binding.worker_sync_index_id,
    workerLocalAgentId: binding.worker_local_agent_id,
    workerName: input.workerName || binding.worker_name,
    workerSessionId: sessionId,
    stewardSyncIndexId: binding.steward_sync_index_id,
    stewardLocalAgentId: binding.steward_local_agent_id,
    stewardName: binding.steward_name,
    source: 'worker_tool',
    status: 'pending',
    priority: 'high',
    title: input.title || 'Worker 请求值守回复',
    summary: prompt.slice(0, 500),
    context: {
      ...(input.context ?? {}),
      event_kind: 'worker_watch',
      trigger: input.source || 'worker_mcp',
      session_kind: sessionKind,
      worker_prompt: prompt,
    },
    latestWorkerMessage: prompt,
    suggestedAction: 'send_message_to_worker',
    dedupeKey: `worker-mcp:${binding.id}:${sessionId}:${randomUUID()}`,
  }, database)

  let messages: TranscriptMessage[] = buildFallbackMessages(input)
  try {
    const page = await requestBridgeClientSessionTranscript({
      clientId: binding.client_id,
      kind: sessionKind,
      sessionId,
      limit: 80,
      timeoutMs: 15000,
    })
    if (page.messages.length > 0) messages = page.messages
  } catch (err) {
    logHumanWatchIntervention({
      ...auditBase(binding),
      eventType: 'intervention_skipped',
      decision: 'skipped',
      skipReason: 'transcript_fetch_failed',
      errorMessage: err instanceof Error ? err.message : String(err),
    })
  }

  const stewardDetail = await requestBridgeClientAgentDetail({
    clientId: binding.client_id,
    localAgentId: binding.steward_local_agent_id,
    timeoutMs: 12000,
  })
  const stewardConfig = { ...parseStewardConfigFromAgent(stewardDetail.agent), llm_enabled: true }
  const summary = buildWorkerSummaryForJudge(messages, stewardConfig.context)
  const workerContext = [
    buildWorkerJudgeContext(messages, stewardConfig.context),
    `- Worker 主动求助: ${prompt}`,
  ].join('\n')
  const judgePrompt = buildStewardJudgePrompt(summary, workerContext, stewardConfig)

  const judge = await requestBridgeClientStewardJudge({
    clientId: binding.client_id,
    localAgentId: binding.steward_local_agent_id,
    prompt: judgePrompt,
    timeoutMs: 180000,
  })
  const rawReply = String(judge.reply || '').trim()
  const decision = parseStewardJudgeDecision(rawReply)
  if (!decision) {
    updateHumanWatchEvent(event.id, binding.workspace_id, {
      status: 'resolved',
      resolvedAction: 'dismiss',
      resolvedNote: 'steward_judge_empty',
      resolvedByType: 'steward_agent',
      resolvedByAgentId: String(binding.steward_local_agent_id),
    }, database)
    throw new Error('Steward judge returned empty reply')
  }
  if (decision.action === 'escalate_human') {
    logHumanWatchIntervention({
      ...auditBase(binding),
      eventType: 'intervention_skipped',
      decision: 'skipped',
      skipReason: 'steward_escalated_human',
      errorMessage: decision.reason || 'Steward requested human review',
    })
    throw new Error(decision.reason || 'Steward requested human review')
  }
  const reply = decision.reply

  logHumanWatchIntervention({
    ...auditBase(binding),
    eventType: 'intervention_attempt',
    decision: binding.mode as HumanWatchBindingMode,
    promptPreview: reply,
  })

  const delivered = binding.mode === 'auto_send'
  let resolvedSessionId: string | null = sessionId
  if (delivered) {
    const sent = await requestBridgeClientSessionContinue({
      clientId: binding.client_id,
      kind: sessionKind,
      sessionId,
      prompt: reply,
      timeoutMs: 180000,
    })
    resolvedSessionId = sent.sessionId || sessionId
  }

  updateHumanWatchEvent(event.id, binding.workspace_id, {
    status: 'resolved',
    resolvedAction: delivered ? 'send_message_to_worker' : 'dismiss',
    resolvedNote: reply,
    resolvedByType: 'steward_agent',
    resolvedByAgentId: String(binding.steward_local_agent_id),
    contextPatch: {
      steward_reply: reply,
      delivered,
    },
  }, database)

  logHumanWatchIntervention({
    ...auditBase(binding),
    eventType: 'intervention_completed',
    decision: binding.mode as HumanWatchBindingMode,
    promptPreview: reply,
    outcome: 'success',
  })

  return {
    ok: true,
    binding,
    eventId: event.id,
    stewardReply: reply,
    delivered,
    sessionId: resolvedSessionId,
  }
}
