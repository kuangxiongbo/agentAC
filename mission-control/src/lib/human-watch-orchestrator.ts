import { getAgentLocalSessionKind, isBindableSessionKind } from './agent-session-binding'
import { config } from './config'
import { eventBus, type ServerEvent } from './event-bus'
import {
  countSuccessfulInterventionsSince,
  countInterventionSkipsSince,
  getLastInterventionCompletedAt,
  hasSuccessfulInterventionFingerprint,
  logHumanWatchIntervention,
} from './human-watch-audit'
import { createHumanWatchEvent, updateHumanWatchEvent } from './human-watch-events'
import type { HumanWatchEventView } from './human-watch-types'
import type { HumanWatchBindingRow } from './human-watch-bindings'
import {
  disableHumanWatchBinding,
  listAllEnabledHumanWatchBindings,
  listEnabledBindingsForTranscriptUpdate,
} from './human-watch-bindings'
import { isHumanWatchEnabledForTenant } from './human-watch-policy'
import { evaluateHumanWatchRules, type HumanWatchRuleConfig } from './human-watch-rules'
import { transcriptMessagesToHumanWatchLines } from './human-watch-transcript'
import type { HumanWatchBindingMode } from './human-watch-types'
import { logger } from './logger'
import { MEMORY_ALLOWED_PREFIXES, MEMORY_PATH } from './memory-path'
import { searchMemory } from './memory-search'
import { searchStewardMemories } from './steward-memory-search'
import {
  isBridgeClientOnline,
  requestBridgeClientAgentDetail,
  requestBridgeClientSessionContinue,
  requestBridgeClientSessionTranscript,
  requestBridgeClientStewardJudge,
  requestBridgeClientMemorySearch,
} from './bridge-server'
import {
  buildWorkerJudgeContext,
  buildStewardJudgePrompt,
  buildWorkerSummaryForJudge,
  parseStewardConfigFromAgent,
  type StewardRuntimeConfig,
} from './human-watch-judge'
import type { LocalSessionTranscriptKind, TranscriptMessage } from './session-transcript'
import { getBridgeAgentIndexByLocalId } from './sync-agent-index'
import { getSyncedSession } from './sync-sessions'
import type { SessionRealtimePayload } from './session-realtime-events'
import {
  DEFAULT_INTERVENTION_RATE_WINDOW_SECONDS,
  MAX_INTERVENTIONS_PER_WINDOW_DEFAULT,
} from './human-watch-defaults'
import { resolveHumanWatchRulesForBinding } from './human-watch-global-rules'

const EVAL_DEBOUNCE_MS = 5_000
const POLL_INTERVAL_MS = 60_000
const TRANSCRIPT_FETCH_LIMIT = 80
const RULES_LOOKBACK = 12
const STEWARD_CONFIG_CACHE_MS = 60_000

type EvaluateDeps = {
  isBridgeOnline: (clientId: string) => boolean
  fetchTranscript: typeof requestBridgeClientSessionTranscript
  sendContinue: typeof requestBridgeClientSessionContinue
  fetchAgentDetail: typeof requestBridgeClientAgentDetail
  runJudge: typeof requestBridgeClientStewardJudge
  fetchMemoryContext?: (
    binding: HumanWatchBindingRow,
    messages: TranscriptMessage[],
    stewardConfig: StewardRuntimeConfig,
  ) => Promise<string | null>
}

type HumanWatchAutoStopConfig = {
  enabled?: boolean
  max_successful_interventions?: number
  max_runtime_seconds?: number
  max_rate_limited_skips?: number
}

const defaultDeps: EvaluateDeps = {
  isBridgeOnline: isBridgeClientOnline,
  fetchTranscript: requestBridgeClientSessionTranscript,
  sendContinue: requestBridgeClientSessionContinue,
  fetchAgentDetail: requestBridgeClientAgentDetail,
  runJudge: requestBridgeClientStewardJudge,
  fetchMemoryContext: fetchHumanWatchMemoryContext,
}

const globalState = globalThis as typeof globalThis & {
  __humanWatchOrchestrator?: {
    started: boolean
    debounceTimers: Map<string, NodeJS.Timeout>
    inFlight: Set<string>
    pollTimer: NodeJS.Timeout | null
    lastSweepAt: Map<number, number>
    stewardConfigCache: Map<string, { config: StewardRuntimeConfig; at: number }>
  }
}

const state = globalState.__humanWatchOrchestrator ?? {
  started: false,
  debounceTimers: new Map<string, NodeJS.Timeout>(),
  inFlight: new Set<string>(),
  pollTimer: null,
  lastSweepAt: new Map<number, number>(),
  stewardConfigCache: new Map<string, { config: StewardRuntimeConfig; at: number }>(),
}
globalState.__humanWatchOrchestrator = state

function resolveSessionKindForBinding(
  binding: HumanWatchBindingRow,
  hint?: string | null,
): LocalSessionTranscriptKind | null {
  if (isBindableSessionKind(hint) && (hint === 'claude-code' || hint === 'codex-cli' || hint === 'hermes')) {
    return hint
  }
  const storedKind = binding.worker_session_kind
  if (storedKind === 'claude-code' || storedKind === 'codex-cli' || storedKind === 'hermes') {
    return storedKind
  }
  const indexRow = binding.worker_local_agent_id
    ? getBridgeAgentIndexByLocalId(binding.client_id, binding.worker_local_agent_id)
    : undefined
  const kind = getAgentLocalSessionKind(indexRow?.framework)
  if (kind === 'claude-code' || kind === 'codex-cli' || kind === 'hermes') return kind
  const synced = getSyncedSession(binding.client_id, binding.worker_session_id || '')
  const syncedKind = synced?.session_kind
  if (syncedKind === 'claude-code' || syncedKind === 'codex-cli' || syncedKind === 'hermes') return syncedKind
  return null
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

function parseBindingAutoStop(binding: HumanWatchBindingRow): HumanWatchAutoStopConfig {
  if (!binding.rules_override) return {}
  try {
    const parsed = JSON.parse(binding.rules_override) as { auto_stop?: unknown }
    const raw = parsed.auto_stop
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const config = raw as Record<string, unknown>
    return {
      enabled: config.enabled === true,
      max_successful_interventions: positiveInt(config.max_successful_interventions),
      max_runtime_seconds: positiveInt(config.max_runtime_seconds),
      max_rate_limited_skips: positiveInt(config.max_rate_limited_skips),
    }
  } catch {
    return {}
  }
}

function positiveInt(value: unknown): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return undefined
  return Math.floor(n)
}

function resolveAutoStopReason(binding: HumanWatchBindingRow): string | null {
  const config = parseBindingAutoStop(binding)
  if (!config.enabled) return null

  const now = Math.floor(Date.now() / 1000)
  // Re-enabling or reconfiguring a binding starts a fresh auto-stop window.
  const since = Math.max(binding.created_at || 0, binding.updated_at || 0)

  if (config.max_runtime_seconds && since > 0 && now - since >= config.max_runtime_seconds) {
    return `max_runtime_seconds:${config.max_runtime_seconds}`
  }

  if (config.max_successful_interventions) {
    const count = countSuccessfulInterventionsSince(binding.id, since)
    if (count >= config.max_successful_interventions) {
      return `max_successful_interventions:${config.max_successful_interventions}`
    }
  }

  if (config.max_rate_limited_skips) {
    const count = countInterventionSkipsSince(binding.id, 'rate_limited', since)
    if (count >= config.max_rate_limited_skips) {
      return `max_rate_limited_skips:${config.max_rate_limited_skips}`
    }
  }

  return null
}

function maybeAutoStopBinding(binding: HumanWatchBindingRow): boolean {
  const reason = resolveAutoStopReason(binding)
  if (!reason) return false

  const disabled = disableHumanWatchBinding(binding.id, binding.workspace_id)
  if (disabled) {
    logHumanWatchIntervention({
      ...auditBase(binding),
      eventType: 'auto_stop',
      decision: 'disabled',
      outcome: 'success',
      skipReason: reason,
      errorMessage: `Human Watch binding auto-stopped: ${reason}`,
    })
  }
  return disabled
}

function createPendingWatchEvent(
  binding: HumanWatchBindingRow,
  messages: TranscriptMessage[],
  evaluation: { fingerprint: string; rulesHit: Record<string, unknown> },
  source: 'transcript_rule' | 'transcript_wait',
  memoryContext?: string | null,
): HumanWatchEventView {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const summaryParts = [
    binding.worker_name || `worker-${binding.worker_local_agent_id ?? binding.worker_sync_index_id ?? 'unknown'}`,
    lastAssistant?.parts
      ?.map((part) => {
        if (part.type === 'text') return part.text
        if (part.type === 'thinking') return part.thinking
        return null
      })
      .filter(Boolean)
      .join(' ')
      .trim(),
  ].filter(Boolean)
  const workerSummary = buildWorkerSummaryForJudge(messages, {})
  const workerJudgeContext = buildWorkerJudgeContext(messages, {})

  return createHumanWatchEvent({
    workspaceId: binding.workspace_id,
    tenantId: binding.tenant_id,
    clientId: binding.client_id,
    bindingId: binding.id,
    workerSyncIndexId: binding.worker_sync_index_id,
    workerLocalAgentId: binding.worker_local_agent_id,
    workerName: binding.worker_name,
    workerSessionId: binding.worker_session_id,
    stewardSyncIndexId: binding.steward_sync_index_id,
    stewardLocalAgentId: binding.steward_local_agent_id,
    stewardName: binding.steward_name,
    source,
    status: 'pending',
    priority: evaluation.rulesHit.pending_tool || evaluation.rulesHit.confirmation_strong ? 'high' : 'medium',
    title: 'Worker 等待值守介入',
    summary: summaryParts.join(' · ') || 'Worker 会话等待回复或卡住',
    context: {
      event_kind: 'worker_watch',
      session_kind: resolveSessionKindForBinding(binding),
      rules_hit: evaluation.rulesHit,
      fingerprint: evaluation.fingerprint,
      worker_summary: workerSummary,
      worker_judge_context: workerJudgeContext,
      steward_memory_context: memoryContext || null,
      last_user_message:
        lastUser?.parts
          ?.map((part) => (part.type === 'text' ? part.text : null))
          .filter(Boolean)
          .join(' ')
          .trim() || null,
    },
    latestWorkerMessage:
      lastAssistant?.parts
        ?.map((part) => {
          if (part.type === 'text') return part.text
          if (part.type === 'thinking') return part.thinking
          return null
        })
        .filter(Boolean)
        .join(' ')
        .trim() || null,
    suggestedAction: 'send_message_to_worker',
    dedupeKey: `transcript:${binding.id}:${binding.worker_session_id}:${evaluation.fingerprint}`,
  })
}

function messageText(message: TranscriptMessage | undefined): string {
  if (!message) return ''
  return message.parts
    ?.map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'thinking') return part.thinking
      return null
    })
    .filter(Boolean)
    .join(' ')
    .trim() || ''
}

function buildMemoryQuery(messages: TranscriptMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  return [messageText(lastUser), messageText(lastAssistant)]
    .filter(Boolean)
    .join(' ')
    .replace(/[<>{}[\]()`"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

async function fetchHumanWatchMemoryContext(
  binding: HumanWatchBindingRow,
  messages: TranscriptMessage[],
  stewardConfig: StewardRuntimeConfig,
): Promise<string | null> {
  const context = stewardConfig.context ?? {}
  const includeMemory = (context as { include_memory?: boolean }).include_memory !== false
  if (!includeMemory) return null

  const query = buildMemoryQuery(messages)
  if (!query) return null

  try {
    const limit = Math.min(Math.max((context as { memory_search_limit?: number }).memory_search_limit ?? 3, 1), 8)
    const maxChars = Math.min(Math.max((context as { memory_max_chars?: number }).memory_max_chars ?? 1200, 200), 3000)
    let rows = [] as string[]

    const curated = searchStewardMemories({
      workspaceId: binding.workspace_id,
      tenantId: binding.tenant_id,
      query,
      stewardId: binding.steward_local_agent_id,
      clientId: binding.client_id,
      categories: ['preference', 'fact', 'procedure', 'episode'],
      limit,
      maxChars,
    })
    rows.push(...curated.hits.map((hit, index) =>
      `${index + 1}. 值守长期记忆 ${hit.memory.summary || hit.memory.category}: ${hit.snippet}`,
    ))

    try {
      const edge = await requestBridgeClientMemorySearch({
        clientId: binding.client_id,
        query,
        limit,
        timeoutMs: 8000,
      })
      rows.push(...edge.results
        .slice(0, limit)
        .map((result, index) => {
          const agent = result.agentName ? `${result.agentName} / ` : ''
          const snippet = String(result.snippet || '').replace(/\s+/g, ' ').trim()
          return `${index + 1}. ${agent}${result.title || result.path} (${result.source}:${result.path}): ${snippet}`
        })
        .filter((line) => line.trim()))
    } catch (err) {
      logger.debug({ err, bindingId: binding.id }, '[HumanWatch] Edge memory search unavailable')
    }

    if (rows.length === 0 && MEMORY_PATH) {
      const response = await searchMemory(MEMORY_PATH, MEMORY_ALLOWED_PREFIXES, query, { limit })
      rows = response.results
      .slice(0, limit)
      .map((result, index) => {
        const snippet = String(result.snippet || '')
          .replace(/<\/?mark>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
        return `${index + 1}. ${result.title || result.path} (${result.path}): ${snippet}`
      })
      .filter((line) => line.trim())
    }
    if (rows.length === 0) return null
    return [
      '以下为平台记忆库按当前 Worker 问题检索到的参考片段，只作为辅助判断；如与当前会话冲突，以当前会话和安全策略为准。',
      ...rows,
    ].join('\n').slice(0, maxChars)
  } catch (err) {
    logger.debug({ err, bindingId: binding.id }, '[HumanWatch] Memory context search failed')
    return null
  }
}

function withinGracePeriod(bindingId: number, graceSeconds: number): boolean {
  const last = getLastInterventionCompletedAt(bindingId)
  if (!last) return false
  return Math.floor(Date.now() / 1000) - last < graceSeconds
}

async function getStewardConfigForBinding(
  binding: HumanWatchBindingRow,
  deps: EvaluateDeps,
): Promise<StewardRuntimeConfig> {
  const stewardId = binding.steward_local_agent_id
  if (!stewardId) return {}

  const cacheKey = `${binding.client_id}:${stewardId}`
  const cached = state.stewardConfigCache.get(cacheKey)
  const now = Date.now()
  if (cached && now - cached.at < STEWARD_CONFIG_CACHE_MS) {
    return cached.config
  }

  try {
    const detail = await deps.fetchAgentDetail({
      clientId: binding.client_id,
      localAgentId: stewardId,
    })
    const config = { ...parseStewardConfigFromAgent(detail.agent), llm_enabled: true }
    if (detail.agent) {
      state.stewardConfigCache.set(cacheKey, { config, at: now })
    }
    return config
  } catch (err) {
    logger.debug({ err, bindingId: binding.id }, '[HumanWatch] Failed to load steward config')
    return cached?.config ?? { llm_enabled: true }
  }
}

/** 值守仅通过判官 LLM 生成跟进话术；无值守或判官失败时不代发固定模板。 */
async function resolveInterventionPrompt(
  binding: HumanWatchBindingRow,
  messages: TranscriptMessage[],
  deps: EvaluateDeps,
): Promise<
  | { prompt: string; memoryContext?: string | null }
  | { skipReason: 'steward_missing' | 'steward_judge_empty' | 'steward_judge_failed'; errorMessage?: string }
> {
  const stewardId = binding.steward_local_agent_id
  if (!stewardId) {
    return { skipReason: 'steward_missing' }
  }

  try {
    const stewardConfig = await getStewardConfigForBinding(binding, deps)

    const summary = buildWorkerSummaryForJudge(messages, stewardConfig.context)
    const baseWorkerContext = buildWorkerJudgeContext(messages, stewardConfig.context)
    const memoryContext = await deps.fetchMemoryContext?.(binding, messages, stewardConfig)
    const workerContext = [
      baseWorkerContext,
      memoryContext ? `值守记忆检索:\n${memoryContext}` : '',
    ].filter(Boolean).join('\n\n')
    const judgePrompt = buildStewardJudgePrompt(summary, workerContext, stewardConfig)
    const judge = await deps.runJudge({
      clientId: binding.client_id,
      localAgentId: stewardId,
      prompt: judgePrompt,
    })
    const reply = String(judge.reply || '').trim()
    if (reply) return { prompt: reply, memoryContext }
    return { skipReason: 'steward_judge_empty' }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Steward judge failed'
    logger.warn({ err, bindingId: binding.id }, '[HumanWatch] Steward judge failed')
    return { skipReason: 'steward_judge_failed', errorMessage: message }
  }
}

export async function evaluateHumanWatchBinding(
  binding: HumanWatchBindingRow,
  options: {
    sessionId?: string
    sessionKind?: string | null
    trigger?: string
    llmSweep?: boolean
  } = {},
  deps: EvaluateDeps = defaultDeps,
): Promise<void> {
  const sessionId = String(options.sessionId || binding.worker_session_id || '').trim()
  if (!sessionId) return

  const tenantId = binding.tenant_id ?? 1
  if (!isHumanWatchEnabledForTenant(tenantId)) return
  if (!binding.enabled) return
  if (maybeAutoStopBinding(binding)) return
  if (!deps.isBridgeOnline(binding.client_id)) {
    logHumanWatchIntervention({
      ...auditBase(binding),
      eventType: 'intervention_skipped',
      decision: 'skipped',
      workerSessionId: sessionId,
      skipReason: 'bridge_offline',
    })
    return
  }

  const flightKey = `${binding.id}:${sessionId}`
  if (state.inFlight.has(flightKey)) return
  state.inFlight.add(flightKey)

  try {
    const ruleConfig = resolveHumanWatchRulesForBinding(binding)
    const sessionKind = resolveSessionKindForBinding(binding, options.sessionKind)
    if (!sessionKind) {
      logHumanWatchIntervention({
        ...auditBase(binding),
        eventType: 'intervention_skipped',
        decision: 'skipped',
        workerSessionId: sessionId,
        skipReason: 'no_session_kind',
        errorMessage:
          'Worker framework 无法映射到 codex-cli/claude-code；请确认边缘智能体 framework 与当前会话类型一致',
      })
      logger.debug({ bindingId: binding.id }, '[HumanWatch] No session kind for binding')
      return
    }

    const page = await deps.fetchTranscript({
      clientId: binding.client_id,
      kind: sessionKind,
      sessionId,
      limit: TRANSCRIPT_FETCH_LIMIT,
    })

    const lines = transcriptMessagesToHumanWatchLines(page.messages).slice(-RULES_LOOKBACK)
    const evaluation = evaluateHumanWatchRules(lines, ruleConfig)
    const decision = evaluation.matched
      ? (binding.mode as HumanWatchBindingMode)
      : 'noop'

    logHumanWatchIntervention({
      ...auditBase(binding),
      eventType: 'rule_evaluated',
      decision,
      rulesHit: evaluation.rulesHit,
      fingerprint: evaluation.fingerprint,
      skipReason: evaluation.matched ? null : evaluation.reason ?? 'no_rule_match',
    })

    if (options.llmSweep) {
      logHumanWatchIntervention({
        ...auditBase(binding),
        eventType: 'llm_sweep',
        decision: evaluation.matched ? (binding.mode as HumanWatchBindingMode) : 'noop',
        rulesHit: evaluation.rulesHit,
        fingerprint: evaluation.fingerprint,
        llmSweep: true,
        skipReason: evaluation.matched ? null : evaluation.reason ?? 'no_rule_match',
      })
    }

    if (!evaluation.matched) return

    const eventSource =
      options.trigger === 'poll' || options.llmSweep ? 'transcript_wait' : 'transcript_rule'

    if (binding.mode === 'suggest_only') {
      createPendingWatchEvent(
        binding,
        page.messages,
        {
          fingerprint: evaluation.fingerprint,
          rulesHit: evaluation.rulesHit,
        },
        eventSource,
      )
      logHumanWatchIntervention({
        ...auditBase(binding),
        eventType: 'intervention_skipped',
        decision: 'suggest_only',
        rulesHit: evaluation.rulesHit,
        fingerprint: evaluation.fingerprint,
        skipReason: 'suggest_only_mode',
      })
      return
    }

    if (withinGracePeriod(binding.id, ruleConfig.grace_after_prompt_seconds ?? 30)) {
      logHumanWatchIntervention({
        ...auditBase(binding),
        eventType: 'intervention_skipped',
        decision: 'skipped',
        rulesHit: evaluation.rulesHit,
        fingerprint: evaluation.fingerprint,
        skipReason: 'grace_after_prompt',
      })
      return
    }

    if (hasSuccessfulInterventionFingerprint(binding.id, evaluation.fingerprint)) {
      logHumanWatchIntervention({
        ...auditBase(binding),
        eventType: 'intervention_skipped',
        decision: 'skipped',
        rulesHit: evaluation.rulesHit,
        fingerprint: evaluation.fingerprint,
        skipReason: 'fingerprint_duplicate',
      })
      return
    }

    const rateWindowSeconds =
      ruleConfig.max_interventions_window_seconds ?? DEFAULT_INTERVENTION_RATE_WINDOW_SECONDS
    const windowStart = Math.floor(Date.now() / 1000) - rateWindowSeconds
    const recentCount = countSuccessfulInterventionsSince(binding.id, windowStart)
    const maxPerWindow = ruleConfig.max_interventions_per_hour ?? MAX_INTERVENTIONS_PER_WINDOW_DEFAULT
    if (recentCount >= maxPerWindow) {
      logHumanWatchIntervention({
        ...auditBase(binding),
        eventType: 'intervention_skipped',
        decision: 'skipped',
        rulesHit: evaluation.rulesHit,
        fingerprint: evaluation.fingerprint,
        skipReason: 'rate_limited',
      })
      maybeAutoStopBinding(binding)
      return
    }

    const resolved = await resolveInterventionPrompt(binding, page.messages, deps)
    if ('skipReason' in resolved) {
      logHumanWatchIntervention({
        ...auditBase(binding),
        eventType: 'intervention_skipped',
        decision: 'skipped',
        rulesHit: evaluation.rulesHit,
        fingerprint: evaluation.fingerprint,
        skipReason: resolved.skipReason,
        errorMessage: resolved.errorMessage ?? null,
      })
      return
    }
    const prompt = resolved.prompt
    const watchEvent = createPendingWatchEvent(
      binding,
      page.messages,
      {
        fingerprint: evaluation.fingerprint,
        rulesHit: evaluation.rulesHit,
      },
      eventSource,
      resolved.memoryContext,
    )

    logHumanWatchIntervention({
      ...auditBase(binding),
      eventType: 'intervention_attempt',
      decision: 'auto_send',
      rulesHit: evaluation.rulesHit,
      fingerprint: evaluation.fingerprint,
      promptPreview: prompt,
    })

    try {
      await deps.sendContinue({
        clientId: binding.client_id,
        kind: sessionKind,
        sessionId,
        prompt,
      })
      logHumanWatchIntervention({
        ...auditBase(binding),
        eventType: 'intervention_completed',
        decision: 'auto_send',
        rulesHit: evaluation.rulesHit,
        fingerprint: evaluation.fingerprint,
        promptPreview: prompt,
        outcome: 'success',
      })
      maybeAutoStopBinding(binding)
      updateHumanWatchEvent(watchEvent.id, binding.workspace_id, {
        status: 'resolved',
        resolvedAction: 'send_message_to_worker',
        resolvedNote: prompt,
        resolvedByType: 'steward_agent',
        resolvedByAgentId: String(binding.steward_local_agent_id ?? ''),
        contextPatch: {
          auto_send: true,
          intervention_fingerprint: evaluation.fingerprint,
        },
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Bridge continue failed'
      logHumanWatchIntervention({
        ...auditBase(binding),
        eventType: 'intervention_completed',
        decision: 'auto_send',
        rulesHit: evaluation.rulesHit,
        fingerprint: evaluation.fingerprint,
        promptPreview: prompt,
        outcome: 'failed',
        errorMessage: message,
      })
      logger.warn({ err, bindingId: binding.id, sessionId }, '[HumanWatch] Continue failed')
    }
  } catch (err) {
    logger.error({ err, bindingId: binding.id }, '[HumanWatch] Binding evaluation failed')
  } finally {
    state.inFlight.delete(flightKey)
  }
}

function scheduleBindingEvaluation(
  binding: HumanWatchBindingRow,
  sessionId: string,
  sessionKind?: string | null,
  trigger?: string,
) {
  const key = `${binding.id}:${sessionId}`
  const existing = state.debounceTimers.get(key)
  if (existing) clearTimeout(existing)
  state.debounceTimers.set(
    key,
    setTimeout(() => {
      state.debounceTimers.delete(key)
      void evaluateHumanWatchBinding(binding, { sessionId, sessionKind, trigger })
    }, EVAL_DEBOUNCE_MS),
  )
}

function handleTranscriptEvent(payload: SessionRealtimePayload) {
  if (!config.centralMode) return
  const sessionId = String(payload.sessionId || payload.sessionKey || '').trim()
  if (!sessionId) return

  const workspaceId = payload.workspace_id ?? 1
  const bindings = listEnabledBindingsForTranscriptUpdate(workspaceId, sessionId)
  if (bindings.length === 0) return

  for (const binding of bindings) {
    scheduleBindingEvaluation(binding, sessionId, payload.sessionKind, payload.reason)
  }
}

async function pollActiveBindings() {
  if (!config.centralMode) return
  const bindings = listAllEnabledHumanWatchBindings(1)
  for (const binding of bindings) {
    const sessionId = String(binding.worker_session_id || '').trim()
    if (!sessionId) continue
    if (!isBridgeClientOnline(binding.client_id)) continue
    scheduleBindingEvaluation(binding, sessionId, null, 'poll')
  }
}

async function pollLlmSweepBindings(deps: EvaluateDeps = defaultDeps) {
  if (!config.centralMode) return
  const bindings = listAllEnabledHumanWatchBindings(1)
  const now = Date.now()

  for (const binding of bindings) {
    if (!binding.enabled || !binding.steward_local_agent_id) continue
    if (!isHumanWatchEnabledForTenant(binding.tenant_id ?? 1)) continue
    if (!deps.isBridgeOnline(binding.client_id)) continue

    const stewardConfig = await getStewardConfigForBinding(binding, deps)
    if (!stewardConfig.llm_sweep_enabled) continue

    const intervalMs = Math.max(5, stewardConfig.llm_sweep_interval_minutes ?? 30) * 60 * 1000
    const last = state.lastSweepAt.get(binding.id) ?? 0
    if (now - last < intervalMs) continue
    state.lastSweepAt.set(binding.id, now)

    const sessionId = String(binding.worker_session_id || '').trim()
    if (!sessionId) continue

    await evaluateHumanWatchBinding(
      binding,
      { sessionId, trigger: 'llm_sweep', llmSweep: true },
      deps,
    )
  }
}

export function initHumanWatchOrchestrator() {
  if (state.started) return
  if (!config.centralMode) return
  state.started = true

  eventBus.on('server-event', (event: ServerEvent) => {
    if (event.type !== 'session.transcript.updated') return
    handleTranscriptEvent(event.data as SessionRealtimePayload)
  })

  if (!state.pollTimer) {
    state.pollTimer = setInterval(() => {
      void pollActiveBindings()
      void pollLlmSweepBindings()
    }, POLL_INTERVAL_MS)
  }

  void pollActiveBindings()

  logger.info('[HumanWatch] Orchestrator started (transcript events + 60s poll + LLM sweep)')
}

export function stopHumanWatchOrchestrator() {
  for (const timer of state.debounceTimers.values()) clearTimeout(timer)
  state.debounceTimers.clear()
  if (state.pollTimer) {
    clearInterval(state.pollTimer)
    state.pollTimer = null
  }
  state.started = false
}
