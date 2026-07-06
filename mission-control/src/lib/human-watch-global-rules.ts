import type Database from 'better-sqlite3'
import { getDatabase } from './db'
import { buildDefaultGlobalRules } from './human-watch-defaults'
import type { HumanWatchBindingRow } from './human-watch-bindings'
import type { HumanWatchRuleConfig } from './human-watch-rules'

export type HumanWatchGlobalRules = HumanWatchRuleConfig & {
  grace_after_prompt_seconds?: number
  max_interventions_per_hour?: number
  max_interventions_window_seconds?: number
}

function dbOr(database?: Database.Database): Database.Database {
  return database ?? getDatabase()
}

function safeParseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** 租户级全局值守判断规则（L1–L3 + 节流），所有绑定共用。 */
export function getHumanWatchGlobalRules(
  tenantId: number,
  database?: Database.Database,
): Record<string, unknown> {
  if (!Number.isFinite(tenantId) || tenantId < 1) {
    return { ...buildDefaultGlobalRules() }
  }
  const db = dbOr(database)
  const row = db
    .prepare(`SELECT human_watch_rules_json FROM tenants WHERE id = ? LIMIT 1`)
    .get(tenantId) as { human_watch_rules_json?: string | null } | undefined
  const stored = safeParseJson(row?.human_watch_rules_json ?? null)
  return mergeGlobalRulesWithDefaults(stored)
}

export function setHumanWatchGlobalRules(
  tenantId: number,
  patch: Record<string, unknown>,
  database?: Database.Database,
): Record<string, unknown> {
  const db = dbOr(database)
  const existing = getHumanWatchGlobalRules(tenantId, db)
  const merged = normalizeGlobalRulesPatch({ ...existing, ...patch })
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`UPDATE tenants SET human_watch_rules_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(merged),
    now,
    tenantId,
  )
  return merged
}

export function mergeGlobalRulesWithDefaults(
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const defaults = buildDefaultGlobalRules()
  return {
    ...defaults,
    ...stored,
    stuck_signals: normalizeStuckSignals(stored.stuck_signals ?? defaults.stuck_signals),
    confirmation_patterns: normalizeConfirmationPatterns(
      stored.confirmation_patterns ?? defaults.confirmation_patterns,
    ),
    confirmation_patterns_weak: normalizeConfirmationPatterns(
      stored.confirmation_patterns_weak ?? defaults.confirmation_patterns_weak,
    ),
    require_last_message_from_assistant:
      stored.require_last_message_from_assistant !== false,
    grace_after_prompt_seconds:
      typeof stored.grace_after_prompt_seconds === 'number'
        ? stored.grace_after_prompt_seconds
        : (defaults.grace_after_prompt_seconds as number),
    max_interventions_per_hour:
      typeof stored.max_interventions_per_hour === 'number'
        ? stored.max_interventions_per_hour
        : (defaults.max_interventions_per_hour as number),
    max_interventions_window_seconds:
      typeof stored.max_interventions_window_seconds === 'number'
        ? stored.max_interventions_window_seconds
        : (defaults.max_interventions_window_seconds as number),
  }
}

function normalizeStuckSignals(raw: unknown): string[] {
  const defaults = ['pending_tool', 'confirmation_text', 'awaiting_user_response']
  if (!Array.isArray(raw)) return defaults
  const allowed = new Set(defaults)
  const picked = raw.map(String).filter((v) => allowed.has(v))
  return picked.length > 0 ? picked : defaults
}

function normalizeConfirmationPatterns(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return (buildDefaultGlobalRules().confirmation_patterns as string[]) || []
  }
  const lines = raw.map((p) => String(p).trim()).filter(Boolean)
  return lines.length > 0 ? lines : (buildDefaultGlobalRules().confirmation_patterns as string[])
}

function numOrDefault(value: unknown, fallback: number, min: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(min, value)
  }
  const parsed = Number(value)
  if (Number.isFinite(parsed)) return Math.max(min, parsed)
  return fallback
}

export function normalizeGlobalRulesPatch(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const merged = mergeGlobalRulesWithDefaults(raw)
  return {
    enabled: merged.enabled !== false,
    idle_timeout_seconds: numOrDefault(merged.idle_timeout_seconds, 50, 15),
    idle_timeout_with_stuck_seconds: numOrDefault(
      merged.idle_timeout_with_stuck_seconds,
      30,
      10,
    ),
    exclude_if_tool_active_within_seconds: numOrDefault(
      merged.exclude_if_tool_active_within_seconds,
      45,
      0,
    ),
    match_when_stuck_without_timestamps: merged.match_when_stuck_without_timestamps !== false,
    require_last_message_from_assistant: merged.require_last_message_from_assistant !== false,
    stuck_signals: normalizeStuckSignals(merged.stuck_signals),
    confirmation_patterns: normalizeConfirmationPatterns(merged.confirmation_patterns),
    require_combination: merged.require_combination !== false,
    grace_after_prompt_seconds: numOrDefault(merged.grace_after_prompt_seconds, 30, 0),
    max_interventions_per_hour: numOrDefault(merged.max_interventions_per_hour, 60, 1),
    max_interventions_window_seconds: numOrDefault(
      merged.max_interventions_window_seconds,
      24 * 60 * 60,
      60,
    ),
  }
}

/** 编排器评估：仅使用租户全局规则，忽略 binding.rules_override。 */
export function resolveHumanWatchRulesForBinding(
  binding: HumanWatchBindingRow,
  database?: Database.Database,
): HumanWatchGlobalRules {
  const tenantId = binding.tenant_id ?? 1
  return getHumanWatchGlobalRules(tenantId, database) as HumanWatchGlobalRules
}
