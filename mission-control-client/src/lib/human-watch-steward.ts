import path from 'node:path'
import { getDatabase, db_helpers, type Agent } from './db'
import { eventBus } from './event-bus'
import { logger } from './logger'
import type { BindableSessionKind } from './agent-session-binding'
import { isBindableSessionKind } from './agent-session-binding'
import {
  enqueueProvisionAgentDedicatedSession,
  releaseAgentExecutionQueues,
  shouldAutoProvisionSessionOnCreate,
} from './local-session-executor'

export const HUMAN_WATCH_AGENT_KIND = 'human_watch'
export const HUMAN_WATCH_AGENT_ROLE = 'human-watch'

export const DEFAULT_STEWARD_SOUL = [
  '你是人工值守（Human Watch）判官智能体，仅通过大模型介入。',
  '收到 Worker 会话摘要时，先理解上下文，再像人一样判断应如何回复（确认、选项或明确指令）。',
  '只输出一条可直接发给 Worker 的用户消息，不要解释、不要前缀；不直接执行 Worker 任务。',
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
    stuck_signals: ['pending_tool', 'confirmation_text', 'awaiting_user_response'],
    confirmation_patterns: [
      'please confirm',
      'waiting for your',
      'which option',
      'please tell me',
      'let me know',
      '请确认',
      '请选择',
      '等待确认',
      '请告诉我',
      '你希望',
      '你想',
      '哪个',
      '哪一',
      '还是',
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
      llm_enabled: true,
      llm_sweep_enabled: false,
      llm_sweep_interval_minutes: 30,
      permission_judge_prompt_template: [
        '你是人工值守审批判官。',
        '请根据权限请求内容判断应该 approve、deny，还是 ask_human。',
        '只输出一行 JSON，不要解释，不要 markdown。',
        '格式必须是：{"decision":"approve|deny|ask_human","option_id":"...", "reason":"..."}',
        '危险操作、删除、卸载、生产变更、提权、密钥操作，一律优先 ask_human。',
      ].join('\n'),
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

export type AgentWithParsedConfig = Omit<Agent, 'config'> & { config: Record<string, unknown> }

export interface CreateHumanWatchStewardResult {
  agent: AgentWithParsedConfig
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

  const parsedAgent: AgentWithParsedConfig = {
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

export interface UpdateHumanWatchStewardInput {
  id: number
  name?: string | null
  soul_content?: string | null
  config_patch?: Record<string, unknown> | null
  workspaceId?: number
}

export function updateHumanWatchStewardAgent(
  input: UpdateHumanWatchStewardInput,
): AgentWithParsedConfig {
  const workspaceId = input.workspaceId ?? 1
  const db = getDatabase()
  const row = db
    .prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?')
    .get(input.id, workspaceId) as Agent | undefined

  if (!row) {
    throw new Error('Agent not found')
  }

  const existingConfig = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {}
  if (
    String(row.role || '').trim() !== HUMAN_WATCH_AGENT_ROLE &&
    String(existingConfig.agent_kind || '').trim() !== HUMAN_WATCH_AGENT_KIND
  ) {
    throw new Error('Agent is not a human-watch steward')
  }

  const now = Math.floor(Date.now() / 1000)
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [now]

  if (input.name != null && String(input.name).trim()) {
    fields.push('name = ?')
    values.push(String(input.name).trim())
  }

  if (input.soul_content != null) {
    fields.push('soul_content = ?')
    values.push(String(input.soul_content).trim() || DEFAULT_STEWARD_SOUL)
  }

  if (input.config_patch && typeof input.config_patch === 'object') {
    const merged = { ...existingConfig, ...input.config_patch }
    const steward =
      merged.steward && typeof merged.steward === 'object' && !Array.isArray(merged.steward)
        ? (merged.steward as Record<string, unknown>)
        : {}
    merged.steward = { ...steward, llm_enabled: true }
    fields.push('config = ?')
    values.push(JSON.stringify(merged))
  }

  values.push(input.id, workspaceId)
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ? AND workspace_id = ?`).run(
    ...values,
  )

  const updated = db
    .prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?')
    .get(input.id, workspaceId) as Agent

  const parsed: AgentWithParsedConfig = {
    ...updated,
    config: JSON.parse(updated.config || '{}') as Record<string, unknown>,
  }

  eventBus.broadcast('agent.updated', parsed)
  logger.info({ agentId: input.id }, '[HumanWatch] Steward agent updated on edge')

  return parsed
}

export function deleteHumanWatchStewardAgent(
  agentId: number,
  workspaceId = 1,
): { deleted: string; id: number } {
  const db = getDatabase()
  const row = db
    .prepare('SELECT * FROM agents WHERE id = ? AND workspace_id = ?')
    .get(agentId, workspaceId) as Agent | undefined

  if (!row) {
    throw new Error('Agent not found')
  }

  const config = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {}
  if (
    String(row.role || '').trim() !== HUMAN_WATCH_AGENT_ROLE &&
    String(config.agent_kind || '').trim() !== HUMAN_WATCH_AGENT_KIND
  ) {
    throw new Error('Agent is not a human-watch steward')
  }

  releaseAgentExecutionQueues({
    id: row.id,
    name: row.name,
    framework: row.framework,
    session_key: row.session_key,
    config: row.config,
  })

  db.prepare('DELETE FROM agents WHERE id = ? AND workspace_id = ?').run(agentId, workspaceId)

  db_helpers.logActivity(
    'agent_deleted',
    'agent',
    agentId,
    'bridge',
    `Deleted human-watch steward: ${row.name}`,
    { name: row.name, role: row.role },
    workspaceId,
  )

  eventBus.broadcast('agent.deleted', { id: agentId, name: row.name })
  logger.info({ agentId, name: row.name }, '[HumanWatch] Steward agent deleted on edge')

  return { deleted: row.name, id: agentId }
}
