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
  context?: StewardContextConfig
}

const DEFAULT_JUDGE_TEMPLATE = `你是人工值守判官。阅读下方 Worker 会话摘要，判断 Worker 在等什么确认或卡在哪。
只输出一条可直接发给 Worker 的用户消息（明确选项、确认或指令），不要解释、不要前缀。

Worker 会话摘要：
{summary}`

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
    context,
  }
}

function flattenLine(line: HumanWatchTranscriptLine): string {
  const role = String(line.role || 'unknown').toUpperCase()
  const text = String(line.content || '').trim()
  if (!text) return ''
  return `${role}: ${text}`
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

export function buildStewardJudgePrompt(
  summary: string,
  stewardConfig: StewardRuntimeConfig,
): string {
  const template = stewardConfig.judge_prompt_template?.trim() || DEFAULT_JUDGE_TEMPLATE
  return template.replace(/\{summary\}/g, summary)
}
