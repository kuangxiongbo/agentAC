import { getAgentLocalSessionKind, isBindableSessionKind } from './agent-session-binding'
import { config } from './config'
import { eventBus, type ServerEvent } from './event-bus'
import {
  countSuccessfulInterventionsSince,
  getLastInterventionCompletedAt,
  hasSuccessfulInterventionFingerprint,
  logHumanWatchIntervention,
} from './human-watch-audit'
import type { HumanWatchBindingRow } from './human-watch-bindings'
import {
  listAllEnabledHumanWatchBindings,
  listEnabledBindingsForWorkerSession,
} from './human-watch-bindings'
import { isHumanWatchEnabledForTenant } from './human-watch-policy'
import { evaluateHumanWatchRules, type HumanWatchRuleConfig } from './human-watch-rules'
import { transcriptMessagesToHumanWatchLines } from './human-watch-transcript'
import type { HumanWatchBindingMode } from './human-watch-types'
import { logger } from './logger'
import {
  isBridgeClientOnline,
  requestBridgeClientAgentDetail,
  requestBridgeClientSessionContinue,
  requestBridgeClientSessionTranscript,
  requestBridgeClientStewardJudge,
} from './bridge-server'
import {
  buildStewardJudgePrompt,
  buildWorkerSummaryForJudge,
  parseStewardConfigFromAgent,
  type StewardRuntimeConfig,
} from './human-watch-judge'
import type { LocalSessionTranscriptKind, TranscriptMessage } from './session-transcript'
import { getBridgeAgentIndexByLocalId } from './sync-agent-index'
import type { SessionRealtimePayload } from './session-realtime-events'
import {
  buildDefaultBindingRulesOverride,
  DEFAULT_INTERVENTION_PROMPT,
  MAX_INTERVENTIONS_PER_HOUR_DEFAULT,
} from './human-watch-defaults'

const EVAL_DEBOUNCE_MS = 2_000
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
}

const defaultDeps: EvaluateDeps = {
  isBridgeOnline: isBridgeClientOnline,
  fetchTranscript: requestBridgeClientSessionTranscript,
  sendContinue: requestBridgeClientSessionContinue,
  fetchAgentDetail: requestBridgeClientAgentDetail,
  runJudge: requestBridgeClientStewardJudge,
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

function parseRulesOverride(binding: HumanWatchBindingRow): HumanWatchRuleConfig & {
  prompt_template?: string
  grace_after_prompt_seconds?: number
  max_interventions_per_hour?: number
} {
  let override: Record<string, unknown> = {}
  if (binding.rules_override) {
    try {
      override = JSON.parse(binding.rules_override) as Record<string, unknown>
    } catch {
      override = {}
    }
  }
  const defaults = buildDefaultBindingRulesOverride()
  return {
    ...(defaults as HumanWatchRuleConfig & {
      prompt_template?: string
      grace_after_prompt_seconds?: number
      max_interventions_per_hour?: number
    }),
    ...(override as HumanWatchRuleConfig),
    prompt_template:
      typeof override.prompt_template === 'string'
        ? override.prompt_template
        : (defaults.prompt_template as string | undefined),
    grace_after_prompt_seconds:
      typeof override.grace_after_prompt_seconds === 'number'
        ? override.grace_after_prompt_seconds
        : (defaults.grace_after_prompt_seconds as number),
    max_interventions_per_hour:
      typeof override.max_interventions_per_hour === 'number'
        ? override.max_interventions_per_hour
        : (defaults.max_interventions_per_hour as number),
  }
}

function resolveSessionKindForBinding(
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
  if (kind === 'claude-code' || kind === 'codex-cli' || kind === 'hermes') return kind
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
    const config = parseStewardConfigFromAgent(detail.agent)
    if (detail.agent) {
      state.stewardConfigCache.set(cacheKey, { config, at: now })
    }
    return config
  } catch (err) {
    logger.debug({ err, bindingId: binding.id }, '[HumanWatch] Failed to load steward config')
    return cached?.config ?? {}
  }
}

async function resolveInterventionPrompt(
  binding: HumanWatchBindingRow,
  ruleConfig: ReturnType<typeof parseRulesOverride>,
  messages: TranscriptMessage[],
  deps: EvaluateDeps,
): Promise<string> {
  const template = (ruleConfig.prompt_template || DEFAULT_INTERVENTION_PROMPT).trim()
  const stewardId = binding.steward_local_agent_id
  if (!stewardId) return template

  try {
    const stewardConfig = await getStewardConfigForBinding(binding, deps)
    if (!stewardConfig.llm_enabled) return template

    const summary = buildWorkerSummaryForJudge(messages, stewardConfig.context)
    const judgePrompt = buildStewardJudgePrompt(summary, stewardConfig)
    const judge = await deps.runJudge({
      clientId: binding.client_id,
      localAgentId: stewardId,
      prompt: judgePrompt,
    })
    const reply = String(judge.reply || '').trim()
    if (reply) return reply
  } catch (err) {
    logger.warn({ err, bindingId: binding.id }, '[HumanWatch] Steward judge failed; using template')
  }

  return template
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
    const ruleConfig = parseRulesOverride(binding)
    const sessionKind = resolveSessionKindForBinding(binding, options.sessionKind)
    if (!sessionKind) {
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

    if (binding.mode === 'suggest_only') {
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

    const hourAgo = Math.floor(Date.now() / 1000) - 3600
    const recentCount = countSuccessfulInterventionsSince(binding.id, hourAgo)
    const maxPerHour = ruleConfig.max_interventions_per_hour ?? MAX_INTERVENTIONS_PER_HOUR_DEFAULT
    if (recentCount >= maxPerHour) {
      logHumanWatchIntervention({
        ...auditBase(binding),
        eventType: 'intervention_skipped',
        decision: 'skipped',
        rulesHit: evaluation.rulesHit,
        fingerprint: evaluation.fingerprint,
        skipReason: 'rate_limited',
      })
      return
    }

    const prompt = await resolveInterventionPrompt(binding, ruleConfig, page.messages, deps)

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
  const bindings = listEnabledBindingsForWorkerSession(workspaceId, sessionId)
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
