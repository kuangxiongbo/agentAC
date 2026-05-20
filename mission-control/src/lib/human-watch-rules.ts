import { createHash } from 'node:crypto'
import type { HumanWatchRulesHit } from './human-watch-types'

export interface HumanWatchTranscriptLine {
  role: string
  content: string
  createdAt?: number
}

export interface HumanWatchRuleConfig {
  enabled?: boolean
  idle_timeout_seconds?: number
  stuck_signals?: Array<'pending_tool' | 'confirmation_text'>
  confirmation_patterns?: string[]
  require_combination?: boolean
  exclude_if_tool_active_within_seconds?: number
}

export interface HumanWatchRuleEvaluation {
  matched: boolean
  rulesHit: HumanWatchRulesHit
  fingerprint: string
  reason?: string
}

const DEFAULT_CONFIRMATION_PATTERNS = [
  'please confirm',
  'waiting for your',
  'which option',
  '请确认',
  '请选择',
  '等待确认',
]

export const DEFAULT_HUMAN_WATCH_RULE_CONFIG: HumanWatchRuleConfig = {
  enabled: true,
  idle_timeout_seconds: 90,
  stuck_signals: ['pending_tool', 'confirmation_text'],
  confirmation_patterns: DEFAULT_CONFIRMATION_PATTERNS,
  require_combination: true,
  exclude_if_tool_active_within_seconds: 120,
}

function normalizeContent(line: HumanWatchTranscriptLine): string {
  return String(line.content || '').trim().toLowerCase()
}

function hasPendingToolSignal(lines: HumanWatchTranscriptLine[]): boolean {
  return lines.some((line) => {
    const role = String(line.role || '').toLowerCase()
    const content = normalizeContent(line)
    return role === 'tool' || content.includes('tool_call') || content.includes('pending_tool')
  })
}

function hasConfirmationText(
  lines: HumanWatchTranscriptLine[],
  patterns: string[],
): boolean {
  const assistantLines = lines.filter((line) => String(line.role || '').toLowerCase() === 'assistant')
  if (assistantLines.length === 0) return false
  const last = normalizeContent(assistantLines[assistantLines.length - 1]!)
  return patterns.some((pattern) => last.includes(pattern.toLowerCase()))
}

function lastActivityAt(lines: HumanWatchTranscriptLine[], nowSec: number): number {
  let latest = 0
  for (const line of lines) {
    if (line.createdAt && line.createdAt > latest) latest = line.createdAt
  }
  return latest || nowSec
}

function recentToolActivity(
  lines: HumanWatchTranscriptLine[],
  nowSec: number,
  withinSeconds: number,
): boolean {
  const cutoff = nowSec - withinSeconds
  return lines.some((line) => {
    const role = String(line.role || '').toLowerCase()
    if (role !== 'tool') return false
    return (line.createdAt ?? nowSec) >= cutoff
  })
}

export function buildHumanWatchFingerprint(rulesHit: HumanWatchRulesHit): string {
  const payload = JSON.stringify(rulesHit)
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 24)
}

/** Evaluate L1–L3 shallow rules on a transcript slice. */
export function evaluateHumanWatchRules(
  lines: HumanWatchTranscriptLine[],
  config: HumanWatchRuleConfig = DEFAULT_HUMAN_WATCH_RULE_CONFIG,
  nowSec: number = Math.floor(Date.now() / 1000),
): HumanWatchRuleEvaluation {
  const rulesHit: HumanWatchRulesHit = {}
  if (config.enabled === false) {
    return {
      matched: false,
      rulesHit,
      fingerprint: buildHumanWatchFingerprint(rulesHit),
      reason: 'rules_disabled',
    }
  }

  const idleTimeout = config.idle_timeout_seconds ?? DEFAULT_HUMAN_WATCH_RULE_CONFIG.idle_timeout_seconds!
  const patterns = config.confirmation_patterns?.length
    ? config.confirmation_patterns
    : DEFAULT_CONFIRMATION_PATTERNS
  const stuckSignals = config.stuck_signals ?? DEFAULT_HUMAN_WATCH_RULE_CONFIG.stuck_signals!
  const requireCombination = config.require_combination !== false
  const toolWindow = config.exclude_if_tool_active_within_seconds
    ?? DEFAULT_HUMAN_WATCH_RULE_CONFIG.exclude_if_tool_active_within_seconds!

  if (recentToolActivity(lines, nowSec, toolWindow)) {
    return {
      matched: false,
      rulesHit,
      fingerprint: buildHumanWatchFingerprint(rulesHit),
      reason: 'recent_tool_activity',
    }
  }

  const lastAt = lastActivityAt(lines, nowSec)
  const idle = nowSec - lastAt >= idleTimeout
  if (idle) rulesHit.idle_timeout = true

  if (stuckSignals.includes('pending_tool') && hasPendingToolSignal(lines)) {
    rulesHit.pending_tool = true
  }
  if (stuckSignals.includes('confirmation_text') && hasConfirmationText(lines, patterns)) {
    rulesHit.confirmation_text = true
  }

  const l2or3 = Boolean(rulesHit.pending_tool || rulesHit.confirmation_text)
  const matched = requireCombination ? Boolean(rulesHit.idle_timeout && l2or3) : Boolean(rulesHit.idle_timeout || l2or3)

  return {
    matched,
    rulesHit,
    fingerprint: buildHumanWatchFingerprint(rulesHit),
    reason: matched ? undefined : 'no_rule_match',
  }
}
