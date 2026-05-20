import { getDatabase } from './db'
import { logger } from './logger'
import {
  executeLocalSessionPrompt,
  getLocalSessionKindForFramework,
} from './local-session-executor'
import { isHumanWatchAgent } from './human-watch-helpers'

export async function runStewardJudgeOnEdge(
  localAgentId: number,
  prompt: string,
): Promise<{ reply: string; sessionId: string }> {
  const db = getDatabase()
  const agent = db
    .prepare(`SELECT id, name, role, framework, session_key, config FROM agents WHERE id = ? AND hidden = 0 LIMIT 1`)
    .get(localAgentId) as {
      id: number
      name: string
      role: string
      framework: string | null
      session_key: string | null
      config: string | null
    } | undefined

  if (!agent) {
    throw new Error('Steward agent not found')
  }
  if (!isHumanWatchAgent({ role: agent.role, config: agent.config })) {
    throw new Error('Agent is not a human-watch steward')
  }

  const sessionKey = String(agent.session_key || '').trim()
  if (!sessionKey) {
    throw new Error('Steward has no dedicated judge session yet; wait for provisioning')
  }

  const kind = getLocalSessionKindForFramework(agent.framework)
  if (!kind) {
    throw new Error('Steward framework does not support local judge session')
  }

  const trimmedPrompt = String(prompt || '').trim()
  if (!trimmedPrompt || trimmedPrompt.length > 6000) {
    throw new Error('judge prompt is required (max 6000 chars)')
  }

  logger.info({ agentId: agent.id, kind, sessionKey }, '[HumanWatch] Running steward judge on edge')

  const result = await executeLocalSessionPrompt(kind, sessionKey, trimmedPrompt)
  const reply = String(result.reply || '').trim()
  if (!reply) {
    throw new Error('Judge session returned empty reply')
  }

  return {
    reply,
    sessionId: result.sessionId || sessionKey,
  }
}
