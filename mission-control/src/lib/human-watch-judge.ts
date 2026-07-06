import type { TranscriptMessage } from './session-transcript'
import { transcriptMessagesToHumanWatchLines } from './human-watch-transcript'
import type { HumanWatchTranscriptLine } from './human-watch-rules'

export interface StewardContextConfig {
  summary_max_messages?: number
  summary_max_chars?: number
  tool_result_max_chars?: number
  include_thinking?: boolean
}

export interface StewardRuntimeConfig {
  llm_enabled?: boolean
  llm_sweep_enabled?: boolean
  llm_sweep_interval_minutes?: number
  prompt_template?: string
  judge_prompt_template?: string
  permission_judge_prompt_template?: string
  context?: StewardContextConfig
}

const DEFAULT_JUDGE_TEMPLATE = `你是人工值守判官。阅读下方 Worker 结构化上下文与会话摘录，判断 Worker 在等什么确认、卡在哪一步、下一步最合理的继续指令是什么。
只输出一条可直接发给 Worker 的用户消息。要求：
1. 只输出给 Worker 的最终消息，不要解释、不要分析、不要前缀。
2. 如果 Worker 明确在等待确认/选择，直接给出明确选择。
3. 如果 Worker 需要下一步执行指令，直接给出简洁可执行指令。
4. 如果信息不足，先要求 Worker 汇报最关键缺口。

Worker 上下文：
{context}

Worker 会话摘录：
{summary}`

const MAX_STEWARD_JUDGE_PROMPT_CHARS = 5900
const MIN_STEWARD_SECTION_CHARS = 800

function truncateMiddle(text: string, maxChars: number): string {
  const value = String(text || '').trim()
  if (value.length <= maxChars) return value
  if (maxChars <= 20) return value.slice(0, maxChars)
  const marker = '\n...[truncated]...\n'
  const keep = Math.max(1, maxChars - marker.length)
  const head = Math.ceil(keep * 0.35)
  const tail = Math.floor(keep * 0.65)
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`
}

function isHumanWatchStewardAgentRecord(agent: Record<string, unknown>): boolean {
  const role = String(agent.role || '').trim()
  if (role === 'human-watch') return true
  let config: Record<string, unknown> = {}
  const raw = agent.config
  if (typeof raw === 'string') {
    try {
      config = JSON.parse(raw) as Record<string, unknown>
    } catch {
      config = {}
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    config = raw as Record<string, unknown>
  }
  return String(config.agent_kind || '').trim() === 'human_watch'
}

/** 值守智能体仅通过大模型判官介入；规则只负责触发判官。 */
export function stewardRequiresLlmJudge(agent: Record<string, unknown> | null | undefined): boolean {
  if (!agent || typeof agent !== 'object') return false
  return isHumanWatchStewardAgentRecord(agent)
}

export function parseStewardConfigFromAgent(agent: Record<string, unknown> | null | undefined): StewardRuntimeConfig {
  if (!agent || typeof agent !== 'object') return {}
  let config: Record<string, unknown> = {}
  const raw = agent.config
  if (typeof raw === 'string') {
    try {
      config = JSON.parse(raw) as Record<string, unknown>
    } catch {
      config = {}
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    config = raw as Record<string, unknown>
  }
  const steward =
    config.steward && typeof config.steward === 'object' && !Array.isArray(config.steward)
      ? (config.steward as Record<string, unknown>)
      : {}
  const context =
    steward.context && typeof steward.context === 'object' && !Array.isArray(steward.context)
      ? (steward.context as StewardContextConfig)
      : {}

  const forceLlm = isHumanWatchStewardAgentRecord(agent)

  return {
    llm_enabled: forceLlm || steward.llm_enabled === true,
    llm_sweep_enabled: steward.llm_sweep_enabled === true,
    llm_sweep_interval_minutes:
      typeof steward.llm_sweep_interval_minutes === 'number'
        ? steward.llm_sweep_interval_minutes
        : 30,
    prompt_template:
      typeof steward.prompt_template === 'string' ? steward.prompt_template : undefined,
    judge_prompt_template:
      typeof steward.judge_prompt_template === 'string' ? steward.judge_prompt_template : undefined,
    permission_judge_prompt_template:
      typeof steward.permission_judge_prompt_template === 'string'
        ? steward.permission_judge_prompt_template
        : undefined,
    context,
  }
}

function flattenLine(line: HumanWatchTranscriptLine): string {
  const role = String(line.role || 'unknown').toUpperCase()
  const text = String(line.content || '').trim()
  if (!text) return ''
  return `${role}: ${text}`
}

function extractLastRoleText(
  lines: HumanWatchTranscriptLine[],
  role: HumanWatchTranscriptLine['role'],
): string {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]?.role !== role) continue
    const text = String(lines[i]?.content || '').trim()
    if (text) return text
  }
  return ''
}

function inferWorkerNeed(lines: HumanWatchTranscriptLine[]): string {
  const lastAssistant = extractLastRoleText(lines, 'assistant')
  if (!lastAssistant) return '未识别到明确卡点，请结合会话摘录判断'
  const normalized = lastAssistant.toLowerCase()
  if (
    normalized.includes('confirm') ||
    normalized.includes('确认') ||
    normalized.includes('继续吗') ||
    normalized.includes('是否继续')
  ) {
    return 'Worker 正在等待确认或选择'
  }
  if (
    normalized.includes('permission') ||
    normalized.includes('approve') ||
    normalized.includes('授权') ||
    normalized.includes('提权')
  ) {
    return 'Worker 正在等待权限或审批决策'
  }
  if (
    normalized.includes('blocked') ||
    normalized.includes('受阻') ||
    normalized.includes('卡住') ||
    normalized.includes('无法继续')
  ) {
    return 'Worker 当前受阻，需要人工提供下一步决策'
  }
  return '请根据最近一轮 assistant 输出判断其下一步需要的确认或指令'
}

function buildWorkerContextBlock(
  lines: HumanWatchTranscriptLine[],
  context: StewardContextConfig = {},
): string {
  const maxChars = Math.min(Math.max(context.summary_max_chars ?? 32000, 500), 64000)
  const recentUser = extractLastRoleText(lines, 'user') || '无'
  const recentAssistant = extractLastRoleText(lines, 'assistant') || '无'
  const recentTool = extractLastRoleText(lines, 'tool') || '无'
  const inferredNeed = inferWorkerNeed(lines)
  const entries = [
    ['最近用户意图', recentUser],
    ['最近 Assistant 输出', recentAssistant],
    ['最近工具结果', recentTool],
    ['推断待解决问题', inferredNeed],
    ['值守目标', '帮助 Worker 持续推进，不要重复摘要，不要输出解释'],
  ]
  const block = entries
    .map(([label, value]) => `- ${label}: ${String(value).slice(0, Math.min(maxChars, 4000))}`)
    .join('\n')
  return block.trim()
}

export function buildWorkerSummaryForJudge(
  messages: TranscriptMessage[],
  context: StewardContextConfig = {},
): string {
  const maxMessages = Math.min(Math.max(context.summary_max_messages ?? 24, 1), 80)
  const maxChars = Math.min(Math.max(context.summary_max_chars ?? 32000, 500), 64000)
  const toolMax = Math.min(Math.max(context.tool_result_max_chars ?? 2000, 200), 8000)

  const lines = transcriptMessagesToHumanWatchLines(messages)
  const tail = lines.slice(-maxMessages)
  const chunks: string[] = []

  for (const line of tail) {
    let text = String(line.content || '')
    if (!context.include_thinking && text.includes('[tool_use')) {
      // keep tool markers but truncate long tool bodies
    }
    if (text.length > toolMax) {
      text = `${text.slice(0, toolMax)}…`
    }
    const row = flattenLine({ ...line, content: text })
    if (!row) continue
    if (chunks.join('\n').length + row.length > maxChars) break
    chunks.push(row)
  }

  return chunks.join('\n').trim() || '(empty transcript)'
}

export function buildWorkerJudgeContext(
  messages: TranscriptMessage[],
  context: StewardContextConfig = {},
): string {
  const lines = transcriptMessagesToHumanWatchLines(messages)
  return buildWorkerContextBlock(lines, context)
}

export function buildStewardJudgePrompt(
  summary: string,
  workerContext: string,
  stewardConfig: StewardRuntimeConfig,
): string {
  const template = stewardConfig.judge_prompt_template?.trim() || DEFAULT_JUDGE_TEMPLATE
  const render = (nextContext: string, nextSummary: string) =>
    template.replace(/\{summary\}/g, nextSummary).replace(/\{context\}/g, nextContext)

  const fullPrompt = render(workerContext, summary)
  if (fullPrompt.length <= MAX_STEWARD_JUDGE_PROMPT_CHARS) return fullPrompt

  const fixedTemplateChars = render('', '').length
  const available = Math.max(
    MIN_STEWARD_SECTION_CHARS * 2,
    MAX_STEWARD_JUDGE_PROMPT_CHARS - fixedTemplateChars,
  )
  const contextBudget = Math.max(
    MIN_STEWARD_SECTION_CHARS,
    Math.floor(Math.min(workerContext.length || MIN_STEWARD_SECTION_CHARS, available * 0.35)),
  )
  const summaryBudget = Math.max(MIN_STEWARD_SECTION_CHARS, available - contextBudget)
  const boundedPrompt = render(
    truncateMiddle(workerContext, contextBudget),
    truncateMiddle(summary, summaryBudget),
  )

  return boundedPrompt.length <= MAX_STEWARD_JUDGE_PROMPT_CHARS
    ? boundedPrompt
    : truncateMiddle(boundedPrompt, MAX_STEWARD_JUDGE_PROMPT_CHARS)
}
