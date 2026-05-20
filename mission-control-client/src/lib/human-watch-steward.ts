import path from 'node:path'
import { getDatabase, db_helpers, type Agent } from './db'
import { eventBus } from './event-bus'
import { logger } from './logger'
import type { BindableSessionKind } from './agent-session-binding'
import { isBindableSessionKind } from './agent-session-binding'
import {
  enqueueProvisionAgentDedicatedSession,
  shouldAutoProvisionSessionOnCreate,
} from './local-session-executor'

export const HUMAN_WATCH_AGENT_KIND = 'human_watch'
export const HUMAN_WATCH_AGENT_ROLE = 'human-watch'

export const DEFAULT_STEWARD_SOUL = [
  '你是人工值守（Human Watch）判官智能体。',
  '专用会话仅用于判断 Worker 是否需要人工式跟进提示，不直接执行 Worker 任务。',
  '收到判官请求时，仅输出简短、可代发的跟进话术。',
].join('\n')

function frameworkColumnForKind(kind: BindableSessionKind): string {
  if (kind === 'claude-code') return 'claude'
  if (kind === 'codex-cli') return 'codex'
  return kind
}

function buildDefaultStewardConfig(): Record<string, unknown> {
  const bindingDefaults = {
    enabled: true,
    idle_timeout_seconds: 90,
    stuck_signals: ['pending_tool', 'confirmation_text'],
    confirmation_patterns: [
      'please confirm',
      'waiting for your',
      'which option',
      '请确认',
      '请选择',
      '等待确认',
    ],
    require_combination: true,
    exclude_if_tool_active_within_seconds: 120,
    prompt_template:
      '任务似乎已停滞。请继续下一步，或在受阻时简要说明需要确认的内容。',
    grace_after_prompt_seconds: 30,
    max_interventions_per_hour: 6,
  }
  const { prompt_template: _p, grace_after_prompt_seconds: _g, max_interventions_per_hour: _m, ...rules } =
    bindingDefaults
  return {
    agent_kind: HUMAN_WATCH_AGENT_KIND,
    steward: {
      context: {
        rule_max_messages: 12,
        rule_max_chars: 32000,
        judge_max_messages: 24,
        judge_max_chars: 32000,
      },
      fingerprint_dedupe: true,
      llm_enabled: false,
      llm_sweep_enabled: false,
      llm_sweep_interval_minutes: 30,
      rules,
      binding_defaults: bindingDefaults,
    },
  }
}

export interface CreateHumanWatchStewardInput {
  name: string
  framework: BindableSessionKind
  soul_content?: string | null
  workspace_path?: string | null
  workspaceId?: number
  /** Set by center Bridge RPC when tenant feature is enabled. */
  authorized?: boolean
}

export interface CreateHumanWatchStewardResult {
  agent: Agent & { config: Record<string, unknown> }
  sessionProvisioning: boolean
}

export function createHumanWatchStewardAgent(
  input: CreateHumanWatchStewardInput,
): CreateHumanWatchStewardResult {
  if (!input.authorized) {
    throw new Error('Human watch steward creation is not authorized')
  }

  const framework = String(input.framework || '').trim()
  if (!isBindableSessionKind(framework)) {
    throw new Error('framework must be claude-code or codex-cli')
  }

  const name = String(input.name || '').trim()
  if (!name) {
    throw new Error('name is required')
  }

  const workspaceId = input.workspaceId ?? 1
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const soul = String(input.soul_content || '').trim() || DEFAULT_STEWARD_SOUL
  const resolvedWorkspacePath = input.workspace_path?.trim()
    ? path.resolve(input.workspace_path.trim())
    : null

  const finalConfig = buildDefaultStewardConfig()
  const dbFramework = frameworkColumnForKind(framework)

  const stmt = db.prepare(`
    INSERT INTO agents (
      name, role, session_key, soul_content, status,
      created_at, updated_at, config, workspace_id, framework, parent_id, workspace_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const dbResult = stmt.run(
    name,
    HUMAN_WATCH_AGENT_ROLE,
    null,
    soul,
    'idle',
    now,
    now,
    JSON.stringify(finalConfig),
    workspaceId,
    dbFramework,
    null,
    resolvedWorkspacePath,
  )

  const agentId = dbResult.lastInsertRowid as number

  db_helpers.logActivity(
    'agent_created',
    'agent',
    agentId,
    'bridge',
    `Created human-watch steward: ${name} (${framework})`,
    { name, role: HUMAN_WATCH_AGENT_ROLE, framework, agent_kind: HUMAN_WATCH_AGENT_KIND },
    workspaceId,
  )

  const createdAgent = db
    .prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?')
    .get(agentId, workspaceId) as Agent

  const parsedAgent = {
    ...createdAgent,
    config: JSON.parse(createdAgent.config || '{}') as Record<string, unknown>,
  }

  eventBus.broadcast('agent.created', parsedAgent)

  let sessionProvisioning = false
  if (shouldAutoProvisionSessionOnCreate(parsedAgent)) {
    sessionProvisioning = true
    enqueueProvisionAgentDedicatedSession({
      id: agentId,
      name: parsedAgent.name,
      framework: parsedAgent.framework,
      workspace_path: parsedAgent.workspace_path,
      config: parsedAgent.config,
      session_key: parsedAgent.session_key,
    })
  }

  logger.info(
    { agentId, framework, sessionProvisioning },
    '[HumanWatch] Steward agent created on edge',
  )

  return { agent: parsedAgent, sessionProvisioning }
}
