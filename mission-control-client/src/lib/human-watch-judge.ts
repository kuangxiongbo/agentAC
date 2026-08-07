import { getDatabase } from './db'
import { logger } from './logger'
import { readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { parse as parseToml } from 'smol-toml'
import {
  executeBoundLocalAgentPrompt,
  getLocalSessionKindForFramework,
  invalidateAgentDedicatedSession,
} from './local-session-executor'
import { isHumanWatchAgent } from './human-watch-helpers'
import { readLocalSessionTranscriptPage } from './session-transcript'

const EMPTY_SESSION_REPLY = 'Session continued, but no text response was returned.'
const STEWARD_JUDGE_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000
const FAST_JUDGE_TIMEOUT_MS = 3_500
const FAST_JUDGE_MODEL = 'gpt-5-mini'

type FastJudgeProvider = { apiKey: string; endpoint: string; model: string }

function fastJudgeEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return `${base}${base.endsWith('/v1') ? '' : '/v1'}/chat/completions`
}

function resolveFastJudgeProvider(): FastJudgeProvider | null {
  const explicitBase = String(process.env.MC_HUMAN_WATCH_FAST_JUDGE_BASE_URL || '').trim()
  const explicitModel = String(process.env.MC_HUMAN_WATCH_FAST_JUDGE_MODEL || '').trim()
  const explicitKey = String(process.env.OPENAI_API_KEY || '').trim()
  if (explicitBase && explicitKey) {
    return {
      apiKey: explicitKey,
      endpoint: fastJudgeEndpoint(explicitBase),
      model: explicitModel || FAST_JUDGE_MODEL,
    }
  }

  try {
    const codexHome = String(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')).trim()
    const parsed = parseToml(readFileSync(path.join(codexHome, 'config.toml'), 'utf8')) as Record<string, unknown>
    const providerName = String(parsed.model_provider || '').trim()
    const providers = parsed.model_providers as Record<string, unknown> | undefined
    const provider = providers?.[providerName] as Record<string, unknown> | undefined
    const baseUrl = String(provider?.base_url || '').trim()
    const envKey = String(provider?.env_key || 'OPENAI_API_KEY').trim()
    const apiKey = String(process.env[envKey] || '').trim()
    const model = explicitModel || FAST_JUDGE_MODEL
    if (!baseUrl || !apiKey || !model) return null
    return { apiKey, endpoint: fastJudgeEndpoint(baseUrl), model }
  } catch (error) {
    logger.debug({ err: error }, '[HumanWatch] Codex provider config unavailable for fast judge')
    return null
  }
}

async function runFastStewardJudge(
  prompt: string,
): Promise<{ reply: string; model: string; inputTokens: number; outputTokens: number } | null> {
  if (process.env.MC_HUMAN_WATCH_FAST_JUDGE === '0') return null
  const provider = resolveFastJudgeProvider()
  if (!provider) return null

  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 300,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(FAST_JUDGE_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`OpenAI HTTP ${response.status}`)
    }
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const reply = String(body.choices?.[0]?.message?.content || '').trim()
    return reply ? {
      reply,
      model: provider.model,
      inputTokens: Number(body.usage?.prompt_tokens || 0),
      outputTokens: Number(body.usage?.completion_tokens || 0),
    } : null
  } catch (error) {
    logger.warn({ err: error, model: provider.model }, '[HumanWatch] Fast judge unavailable; falling back to steward CLI')
    return null
  }
}

export async function runStewardJudgeOnEdge(
  localAgentId: number,
  prompt: string,
  options: { fastPrompt?: string } = {},
): Promise<{ reply: string; sessionId: string }> {
  const db = getDatabase()
  const agent = db
    .prepare(`
      SELECT id, name, role, soul_content, framework, session_key, config, workspace_path, source, parent_id, status
      FROM agents
      WHERE id = ? AND hidden = 0
      LIMIT 1
    `)
    .get(localAgentId) as {
      id: number
      name: string
      role: string
      soul_content: string | null
      framework: string | null
      session_key: string | null
      config: string | null
      workspace_path: string | null
      source: string | null
      parent_id: number | null
      status: string | null
    } | undefined

  if (!agent) {
    throw new Error('Steward agent not found')
  }
  if (!isHumanWatchAgent({ role: agent.role, config: agent.config })) {
    throw new Error('Agent is not a human-watch steward')
  }

  const kind = getLocalSessionKindForFramework(agent.framework)
  if (!kind) {
    throw new Error('Steward framework does not support local judge session')
  }

  const trimmedPrompt = String(prompt || '').trim()
  if (!trimmedPrompt || trimmedPrompt.length > 6000) {
    throw new Error('judge prompt is required (max 6000 chars)')
  }

  const sessionKey = String(agent.session_key || '').trim()
  logger.info({ agentId: agent.id, kind, sessionKey: sessionKey || null }, '[HumanWatch] Running steward judge on edge')

  const fastPrompt = String(options.fastPrompt || trimmedPrompt).trim()
  const fastResult = fastPrompt.length <= 2_000
    ? await runFastStewardJudge(fastPrompt)
    : null
  if (fastResult) {
    if (isStewardJudgeRuntimeError(fastResult.reply)) {
      throw new Error(`Fast judge returned runtime error: ${fastResult.reply.slice(0, 160)}`)
    }
    try {
      db.prepare(`
        INSERT INTO token_usage (
          model, session_id, input_tokens, output_tokens, workspace_id, agent_name
        ) VALUES (?, ?, ?, ?, 1, ?)
      `).run(
        fastResult.model,
        `human-watch-fast:${agent.id}`,
        fastResult.inputTokens,
        fastResult.outputTokens,
        agent.name,
      )
    } catch (error) {
      logger.debug({ err: error, agentId: agent.id }, '[HumanWatch] Failed to record fast judge token usage')
    }
    logger.info({ agentId: agent.id, model: fastResult.model }, '[HumanWatch] Fast judge completed')
    return { reply: fastResult.reply, sessionId: sessionKey }
  }

  const baseline = readLatestAssistantState(kind, sessionKey)
  const result = await executeBoundLocalAgentPrompt(agent, trimmedPrompt, {
    timeoutMs: STEWARD_JUDGE_EXECUTION_TIMEOUT_MS,
  })
  let reply = String(result.reply || '').trim()
  const resultSessionId = String(result.sessionId || sessionKey || '').trim()
  if (!reply || reply === EMPTY_SESSION_REPLY || (baseline.text && reply === baseline.text)) {
    const current = readLatestAssistantState(kind, resultSessionId)
    if (isNewAssistantState(current, baseline) && current.text && current.text !== EMPTY_SESSION_REPLY) {
      reply = current.text
    } else {
      reply = await waitForNewAssistantReply(kind, resultSessionId, baseline)
    }
  }
  if (!reply || reply === EMPTY_SESSION_REPLY) {
    logger.warn(
      { agentId: agent.id, sessionKey: resultSessionId || sessionKey || null },
      '[HumanWatch] Judge session returned empty reply; reprovisioning once',
    )
    invalidateAgentDedicatedSession(agent, 'Judge session returned empty reply')
    const retry = await executeBoundLocalAgentPrompt(
      { ...agent, session_key: null },
      trimmedPrompt,
      { timeoutMs: STEWARD_JUDGE_EXECUTION_TIMEOUT_MS },
    )
    reply = String(retry.reply || '').trim()
    if (!reply || reply === EMPTY_SESSION_REPLY) {
      throw new Error('Judge session returned empty reply after reprovision')
    }
    if (isStewardJudgeRuntimeError(reply)) {
      throw new Error(`Judge session returned runtime error after reprovision: ${reply.slice(0, 160)}`)
    }
    return {
      reply,
      sessionId: String(retry.sessionId || '').trim(),
    }
  }
  if (isStewardJudgeRuntimeError(reply)) {
    throw new Error(`Judge session returned runtime error: ${reply.slice(0, 160)}`)
  }

  return {
    reply,
    sessionId: resultSessionId,
  }
}

function readLatestAssistantState(
  kind: ReturnType<typeof getLocalSessionKindForFramework>,
  sessionKey: string,
): { text: string; count: number; timestampMs: number } {
  if (kind !== 'codex-cli') return { text: '', count: 0, timestampMs: 0 }
  const page = readLocalSessionTranscriptPage('codex-cli', sessionKey, { limit: 12 })
  const assistantMessages = page.messages.filter((message) => message.role === 'assistant')
  const lastAssistant = [...assistantMessages].reverse().find((message) => {
    if (message.role !== 'assistant') return false
    return message.parts.some((part) => part.type === 'text' && part.text.trim())
  })
  if (!lastAssistant) return { text: '', count: assistantMessages.length, timestampMs: 0 }
  return {
    text: lastAssistant.parts
      .map((part) => (part.type === 'text' ? part.text : null))
      .filter(Boolean)
      .join('\n')
      .trim(),
    count: assistantMessages.length,
    timestampMs: parseTranscriptTimestampMs(lastAssistant.timestamp),
  }
}

function parseTranscriptTimestampMs(timestamp: string | undefined): number {
  if (!timestamp) return 0
  const value = new Date(timestamp).getTime()
  return Number.isFinite(value) ? value : 0
}

function isStewardJudgeRuntimeError(reply: string): boolean {
  const text = String(reply || '').trim()
  if (!text) return false
  return [
    /^missing environment variable:/i,
    /^error:\s*missing environment variable:/i,
    /^api error:/i,
    /^command failed\s*\(/i,
    /authentication failed/i,
    /no api key/i,
  ].some((pattern) => pattern.test(text))
}

function isNewAssistantState(
  current: { count: number; timestampMs: number },
  baseline: { count: number; timestampMs: number },
): boolean {
  return current.count > baseline.count || (current.timestampMs > 0 && current.timestampMs > baseline.timestampMs)
}

async function waitForNewAssistantReply(
  kind: ReturnType<typeof getLocalSessionKindForFramework>,
  sessionKey: string,
  baseline: { text: string; count: number; timestampMs: number },
): Promise<string> {
  if (kind !== 'codex-cli') return ''
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const next = readLatestAssistantState(kind, sessionKey)
    if (isNewAssistantState(next, baseline) && next.text && next.text !== EMPTY_SESSION_REPLY) {
      return next.text
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return ''
}
