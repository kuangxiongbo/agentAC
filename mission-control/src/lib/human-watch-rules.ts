import { createHash } from 'node:crypto'
import type { HumanWatchRulesHit } from './human-watch-types'

export interface HumanWatchTranscriptLine {
  role: string
  content: string
  createdAt?: number
}

export interface HumanWatchRuleConfig {
  enabled?: boolean
  /** 通用空闲阈值（秒）；无 L2/L3 信号时使用 */
  idle_timeout_seconds?: number
  /** 已检测到确认/工具受阻时使用的更短空闲阈值 */
  idle_timeout_with_stuck_seconds?: number
  stuck_signals?: Array<'pending_tool' | 'confirmation_text' | 'awaiting_user_response'>
  /** 强确认话术（最近 2 条 assistant 内匹配） */
  confirmation_patterns?: string[]
  /** 弱话术（仅最后一条 assistant，降低误触） */
  confirmation_patterns_weak?: string[]
  require_combination?: boolean
  /** 要求 transcript 最后一条为 assistant（用户尚未回复） */
  require_last_message_from_assistant?: boolean
  exclude_if_tool_active_within_seconds?: number
  /** 无时间戳时：强信号或 pending_tool 可视为已空闲 */
  match_when_stuck_without_timestamps?: boolean
}

export interface HumanWatchRuleEvaluation {
  matched: boolean
  rulesHit: HumanWatchRulesHit
  fingerprint: string
  reason?: string
}

/** 高置信：确认、只读、无法执行、等待用户 */
const DEFAULT_STRONG_CONFIRMATION_PATTERNS = [
  'please confirm',
  'waiting for your',
  'which option',
  'waiting for you',
  '请确认',
  '请选择',
  '等待确认',
  '需要你确认',
  '你确认',
  '确认后',
  '请回复',
  '回答后说',
  '回复后说',
  '是否继续',
  '要不要',
  '只读',
  'read-only',
  'read only',
  '不能创建',
  '无法创建',
  '不能直接',
  'cannot create',
  'permission denied',
  '受阻',
  'blocked',
  'stalled',
]

/** 弱信号：仅匹配最后一条 assistant，避免技术长文误触 */
const DEFAULT_WEAK_CONFIRMATION_PATTERNS = ['继续吗', '请告诉我', '下一步怎么做']

const DEFAULT_AWAITING_USER_RESPONSE_PATTERNS = [
  '?',
  '？',
  'what do you',
  'which',
  'please tell me',
  'let me know',
  'tell me',
  '请选择',
  '请告诉我',
  '你希望',
  '你想',
  '你要',
  '需要我',
  '是否',
  '哪一',
  '哪个',
  '还是',
  '可以吗',
  '要不要',
]

export const DEFAULT_HUMAN_WATCH_RULE_CONFIG: HumanWatchRuleConfig = {
  enabled: true,
  idle_timeout_seconds: 50,
  idle_timeout_with_stuck_seconds: 30,
  stuck_signals: ['pending_tool', 'confirmation_text', 'awaiting_user_response'],
  confirmation_patterns: DEFAULT_STRONG_CONFIRMATION_PATTERNS,
  confirmation_patterns_weak: DEFAULT_WEAK_CONFIRMATION_PATTERNS,
  require_combination: true,
  require_last_message_from_assistant: true,
  exclude_if_tool_active_within_seconds: 45,
  match_when_stuck_without_timestamps: true,
}

function normalizeContent(line: HumanWatchTranscriptLine): string {
  return String(line.content || '').trim().toLowerCase()
}

function normalizeRole(role: string): string {
  return String(role || '').trim().toLowerCase()
}

function lastNonSystemMessage(
  lines: HumanWatchTranscriptLine[],
): HumanWatchTranscriptLine | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const role = normalizeRole(lines[i]!.role)
    if (role === 'assistant' || role === 'user') return lines[i]!
  }
  return null
}

function hasPendingToolSignal(lines: HumanWatchTranscriptLine[]): boolean {
  const tail = lines.slice(-8)
  return tail.some((line) => {
    const role = normalizeRole(line.role)
    const content = normalizeContent(line)
    return role === 'tool' || content.includes('tool_call') || content.includes('pending_tool')
  })
}

function lineMatchesPatterns(content: string, patterns: string[]): boolean {
  return patterns.some((pattern) => content.includes(pattern.toLowerCase()))
}

export function detectConfirmationSignals(
  lines: HumanWatchTranscriptLine[],
  config: Pick<
    HumanWatchRuleConfig,
    'confirmation_patterns' | 'confirmation_patterns_weak' | 'require_last_message_from_assistant'
  > = {},
): { strong: boolean; weak: boolean; strongOnly: boolean } {
  const requireLastAssistant = config.require_last_message_from_assistant !== false
  const strongPatterns = config.confirmation_patterns?.length
    ? config.confirmation_patterns
    : DEFAULT_STRONG_CONFIRMATION_PATTERNS
  const weakPatterns = config.confirmation_patterns_weak?.length
    ? config.confirmation_patterns_weak
    : DEFAULT_WEAK_CONFIRMATION_PATTERNS

  const assistantLines = lines.filter((line) => normalizeRole(line.role) === 'assistant')
  if (assistantLines.length === 0) {
    return { strong: false, weak: false, strongOnly: false }
  }

  if (requireLastAssistant) {
    const last = lastNonSystemMessage(lines)
    if (!last || normalizeRole(last.role) !== 'assistant') {
      return { strong: false, weak: false, strongOnly: false }
    }
  }

  const recentStrong = assistantLines.slice(-2)
  const strong = recentStrong.some((line) =>
    lineMatchesPatterns(normalizeContent(line), strongPatterns),
  )

  const lastAssistant = assistantLines[assistantLines.length - 1]!
  const weak = lineMatchesPatterns(normalizeContent(lastAssistant), weakPatterns)

  return { strong, weak, strongOnly: strong && !weak }
}

function hasConfirmationText(
  lines: HumanWatchTranscriptLine[],
  config: HumanWatchRuleConfig,
): boolean {
  const { strong, weak } = detectConfirmationSignals(lines, config)
  return strong || weak
}

function lastAssistantContent(lines: HumanWatchTranscriptLine[]): string {
  const last = lastNonSystemMessage(lines)
  if (!last || normalizeRole(last.role) !== 'assistant') return ''
  return normalizeContent(last)
}

function hasAwaitingUserResponseSignal(lines: HumanWatchTranscriptLine[]): boolean {
  const content = lastAssistantContent(lines)
  if (!content) return false
  return DEFAULT_AWAITING_USER_RESPONSE_PATTERNS.some((pattern) =>
    content.includes(pattern.toLowerCase()),
  )
}

/** Last message activity epoch seconds; 0 if transcript lines lack timestamps. */
function lastActivityAt(lines: HumanWatchTranscriptLine[]): number {
  let latest = 0
  for (const line of lines) {
    if (line.createdAt && line.createdAt > latest) latest = line.createdAt
  }
  return latest
}

function recentToolActivity(
  lines: HumanWatchTranscriptLine[],
  nowSec: number,
  withinSeconds: number,
): boolean {
  const cutoff = nowSec - withinSeconds
  return lines.some((line) => {
    const role = normalizeRole(line.role)
    if (role !== 'tool') return false
    return (line.createdAt ?? nowSec) >= cutoff
  })
}

export function buildHumanWatchFingerprint(rulesHit: HumanWatchRulesHit): string {
  const payload = JSON.stringify(rulesHit)
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 24)
}

function contentFingerprint(content: string): string | undefined {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
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

  const baseIdleTimeout =
    config.idle_timeout_seconds ?? DEFAULT_HUMAN_WATCH_RULE_CONFIG.idle_timeout_seconds!
  const stuckIdleTimeout =
    config.idle_timeout_with_stuck_seconds ??
    DEFAULT_HUMAN_WATCH_RULE_CONFIG.idle_timeout_with_stuck_seconds ??
    baseIdleTimeout
  const stuckSignals = config.stuck_signals ?? DEFAULT_HUMAN_WATCH_RULE_CONFIG.stuck_signals!
  const requireCombination = config.require_combination !== false
  const toolWindow = config.exclude_if_tool_active_within_seconds
    ?? DEFAULT_HUMAN_WATCH_RULE_CONFIG.exclude_if_tool_active_within_seconds!
  const matchWithoutTimestamps = config.match_when_stuck_without_timestamps !== false

  if (recentToolActivity(lines, nowSec, toolWindow)) {
    return {
      matched: false,
      rulesHit,
      fingerprint: buildHumanWatchFingerprint(rulesHit),
      reason: 'recent_tool_activity',
    }
  }

  const last = lastNonSystemMessage(lines)
  if (config.require_last_message_from_assistant !== false) {
    if (!last || normalizeRole(last.role) !== 'assistant') {
      return {
        matched: false,
        rulesHit,
        fingerprint: buildHumanWatchFingerprint(rulesHit),
        reason: 'awaiting_user_reply',
      }
    }
  }

  if (stuckSignals.includes('pending_tool') && hasPendingToolSignal(lines)) {
    rulesHit.pending_tool = true
  }

  const confirmSignals = detectConfirmationSignals(lines, config)
  if (stuckSignals.includes('confirmation_text') && (confirmSignals.strong || confirmSignals.weak)) {
    rulesHit.confirmation_text = true
    if (confirmSignals.strong) rulesHit.confirmation_strong = true
    if (confirmSignals.weak) rulesHit.confirmation_weak = true
    const contentHash = contentFingerprint(lastAssistantContent(lines))
    if (contentHash) rulesHit.confirmation_text_hash = contentHash
  }

  if (stuckSignals.includes('awaiting_user_response') && hasAwaitingUserResponseSignal(lines)) {
    rulesHit.awaiting_user_response = true
    const contentHash = contentFingerprint(lastAssistantContent(lines))
    if (contentHash) rulesHit.awaiting_user_response_hash = contentHash
  }

  const l2or3 = Boolean(rulesHit.pending_tool || rulesHit.confirmation_text || rulesHit.awaiting_user_response)
  const highConfidenceStuck = Boolean(
    rulesHit.pending_tool || confirmSignals.strong || rulesHit.awaiting_user_response,
  )
  const effectiveIdleTimeout = l2or3 ? Math.min(baseIdleTimeout, stuckIdleTimeout) : baseIdleTimeout

  const lastAt = lastActivityAt(lines)
  let idle = false
  if (lastAt > 0) {
    idle = nowSec - lastAt >= effectiveIdleTimeout
  } else if (
    lines.length > 0 &&
    l2or3 &&
    matchWithoutTimestamps &&
    highConfidenceStuck
  ) {
    idle = true
    rulesHit.idle_unknown_timestamps = true
  }
  if (idle) rulesHit.idle_timeout = true

  const matched = requireCombination ? Boolean(rulesHit.idle_timeout && l2or3) : Boolean(rulesHit.idle_timeout || l2or3)

  return {
    matched,
    rulesHit,
    fingerprint: buildHumanWatchFingerprint(rulesHit),
    reason: matched ? undefined : 'no_rule_match',
  }
}
