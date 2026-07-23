import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  findClaudeSessionFilePath,
  findClaudeSessionProjectPath,
  invalidateClaudeSessionSync,
  readLastClaudeSessionReply,
  syncClaudeSessions,
} from './claude-sessions'
import { readLocalSessionTranscriptPage } from './session-transcript'
import { invalidateMergedSessionsCache } from './sessions-list-cache'
import { invalidateCodexSessionScan, scanCodexSessions } from './codex-sessions'
import { runCommand } from './command'
import { config } from './config'
import { getDatabase } from './db'
import { logger } from './logger'
import { eventBus } from './event-bus'
import { notifySessionTranscriptUpdated } from './session-realtime'
import { sessionSourceFromKind } from './session-realtime-events'
import {
  buildLocalCliOperatingRules,
  resolveLocalCliPermissionMode,
  withLocalCliPermissionArgs,
  type LocalCliPermissionMode,
} from './local-cli-permission'
import { withCodexMcpConfigArgs } from './codex-mcp-injection'
import { withClaudeMcpConfigArgs } from './claude-mcp-injection'
import {
  resolveCliDispatchCwd,
  resolveCliDispatchSandboxOptions,
} from './dispatch-sandbox'

export type LocalSessionKind = 'claude-code' | 'codex-cli' | 'cursor' | 'opencode' | 'hermes'

export const LOCAL_SESSION_KINDS = [
  'claude-code',
  'codex-cli',
  'cursor',
  'opencode',
  'hermes',
] as const

type LocalAgentSessionMode = 'dedicated' | 'manual' | 'shared'
type LocalAgentSessionStrategy = 'persistent' | 'fork_on_task'
type LocalAgentSessionState = 'pending' | 'provisioning' | 'ready' | 'broken' | 'unsupported'

export interface LocalSessionExecutionResult {
  sessionId: string | null
  reply: string
}

const EMPTY_SESSION_REPLY = 'Session continued, but no text response was returned.'

export interface LocalPromptEnqueueResult {
  accepted: true
  sessionKey: string | null
  kind: LocalSessionKind
}

interface LocalSessionExecutionOptions {
  workingDirectory?: string | null
  permissionMode?: LocalCliPermissionMode | null
  agent?: LocalRuntimeAgentRef | null
  managedByPlatform?: boolean
  workerSessionId?: string | null
  sessionKind?: LocalSessionKind | null
  timeoutMs?: number | null
  dispatchAllowedTools?: unknown
  dispatchMaxBudgetUsd?: unknown
  dispatchCwd?: unknown
}

export interface LocalRuntimeAgentRef {
  id?: number | null
  name?: string | null
  role?: string | null
  soul_content?: string | null
  framework?: string | null
  session_key?: string | null
  config?: unknown
  workspace_path?: string | null
  source?: string | null
  parent_id?: number | null
  status?: string | null
}

interface LocalAgentPromptExecutionOptions extends LocalSessionExecutionOptions {
  overrideSessionKey?: string | null
}

interface LocalRuntimeExecutorAdapter {
  kind: LocalSessionKind
  frameworks: string[]
  execute: (
    sessionId: string,
    prompt: string,
    options: LocalSessionExecutionOptions,
  ) => Promise<LocalSessionExecutionResult>
  start?: (
    prompt: string,
    options: LocalSessionExecutionOptions & { agentName?: string | null; excludeAgentId?: number | null },
  ) => Promise<LocalSessionExecutionResult>
}

interface ParsedLocalAgentSessionConfig {
  rawConfig: Record<string, unknown>
  mode: LocalAgentSessionMode
  strategy: LocalAgentSessionStrategy
  state: LocalAgentSessionState
  primarySessionKey: string | null
  lastSessionError: string | null
  runtimeManaged: boolean
  roleHash: string | null
  sessionBootstrapHash: string | null
  sessionBootstrapState: LocalAgentSessionState
  sessionBootstrapError: string | null
}

const EXECUTION_TIMEOUT_MS = 180_000
const PROBE_TIMEOUT_MS = 3_000
const RUNTIME_PROBE_TTL_MS = 30_000

let opencodeRunSupportCache: { checkedAt: number; supported: boolean } | null = null
const agentSessionExecutionChains = new Map<string, Promise<LocalSessionExecutionResult>>()

export function isLocalSessionKind(value: unknown): value is LocalSessionKind {
  return typeof value === 'string' && (LOCAL_SESSION_KINDS as readonly string[]).includes(value)
}

function sanitizePrompt(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function ensureValidSessionId(sessionId: string) {
  if (!sessionId || !/^[a-zA-Z0-9._:-]+$/.test(sessionId)) {
    throw new Error('Invalid session id')
  }
}

function resolveWorkingDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined

  const resolved = path.resolve(trimmed)
  try {
    if (!existsSync(resolved)) return undefined
    if (!statSync(resolved).isDirectory()) return undefined
    return resolved
  } catch {
    return undefined
  }
}

function parseConfigRecord(config: unknown): Record<string, unknown> | null {
  if (!config) return null
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }
  if (typeof config === 'object' && !Array.isArray(config)) {
    return config as Record<string, unknown>
  }
  return null
}

function asSessionMode(value: unknown): LocalAgentSessionMode | null {
  const normalized = asTrimmedString(value)?.toLowerCase()
  if (normalized === 'dedicated' || normalized === 'manual' || normalized === 'shared') return normalized
  return null
}

function asSessionStrategy(value: unknown): LocalAgentSessionStrategy | null {
  const normalized = asTrimmedString(value)?.toLowerCase()
  if (normalized === 'persistent' || normalized === 'fork_on_task') return normalized
  return null
}

function asSessionState(value: unknown): LocalAgentSessionState | null {
  const normalized = asTrimmedString(value)?.toLowerCase()
  if (
    normalized === 'pending' ||
    normalized === 'provisioning' ||
    normalized === 'ready' ||
    normalized === 'broken' ||
    normalized === 'unsupported'
  ) {
    return normalized
  }
  return null
}

function getParsedLocalAgentSessionConfig(agent: LocalRuntimeAgentRef | null | undefined): ParsedLocalAgentSessionConfig {
  const rawConfig = parseConfigRecord(agent?.config) || {}
  return {
    rawConfig,
    mode: asSessionMode(rawConfig.session_mode) || 'dedicated',
    strategy: asSessionStrategy(rawConfig.session_strategy) || 'persistent',
    state: asSessionState(rawConfig.session_state) || (agent?.session_key ? 'ready' : 'pending'),
    primarySessionKey: asTrimmedString(rawConfig.primary_session_key),
    lastSessionError: asTrimmedString(rawConfig.last_session_error),
    runtimeManaged: rawConfig.runtime_managed === true,
    roleHash: asTrimmedString(rawConfig.role_hash),
    sessionBootstrapHash: asTrimmedString(rawConfig.session_bootstrap_hash),
    sessionBootstrapState: asSessionState(rawConfig.session_bootstrap_state) || 'pending',
    sessionBootstrapError: asTrimmedString(rawConfig.session_bootstrap_error),
  }
}

export function getLocalRuntimeWorkingDirectory(input: {
  workspacePath?: unknown
  config?: unknown
} | null | undefined): string | undefined {
  const direct = resolveWorkingDirectory(input?.workspacePath)
  if (direct) return direct

  const config = parseConfigRecord(input?.config)
  const candidates = [
    config?.cwd,
    config?.workingDir,
    config?.working_dir,
    config?.workspace,
    config?.workspacePath,
    config?.workspace_path,
    config?.dir,
  ]

  for (const candidate of candidates) {
    const resolved = resolveWorkingDirectory(candidate)
    if (resolved) return resolved
  }

  return undefined
}

/**
 * Per-agent Codex cwd so `codex exec` does not resume the latest thread in a shared repo
 * (e.g. an existing "test" session). Persisted on bind as mc_session_project_path.
 */
function ensureDedicatedAgentWorkingDirectory(agent: LocalRuntimeAgentRef): string {
  const parsed = getParsedLocalAgentSessionConfig(agent)
  const stored = resolveWorkingDirectory(parsed.rawConfig.mc_session_project_path)
  const existingKey = getExistingAgentSessionKey(agent)
  if (stored && existingKey) {
    return stored
  }

  const agentId = typeof agent.id === 'number' && Number.isFinite(agent.id) ? agent.id : null
  const slug = (asTrimmedString(agent.name) || 'agent')
    .replace(/[^\w\u4e00-\u9fff-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'agent'
  const workspaceBase = getLocalRuntimeWorkingDirectory(agent)
  const root = workspaceBase
    ? path.join(workspaceBase, '.e-agent', agentId != null ? `agent-${agentId}` : slug)
    : path.join(config.homeDir, '.e-agent-client', 'agent-sessions', agentId != null ? String(agentId) : slug)

  mkdirSync(root, { recursive: true })
  return root
}

function resolveCodexWorkingDirectoryForAgent(agent: LocalRuntimeAgentRef): string {
  const sessionKey = getExistingAgentSessionKey(agent)
  if (sessionKey) {
    return (
      resolveLocalExecutionWorkingDirectory('codex-cli', sessionKey, agent)
      || ensureDedicatedAgentWorkingDirectory(agent)
    )
  }
  return ensureDedicatedAgentWorkingDirectory(agent)
}

/** Claude `--resume` only works from the project cwd where the session JSONL was created. */
export function resolveLocalExecutionWorkingDirectory(
  kind: LocalSessionKind,
  sessionId: string | null | undefined,
  agent: LocalRuntimeAgentRef | null | undefined,
  preferred?: string,
): string | undefined {
  const preferredCwd = resolveWorkingDirectory(preferred) || getLocalRuntimeWorkingDirectory(agent ?? undefined)

  const config = parseConfigRecord(agent?.config)
  const storedCwd = resolveWorkingDirectory(config?.mc_session_project_path)
  if (storedCwd) return storedCwd

  if (kind !== 'claude-code' || !sessionId) {
    return preferredCwd
  }

  const discoveredCwd = findClaudeSessionProjectPath(sessionId)
  if (discoveredCwd) return discoveredCwd

  return preferredCwd
}

function getExistingAgentSessionKey(agent: LocalRuntimeAgentRef | null | undefined): string | null {
  const direct = asTrimmedString(agent?.session_key)
  if (direct) return direct
  return getParsedLocalAgentSessionConfig(agent).primarySessionKey
}

/** Session IDs already bound to other agents — never steal for auto-provision or resume. */
function getReservedSessionKeys(excludeAgentId?: number | null): Set<string> {
  try {
    const db = getDatabase()
    const rows = (
      excludeAgentId != null && Number.isFinite(excludeAgentId)
        ? db.prepare(
            `SELECT session_key FROM agents
             WHERE session_key IS NOT NULL AND TRIM(session_key) != '' AND id != ?`,
          ).all(excludeAgentId)
        : db.prepare(
            `SELECT session_key FROM agents
             WHERE session_key IS NOT NULL AND TRIM(session_key) != ''`,
          ).all()
    ) as Array<{ session_key: string }>
    return new Set(rows.map((row) => String(row.session_key).trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}

function findCodexSessionStats(sessionId: string) {
  return scanCodexSessions(300).find((session) => session.sessionId === sessionId) || null
}

function codexSessionMatchesWorkspace(
  session: { projectPath: string | null },
  workingDirectory: string | undefined,
): boolean {
  if (!workingDirectory) return true
  if (!session.projectPath) return true
  const sessionPath = path.resolve(session.projectPath)
  const cwd = path.resolve(workingDirectory)
  if (sessionPath === cwd) return true
  // Codex often records the git/repo root while we exec from `.e-agent/agent-{id}`.
  if (cwd.startsWith(sessionPath + path.sep)) return true
  if (sessionPath.startsWith(cwd + path.sep)) return true
  return false
}

function validateAgentSessionBinding(
  agent: LocalRuntimeAgentRef,
  sessionId: string,
  kind: LocalSessionKind,
): { ok: true } | { ok: false; reason: string } {
  const reserved = getReservedSessionKeys(agent.id ?? null)
  if (reserved.has(sessionId)) {
    return { ok: false, reason: 'session_owned_by_another_agent' }
  }

  if (kind === 'codex-cli') {
    const stats = findCodexSessionStats(sessionId)
    if (!stats) {
      return { ok: false, reason: 'codex_session_not_found' }
    }
    const workingDirectory = getLocalRuntimeWorkingDirectory(agent)
    if (!codexSessionMatchesWorkspace(stats, workingDirectory)) {
      return { ok: false, reason: 'codex_session_cwd_mismatch' }
    }
    const parsed = getParsedLocalAgentSessionConfig(agent)
    const boundAgentId = parsed.rawConfig.mc_bound_agent_id
    if (
      boundAgentId != null &&
      agent.id != null &&
      Number(boundAgentId) !== Number(agent.id)
    ) {
      return { ok: false, reason: 'session_bound_to_different_agent' }
    }
  }

  return { ok: true }
}

function pickNewCodexSessionId(input: {
  knownSessionIds: Set<string>
  reservedSessionKeys: Set<string>
  startedAt: number
  workingDirectory: string | null
}): string | null {
  const detected = scanCodexSessions(200)
  const candidate = detected.find((session) => {
    if (input.knownSessionIds.has(session.sessionId)) return false
    if (input.reservedSessionKeys.has(session.sessionId)) return false
    if (!session.lastMessageAt || !session.firstMessageAt) return false
    const lastMessageAt = new Date(session.lastMessageAt).getTime()
    const firstMessageAt = new Date(session.firstMessageAt).getTime()
    if (lastMessageAt < input.startedAt - 5_000) return false
    if (firstMessageAt < input.startedAt - 5_000) return false
    if (!codexSessionMatchesWorkspace(session, input.workingDirectory || undefined)) {
      return false
    }
    return true
  })
  return candidate?.sessionId || null
}

function buildUpdatedAgentConfig(
  agent: LocalRuntimeAgentRef | null | undefined,
  updates: Partial<{
    mode: LocalAgentSessionMode
    strategy: LocalAgentSessionStrategy
      state: LocalAgentSessionState
      primarySessionKey: string | null
      lastSessionError: string | null
      roleHash: string | null
      sessionBootstrapHash: string | null
      sessionBootstrapState: LocalAgentSessionState
      sessionBootstrapError: string | null
    }>,
): string {
  const parsed = getParsedLocalAgentSessionConfig(agent)
  const nextConfig: Record<string, unknown> = {
    ...parsed.rawConfig,
    session_mode: updates.mode ?? parsed.mode,
    session_strategy: updates.strategy ?? parsed.strategy,
    session_state: updates.state ?? parsed.state,
    primary_session_key: updates.primarySessionKey !== undefined
      ? updates.primarySessionKey
      : (parsed.primarySessionKey ?? getExistingAgentSessionKey(agent) ?? null),
    role_hash: updates.roleHash !== undefined ? updates.roleHash : parsed.roleHash,
    session_bootstrap_hash: updates.sessionBootstrapHash !== undefined ? updates.sessionBootstrapHash : parsed.sessionBootstrapHash,
    session_bootstrap_state: updates.sessionBootstrapState !== undefined ? updates.sessionBootstrapState : parsed.sessionBootstrapState,
  }

  if (updates.lastSessionError !== undefined) {
    if (updates.lastSessionError) nextConfig.last_session_error = updates.lastSessionError
    else delete nextConfig.last_session_error
  } else if (parsed.lastSessionError) {
    nextConfig.last_session_error = parsed.lastSessionError
  }

  return JSON.stringify(nextConfig)
}

function buildAgentRoleDefinition(agent: LocalRuntimeAgentRef | null | undefined): string | null {
  const config = parseConfigRecord(agent?.config)
  const identity = config && typeof config.identity === 'object' && config.identity !== null
    ? config.identity as Record<string, unknown>
    : null

  const lines: string[] = []
  const name = asTrimmedString(identity?.name) || asTrimmedString(agent?.name)
  const role = asTrimmedString(identity?.theme) || asTrimmedString(agent?.role)
  const emoji = asTrimmedString(identity?.emoji)
  const identityContent = asTrimmedString(identity?.content)
  const soul = asTrimmedString(agent?.soul_content)

  if (name) lines.push(`Agent Name: ${name}`)
  if (role) lines.push(`Primary Role: ${role}`)
  if (emoji) lines.push(`Persona Marker: ${emoji}`)
  if (identityContent) {
    lines.push('', 'Identity Profile:', identityContent)
  }
  if (soul) {
    lines.push('', 'Agent Charter:', soul)
  }

  const result = lines.join('\n').trim()
  return result || null
}

function buildSessionRolePreamble(
  agent: LocalRuntimeAgentRef,
  permissionMode?: LocalCliPermissionMode,
): string | null {
  const roleDefinition = buildAgentRoleDefinition(agent)
  if (!roleDefinition) return null
  const mode = permissionMode ?? resolveLocalCliPermissionMode(agent)

  return [
    'E-Agent-Client dedicated-session setup.',
    'Adopt and preserve the following agent role definition for this entire session.',
    'Treat it as your standing charter until E-Agent-Client explicitly replaces it.',
    '',
    roleDefinition,
    '',
    ...buildLocalCliOperatingRules(mode),
    '',
    ...buildPlatformManagedOperatingRules(mode),
  ].join('\n')
}

function buildPlatformManagedOperatingRules(mode: LocalCliPermissionMode): string[] {
  return [
    'Platform-managed session rules:',
    '1. This session was started or continued by E-Agent-Client. Treat E-Agent-Client as the execution proxy for this session only.',
    '2. Do not ask the user to modify global Codex, shell, PATH, or MCP configuration unless the user explicitly requests environment setup.',
    '3. If this turn is marked as elevated/full local CLI permission, proceed with command-style work directly instead of saying that a separate local approval is needed.',
    '4. When your reply needs a follow-up confirmation, clarification, or user-style response so you can continue, call mc_create_watch_event with the current question/context; the platform will route it to the bound human-watch steward and send the steward reply back into this Worker session.',
    '5. When you need a structured allow/deny/ask_human permission choice for a blocked or risky action, call mc_create_permission_request and then mc_wait_permission_request. Continue only when the permission request returns an approved option. If a human replies inside this Worker session instead of the platform approval page, call mc_record_worker_human_reply with the selected option so the platform can close the approval.',
    mode === 'full'
      ? '6. Elevated mode is active for this turn; use the available CLI capability to complete the requested command work.'
      : '6. Standard mode is active; stay within the normal local CLI constraints for this session.',
  ]
}

/** Standalone bootstrap (e.g. role refresh without a user turn). */
function buildSessionBootstrapPrompt(
  agent: LocalRuntimeAgentRef,
  permissionMode?: LocalCliPermissionMode,
): string | null {
  const preamble = buildSessionRolePreamble(agent, permissionMode)
  if (!preamble) return null

  return [
    preamble,
    '',
    'This is not a user task.',
    'Reply with exactly: READY',
  ].join('\n')
}

/** Single-turn bootstrap + user message (avoids a second CLI round-trip). */
function buildSessionBootstrapWithUserPrompt(
  agent: LocalRuntimeAgentRef,
  userPrompt: string,
  permissionMode?: LocalCliPermissionMode,
): string | null {
  const preamble = buildSessionRolePreamble(agent, permissionMode)
  if (!preamble) return null

  return [
    preamble,
    '',
    'Now respond to the following user message in character:',
    userPrompt,
  ].join('\n')
}

function computeAgentRoleHash(agent: LocalRuntimeAgentRef): string | null {
  const roleDefinition = buildAgentRoleDefinition(agent)
  return roleDefinition ? sha256(roleDefinition) : null
}

function shouldBootstrapSession(agent: LocalRuntimeAgentRef, roleHash: string | null): boolean {
  if (!roleHash) return false
  const parsed = getParsedLocalAgentSessionConfig(agent)
  if (parsed.runtimeManaged) return false
  if (parsed.mode === 'shared') return false
  if (parsed.sessionBootstrapState !== 'ready') return true
  return parsed.sessionBootstrapHash !== roleHash
}

function getSerializedAgentExecutionKey(agent: LocalRuntimeAgentRef, kind: LocalSessionKind): string {
  if (typeof agent.id === 'number' && Number.isFinite(agent.id)) return `agent:${agent.id}`
  if (typeof agent.name === 'string' && agent.name.trim()) return `agent-name:${agent.name.trim().toLowerCase()}`
  const sessionKey = getExistingAgentSessionKey(agent)
  if (sessionKey) return `session:${kind}:${sessionKey}`
  return `runtime:${kind}:unbound`
}

async function runSerializedAgentExecution(
  key: string,
  operation: () => Promise<LocalSessionExecutionResult>,
): Promise<LocalSessionExecutionResult> {
  const previous = agentSessionExecutionChains.get(key) || Promise.resolve({
    sessionId: null,
    reply: '',
  })

  const current = previous
    .catch(() => ({ sessionId: null, reply: '' }))
    .then(operation)

  agentSessionExecutionChains.set(key, current)

  try {
    return await current
  } finally {
    if (agentSessionExecutionChains.get(key) === current) {
      agentSessionExecutionChains.delete(key)
    }
  }
}

function getFreshAgentRecord(agent: LocalRuntimeAgentRef): LocalRuntimeAgentRef {
  if (typeof agent.id !== 'number' || !Number.isFinite(agent.id)) return agent
  try {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT id, name, role, soul_content, framework, session_key, config, workspace_path, source, parent_id, status
      FROM agents
      WHERE id = ?
      LIMIT 1
    `).get(agent.id) as LocalRuntimeAgentRef | undefined
    return row || agent
  } catch {
    return agent
  }
}

function notifyLocalSessionVisibility(
  kind: LocalSessionKind,
  sessionId: string | null | undefined,
  reason: string,
  agentId?: number | null,
) {
  if (kind === 'codex-cli') {
    invalidateCodexSessionScan()
  }
  if (kind === 'claude-code') {
    invalidateClaudeSessionSync()
  }
  invalidateMergedSessionsCache()
  const source = sessionSourceFromKind(kind)
  if (source) {
    eventBus.broadcast('session.list.updated', {
      source,
      sessionKind: kind,
      sessionId: sessionId || undefined,
      sessionKey: sessionId || undefined,
      reason,
      ...(agentId != null ? { agentId } : {}),
    })
  }
  notifySessionTranscriptUpdated(kind, sessionId || '', reason, {
    ...(agentId != null ? { agentId } : {}),
  })
}

function persistAgentSessionBinding(
  agent: LocalRuntimeAgentRef,
  input: {
    sessionKey?: string | null
      state: LocalAgentSessionState
      lastSessionError?: string | null
      status?: 'offline' | 'idle' | 'busy' | 'error'
      roleHash?: string | null
      sessionBootstrapHash?: string | null
      sessionBootstrapState?: LocalAgentSessionState
      sessionBootstrapError?: string | null
      sessionProjectPath?: string | null
    },
) {
  if (typeof agent.id !== 'number' || !Number.isFinite(agent.id)) return

  try {
    const db = getDatabase()
    const now = Math.floor(Date.now() / 1000)
    const fresh = getFreshAgentRecord(agent)
    const nextSessionKey = input.sessionKey !== undefined ? input.sessionKey : getExistingAgentSessionKey(fresh)
    const configJson = buildUpdatedAgentConfig(fresh, {
      state: input.state,
      primarySessionKey: nextSessionKey ?? null,
      lastSessionError: input.lastSessionError ?? null,
      roleHash: input.roleHash,
      sessionBootstrapHash: input.sessionBootstrapHash,
      sessionBootstrapState: input.sessionBootstrapState,
      sessionBootstrapError: input.sessionBootstrapError ?? null,
    })
    const configObj = JSON.parse(configJson) as Record<string, unknown>
    if (nextSessionKey) {
      configObj.mc_bound_agent_id = agent.id
    } else {
      delete configObj.mc_bound_agent_id
    }

    if (input.sessionProjectPath !== undefined) {
      const resolvedProjectPath = resolveWorkingDirectory(input.sessionProjectPath)
      if (resolvedProjectPath) {
        configObj.mc_session_project_path = resolvedProjectPath
      } else {
        delete configObj.mc_session_project_path
      }
    }

    db.prepare(`
      UPDATE agents
      SET session_key = ?, config = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextSessionKey,
      JSON.stringify(configObj),
      input.status ?? (input.state === 'broken' ? 'error' : 'idle'),
      now,
      agent.id,
    )

    if (input.sessionKey !== undefined) {
      eventBus.broadcast('agent.updated', {
        id: agent.id,
        session_key: nextSessionKey,
        session_state: input.state,
      })
      if (nextSessionKey) {
        const kind = getLocalSessionKindForFramework(fresh.framework)
        if (kind) {
          notifyLocalSessionVisibility(kind, nextSessionKey, 'session_bound', agent.id)
        }
      }
    }
  } catch (error) {
    logger.warn({ err: error, agentId: agent.id }, 'Failed to persist agent session binding')
  }
}

function parseJsonPayloads(raw: string): unknown[] {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return []

  const payloads: unknown[] = []
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    if (!(line.startsWith('{') || line.startsWith('['))) continue
    try {
      payloads.push(JSON.parse(line))
    } catch {
      // ignore malformed JSON line
    }
  }

  if (payloads.length > 0) return payloads

  try {
    return [JSON.parse(trimmed)]
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return [JSON.parse(trimmed.slice(start, end + 1))]
      } catch {
        return []
      }
    }
  }

  return []
}

function extractStructuredText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }

  if (!value || typeof value !== 'object') return null

  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const candidate = extractStructuredText(value[index])
      if (candidate) return candidate
    }
    return null
  }

  const record = value as Record<string, unknown>
  const preferredKeys = ['result', 'text', 'output', 'message', 'response', 'answer', 'content']
  for (const key of preferredKeys) {
    const candidate = extractStructuredText(record[key])
    if (candidate) return candidate
  }

  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== 'object') continue
    const candidate = extractStructuredText(nested)
    if (candidate) return candidate
  }

  return null
}

function extractStructuredSessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null

  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const candidate = extractStructuredSessionId(value[index])
      if (candidate) return candidate
    }
    return null
  }

  const record = value as Record<string, unknown>
  const directCandidates = [
    record.sessionId,
    record.session_id,
    record.sessionID,
    record.thread_id,
    record.threadId,
    record.chatId,
    record.chat_id,
  ]

  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }

  for (const nested of Object.values(record)) {
    if (!nested || typeof nested !== 'object') continue
    const candidate = extractStructuredSessionId(nested)
    if (candidate) return candidate
  }

  return null
}

function extractStructuredOutput(raw: string): { reply: string | null; sessionId: string | null } {
  let reply: string | null = null
  let sessionId: string | null = null

  for (const payload of parseJsonPayloads(raw)) {
    const nextReply = extractStructuredText(payload)
    if (nextReply) reply = nextReply
    const nextSessionId = extractStructuredSessionId(payload)
    if (nextSessionId) sessionId = nextSessionId
  }

  return { reply, sessionId }
}

function resolveCodexBin(): string {
  const fromEnv = (process.env.MC_CODEX_BIN || '').trim()
  if (fromEnv) return fromEnv
  if (existsSync('/opt/homebrew/bin/codex')) return '/opt/homebrew/bin/codex'
  if (existsSync('/usr/local/bin/codex')) return '/usr/local/bin/codex'
  return 'codex'
}

/** Codex sometimes exits non-zero while still returning a usable thread id on stdout. */
function codexStdoutIndicatesSuccess(stdout: string): boolean {
  const parsed = extractStructuredOutput(stdout)
  if (parsed.sessionId) return true
  if (parsed.reply && /READY/i.test(parsed.reply)) return true
  return /"type"\s*:\s*"thread\.started"/.test(stdout) || /thread_id/.test(stdout)
}

function isIgnorableCodexStderr(stderr: string): boolean {
  const normalized = String(stderr || '').toLowerCase()
  if (!normalized.trim()) return true
  return (
    normalized.includes('reading additional input from stdin') ||
    normalized.includes('failed to record rollout items') ||
    normalized.includes('thread') && normalized.includes('not found')
  )
}

function resolveExecutionPermissionMode(options: LocalSessionExecutionOptions): LocalCliPermissionMode {
  return resolveLocalCliPermissionMode(options.agent, options.permissionMode)
}

function resolveExecutionSandbox(options: LocalSessionExecutionOptions) {
  return resolveCliDispatchSandboxOptions(options.agent?.config, options, getLocalRuntimeWorkingDirectory({
    workspacePath: options.agent?.workspace_path,
    config: options.agent?.config,
  }))
}

function buildAgentExecutionOptions(
  agent: LocalRuntimeAgentRef,
  workingDirectory?: string,
  permissionModeOverride?: LocalCliPermissionMode | null,
  workerSessionId?: string | null,
  sessionKind?: LocalSessionKind | null,
  dispatchOptions: LocalSessionExecutionOptions = {},
): LocalSessionExecutionOptions {
  const permissionMode = resolveLocalCliPermissionMode(agent, permissionModeOverride)
  return {
    workingDirectory,
    permissionMode,
    agent,
    managedByPlatform: true,
    workerSessionId,
    sessionKind,
    dispatchAllowedTools: dispatchOptions.dispatchAllowedTools,
    dispatchMaxBudgetUsd: dispatchOptions.dispatchMaxBudgetUsd,
    dispatchCwd: dispatchOptions.dispatchCwd,
  }
}

async function runCodexExecCommand(
  args: string[],
  options: LocalSessionExecutionOptions,
): Promise<{ stdout: string; stderr: string }> {
  const permissionMode = resolveExecutionPermissionMode(options)
  const mcpArgs = withCodexMcpConfigArgs(args, {
    managedByPlatform: options.managedByPlatform,
    agentId: options.agent?.id,
    agentName: options.agent?.name ?? null,
    workerSessionId: options.workerSessionId,
    sessionKind: options.sessionKind,
    permissionMode,
  })
  const finalArgs = withLocalCliPermissionArgs('codex', mcpArgs, permissionMode)
  try {
    const result = await runCommand(resolveCodexBin(), finalArgs, buildCommandOptions(options))
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    const stdout = String(err.stdout || '')
    const stderr = String(err.stderr || '')
    if (codexStdoutIndicatesSuccess(stdout) && isIgnorableCodexStderr(stderr)) {
      logger.warn(
        { stderr: stderr.slice(0, 400), args: args.slice(0, 4) },
        'Codex exited non-zero but session output looks usable; continuing',
      )
      return { stdout, stderr }
    }
    throw error
  }
}

function buildCommandEnv(options?: LocalSessionExecutionOptions): NodeJS.ProcessEnv {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const existing = process.env[pathKey] || ''
  const prefixes = ['/opt/homebrew/bin', '/usr/local/bin'].filter((p) => existsSync(p))
  const merged = [...prefixes, ...existing.split(path.delimiter).filter(Boolean)].join(path.delimiter)
  return {
    ...process.env,
    [pathKey]: merged,
    ...(options?.managedByPlatform ? {
      MC_PLATFORM_MANAGED_SESSION: '1',
      MC_LOCAL_CLI_PERMISSION_MODE: resolveExecutionPermissionMode(options),
      ...(options.workerSessionId ? { MC_WORKER_SESSION_ID: options.workerSessionId } : {}),
      ...(options.sessionKind ? { MC_SESSION_KIND: options.sessionKind } : {}),
      ...(options.agent?.id != null ? { MC_AGENT_ID: String(options.agent.id) } : {}),
      ...(options.agent?.name ? { MC_AGENT_NAME: String(options.agent.name) } : {}),
    } : {}),
  }
}

function buildCommandOptions(options: LocalSessionExecutionOptions) {
  const requestedTimeoutMs = Number(options.timeoutMs)
  const commandOptions: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv } = {
    timeoutMs: Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.max(10_000, Math.floor(requestedTimeoutMs))
      : EXECUTION_TIMEOUT_MS,
    env: buildCommandEnv(options),
  }
  const sandbox = resolveExecutionSandbox(options)
  const requestedCwd = resolveWorkingDirectory(options.workingDirectory)
  const cwd = sandbox.cwd || requestedCwd
  if (cwd) commandOptions.cwd = cwd
  return commandOptions
}

function scheduleClaudeSessionIndexRefresh(): void {
  void syncClaudeSessions(true)
    .catch((error) => {
      logger.warn({ err: error }, 'Failed to refresh Claude session index after local prompt')
    })
    .finally(() => {
      invalidateMergedSessionsCache()
    })
}

function recoverClaudeSessionStart(
  sessionId: string,
  options: LocalSessionExecutionOptions,
): LocalSessionExecutionResult | null {
  if (!findClaudeSessionFilePath(sessionId)) return null

  const reply = readLastClaudeSessionReply(sessionId)
    || 'Session was created on disk, but no assistant reply was captured yet.'
  scheduleClaudeSessionIndexRefresh()

  logger.warn(
    { sessionId, cwd: resolveWorkingDirectory(options.workingDirectory) },
    'Recovered Claude session from on-disk JSONL after CLI start reported failure',
  )

  return { sessionId, reply }
}

function isMissingCommandError(error: unknown): boolean {
  const err = error as { code?: string; message?: string }
  return err?.code === 'ENOENT' || String(err?.message || '').includes('ENOENT')
}

function isRecoverableSessionResumeError(error: unknown): boolean {
  const message = String((error as Error)?.message || '').toLowerCase()
  if (!message) return false
  return (
    message.includes('valid session id') ||
    message.includes('does not match any session title') ||
    message.includes('session not found') ||
    message.includes('unknown session') ||
    message.includes('invalid session') ||
    message.includes('no conversation found') ||
    message.includes('needs reprovisioning')
  )
}

async function runCommandWithFallback(
  commands: string[],
  args: string[],
  options: LocalSessionExecutionOptions,
) {
  let lastError: unknown = null
  for (const command of commands) {
    if (!command?.trim()) continue
    try {
      return await runCommand(command, args, buildCommandOptions(options))
    } catch (error) {
      lastError = error
      if (!isMissingCommandError(error)) throw error
    }
  }

  if (lastError) throw lastError
  throw new Error('No executable configured for local runtime adapter')
}

async function supportsModernOpenCodeRun(): Promise<boolean> {
  const now = Date.now()
  if (opencodeRunSupportCache && now - opencodeRunSupportCache.checkedAt < RUNTIME_PROBE_TTL_MS) {
    return opencodeRunSupportCache.supported
  }

  let supported = false
  try {
    const result = await runCommand('opencode', ['run', '--help'], {
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    const helpText = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase()
    supported = helpText.includes('opencode run') || helpText.includes('--session') || helpText.includes('--continue')
  } catch {
    supported = false
  }

  opencodeRunSupportCache = { checkedAt: now, supported }
  return supported
}

function canAutoProvisionLocalSession(agent: LocalRuntimeAgentRef, kind: LocalSessionKind): boolean {
  const parsed = getParsedLocalAgentSessionConfig(agent)
  if (parsed.runtimeManaged) return false
  if (parsed.mode !== 'dedicated') return false
  return kind === 'claude-code' || kind === 'codex-cli' || kind === 'cursor' || kind === 'opencode'
}

async function bootstrapAgentSession(
  agent: LocalRuntimeAgentRef,
  kind: LocalSessionKind,
  sessionId: string,
  roleHash: string | null,
  workingDirectory?: string,
): Promise<void> {
  const permissionMode = resolveLocalCliPermissionMode(agent)
  const bootstrapPrompt = buildSessionBootstrapPrompt(agent, permissionMode)
  if (!bootstrapPrompt || !roleHash) {
    persistAgentSessionBinding(agent, {
      sessionKey: sessionId,
      state: 'ready',
      roleHash,
      sessionBootstrapHash: null,
      sessionBootstrapState: 'ready',
      sessionBootstrapError: null,
      lastSessionError: null,
      status: 'idle',
    })
    return
  }

  persistAgentSessionBinding(agent, {
    sessionKey: sessionId,
    state: 'provisioning',
    roleHash,
    sessionBootstrapHash: null,
    sessionBootstrapState: 'provisioning',
    sessionBootstrapError: null,
    lastSessionError: null,
    status: 'idle',
  })

  try {
    await executeLocalSessionPrompt(kind, sessionId, bootstrapPrompt, buildAgentExecutionOptions(agent, workingDirectory))
    persistAgentSessionBinding(agent, {
      sessionKey: sessionId,
      state: 'ready',
      roleHash,
      sessionBootstrapHash: roleHash,
      sessionBootstrapState: 'ready',
      sessionBootstrapError: null,
      lastSessionError: null,
      status: 'idle',
    })
  } catch (error) {
    persistAgentSessionBinding(agent, {
      sessionKey: sessionId,
      state: 'broken',
      roleHash,
      sessionBootstrapHash: null,
      sessionBootstrapState: 'broken',
      sessionBootstrapError: (error as Error)?.message || 'Session bootstrap failed',
      lastSessionError: (error as Error)?.message || 'Session bootstrap failed',
      status: 'error',
    })
    throw error
  }
}

const LOCAL_RUNTIME_EXECUTORS: Record<LocalSessionKind, LocalRuntimeExecutorAdapter> = {
  'claude-code': {
    kind: 'claude-code',
    frameworks: ['claude', 'claude-code', 'claude-sdk'],
    async execute(sessionId, prompt, options) {
      ensureValidSessionId(sessionId)
      const permissionMode = resolveExecutionPermissionMode(options)
      const sandbox = resolveExecutionSandbox(options)
      const sandboxArgs = [
        ...(sandbox.allowedTools ? ['--allowedTools', sandbox.allowedTools.join(',')] : []),
        ...(sandbox.maxBudgetUsd !== null ? ['--max-budget-usd', String(sandbox.maxBudgetUsd)] : []),
      ]
      const mcpArgs = withClaudeMcpConfigArgs(
        ['--print', '--resume', sessionId, ...sandboxArgs, prompt],
        {
          managedByPlatform: options.managedByPlatform,
          agentId: options.agent?.id,
          agentName: options.agent?.name ?? null,
          workerSessionId: options.workerSessionId,
          sessionKind: options.sessionKind,
          permissionMode,
        },
      )
      const args = withLocalCliPermissionArgs(
        'claude',
        mcpArgs,
        permissionMode,
      )
      const result = await runCommand('claude', args, buildCommandOptions(options))
      return {
        sessionId,
        reply: (result.stdout || '').trim() || (result.stderr || '').trim(),
      }
    },
    async start(prompt, options) {
      const sessionId = randomUUID()
      const commandOptions = buildCommandOptions(options)
      const permissionMode = resolveExecutionPermissionMode(options)
      const sandbox = resolveExecutionSandbox(options)
      const sandboxArgs = [
        ...(sandbox.allowedTools ? ['--allowedTools', sandbox.allowedTools.join(',')] : []),
        ...(sandbox.maxBudgetUsd !== null ? ['--max-budget-usd', String(sandbox.maxBudgetUsd)] : []),
      ]
      const mcpArgs = withClaudeMcpConfigArgs(
        ['--print', '--session-id', sessionId, ...sandboxArgs, prompt],
        {
          managedByPlatform: options.managedByPlatform,
          agentId: options.agent?.id,
          agentName: options.agent?.name ?? null,
          workerSessionId: options.workerSessionId,
          sessionKind: options.sessionKind,
          permissionMode,
        },
      )
      const args = withLocalCliPermissionArgs(
        'claude',
        mcpArgs,
        permissionMode,
      )
      try {
        const result = await runCommand(
          'claude',
          args,
          commandOptions,
        )
        scheduleClaudeSessionIndexRefresh()
        return {
          sessionId,
          reply: (result.stdout || '').trim() || (result.stderr || '').trim(),
        }
      } catch (error) {
        const recovered = recoverClaudeSessionStart(sessionId, options)
        if (recovered) return recovered
        throw error
      }
    },
  },
  'codex-cli': {
    kind: 'codex-cli',
    frameworks: ['codex', 'codex-cli', 'openai'],
    async execute(sessionId, prompt, options) {
      ensureValidSessionId(sessionId)
      const outputPath = path.join('/tmp', `mc-codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      let commandResult: { stdout: string; stderr: string } | null = null
      try {
        commandResult = await runCodexExecCommand(
          ['exec', 'resume', sessionId, prompt, '--skip-git-repo-check', '-o', outputPath],
          options,
        )
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string }
        commandResult = {
          stdout: String(err.stdout || ''),
          stderr: String(err.stderr || ''),
        }
        logger.warn({ err: error, sessionId }, 'Codex resume command reported failure; reading output file')
      }

      let reply = ''
      try {
        reply = (await fs.readFile(outputPath, 'utf-8')).trim()
      } catch {
        reply = ''
      }

      try {
        await fs.unlink(outputPath)
      } catch {
        // ignore
      }

      if (!reply) {
        const parsed = extractStructuredOutput(commandResult?.stdout || '')
        reply = parsed.reply || (commandResult?.stdout || '').trim()
      }

      return { sessionId, reply }
    },
    async start(prompt, options) {
      const outputPath = path.join('/tmp', `mc-codex-start-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      const knownSessionIds = new Set(scanCodexSessions(200).map((session) => session.sessionId))
      const startedAt = Date.now()

      let commandResult: { stdout: string; stderr: string } | null = null
      try {
        commandResult = await runCodexExecCommand(
          ['exec', prompt, '--skip-git-repo-check', '--json', '-o', outputPath],
          options,
        )
      } finally {
        // best-effort output read below
      }

      let reply = ''
      try {
        reply = (await fs.readFile(outputPath, 'utf-8')).trim()
      } catch {
        reply = ''
      }

      try {
        await fs.unlink(outputPath)
      } catch {
        // ignore
      }

      const parsed = extractStructuredOutput(commandResult?.stdout || '')
      let sessionId = parsed.sessionId
      if (sessionId && knownSessionIds.has(sessionId)) {
        logger.warn(
          { sessionId, agentName: options.agentName },
          'Codex returned an existing thread id during dedicated-session start; ignoring to avoid binding a shared session',
        )
        sessionId = null
      }

      if (!sessionId) {
        invalidateCodexSessionScan()
        const workingDirectory = resolveWorkingDirectory(options.workingDirectory) || null
        sessionId = pickNewCodexSessionId({
          knownSessionIds,
          reservedSessionKeys: getReservedSessionKeys(options.excludeAgentId ?? null),
          startedAt,
          workingDirectory,
        })
      }

      if (!sessionId) {
        throw new Error('Codex session was created, but E-Agent-Client could not determine the new session id')
      }

      return {
        sessionId,
        reply: reply || parsed.reply || (commandResult?.stdout || '').trim() || (commandResult?.stderr || '').trim(),
      }
    },
  },
  cursor: {
    kind: 'cursor',
    frameworks: ['cursor'],
    async execute(sessionId, prompt, options) {
      ensureValidSessionId(sessionId)
      const result = await runCommand(
        'cursor',
        ['agent', '--print', '--output-format', 'json', '--force', '--trust', '--resume', sessionId, prompt],
        buildCommandOptions(options),
      )
      const parsed = extractStructuredOutput(result.stdout)
      return {
        sessionId: parsed.sessionId || sessionId,
        reply: parsed.reply || (result.stdout || '').trim() || (result.stderr || '').trim(),
      }
    },
    async start(prompt, options) {
      let rawOutput = ''
      try {
        const result = await runCommand(
          'cursor',
          ['agent', 'create-chat'],
          buildCommandOptions(options),
        )
        rawOutput = `${result.stdout || ''}\n${result.stderr || ''}`
      } catch (error) {
        rawOutput = `${String((error as any)?.stdout || '')}\n${String((error as any)?.stderr || '')}\n${String((error as Error)?.message || '')}`
      }

      const match = rawOutput.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)
      if (!match?.[0]) {
        throw new Error('Cursor did not return a chat id for the new dedicated session')
      }

      return LOCAL_RUNTIME_EXECUTORS.cursor.execute(match[0], prompt, options)
    },
  },
  hermes: {
    kind: 'hermes',
    frameworks: ['hermes', 'hermes-agent'],
    async execute(sessionId, prompt, options) {
      ensureValidSessionId(sessionId)
      const result = await runCommandWithFallback(
        [process.env.HERMES_BIN || '', 'hermes', 'hermes-agent'],
        ['chat', '--quiet', '--query', prompt, '--resume', sessionId],
        options,
      )
      const parsed = extractStructuredOutput(result.stdout)
      return {
        sessionId: parsed.sessionId || sessionId,
        reply: parsed.reply || (result.stdout || '').trim() || (result.stderr || '').trim(),
      }
    },
  },
  opencode: {
    kind: 'opencode',
    frameworks: ['opencode', 'open-code'],
    async execute(sessionId, prompt, options) {
      ensureValidSessionId(sessionId)
      const modernRunSupported = await supportsModernOpenCodeRun()

      if (modernRunSupported) {
        const result = await runCommand(
          'opencode',
          ['run', '--session', sessionId, '--format', 'json', prompt],
          buildCommandOptions(options),
        )
        const parsed = extractStructuredOutput(result.stdout)
        return {
          sessionId: parsed.sessionId || sessionId,
          reply: parsed.reply || (result.stdout || '').trim() || (result.stderr || '').trim(),
        }
      }

      logger.warn({ sessionId }, 'OpenCode CLI lacks session run support; falling back to one-shot prompt execution')
      const result = await runCommand(
        'opencode',
        ['-q', '-p', prompt, '-f', 'json'],
        buildCommandOptions(options),
      )
      const parsed = extractStructuredOutput(result.stdout)
      return {
        sessionId,
        reply: parsed.reply || (result.stdout || '').trim() || (result.stderr || '').trim(),
      }
    },
    async start(prompt, options) {
      const modernRunSupported = await supportsModernOpenCodeRun()
      if (!modernRunSupported) {
        throw new Error('OpenCode dedicated session auto-provision requires an installed CLI version with session run support')
      }
      const sessionId = randomUUID()
      return LOCAL_RUNTIME_EXECUTORS.opencode.execute(sessionId, prompt, options)
    },
  },
}

export function clearLocalSessionExecutorCaches() {
  opencodeRunSupportCache = null
  agentSessionExecutionChains.clear()
}

const EMPTY_EXECUTION_RESULT: LocalSessionExecutionResult = { sessionId: null, reply: '' }
const RESOLVED_EMPTY_EXECUTION = Promise.resolve(EMPTY_EXECUTION_RESULT)

function isAgentStillRegistered(agent: LocalRuntimeAgentRef): boolean {
  if (typeof agent.id !== 'number' || !Number.isFinite(agent.id)) return true
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT id FROM agents WHERE id = ? LIMIT 1').get(agent.id) as { id: number } | undefined
    return Boolean(row?.id)
  } catch {
    return true
  }
}

/** Drop queued CLI work for a deleted agent so later requests do not stall behind it. */
export function releaseAgentExecutionQueues(agent: LocalRuntimeAgentRef): void {
  const keys = new Set<string>()
  if (typeof agent.id === 'number' && Number.isFinite(agent.id)) {
    keys.add(`agent:${agent.id}`)
  }
  if (typeof agent.name === 'string' && agent.name.trim()) {
    keys.add(`agent-name:${agent.name.trim().toLowerCase()}`)
  }
  const sessionKey = getExistingAgentSessionKey(agent)
  const kind = getLocalSessionKindForFramework(agent.framework)
  if (sessionKey && kind) {
    keys.add(`session:${kind}:${sessionKey}`)
  }
  for (const key of keys) {
    agentSessionExecutionChains.set(key, RESOLVED_EMPTY_EXECUTION)
  }
}

export function getLocalSessionKindForFramework(framework: string | null | undefined): LocalSessionKind | null {
  const normalized = String(framework || '').trim().toLowerCase()
  if (!normalized) return null

  for (const adapter of Object.values(LOCAL_RUNTIME_EXECUTORS)) {
    if (adapter.frameworks.includes(normalized)) return adapter.kind
  }
  return null
}

export async function executeLocalSessionPrompt(
  kind: LocalSessionKind,
  sessionId: string,
  promptInput: string,
  options: LocalSessionExecutionOptions = {},
): Promise<LocalSessionExecutionResult> {
  const prompt = sanitizePrompt(promptInput)
  if (!prompt || prompt.length > 6000) {
    throw new Error('prompt is required (max 6000 chars)')
  }

  const adapter = LOCAL_RUNTIME_EXECUTORS[kind]
  if (!adapter) {
    throw new Error(`Unsupported local session kind: ${kind}`)
  }

  const result = await adapter.execute(sessionId, prompt, options)
  if (kind === 'claude-code') {
    scheduleClaudeSessionIndexRefresh()
  }
  if (kind === 'codex-cli') {
    invalidateCodexSessionScan()
    invalidateMergedSessionsCache()
  }
  if (!result.reply) {
    const recoveredReply = await recoverReplyFromTranscript(kind, result.sessionId || sessionId || null)
    if (recoveredReply) {
      return {
        sessionId: result.sessionId || sessionId || null,
        reply: recoveredReply,
      }
    }
    return {
      sessionId: result.sessionId || sessionId || null,
      reply: EMPTY_SESSION_REPLY,
    }
  }

  return result
}

async function recoverReplyFromTranscript(
  kind: LocalSessionKind,
  sessionId: string | null,
): Promise<string | null> {
  const sid = String(sessionId || '').trim()
  if (!sid) return null

  if (kind === 'claude-code') {
    return readLastClaudeSessionReply(sid)
  }

  if (kind !== 'codex-cli') {
    return null
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const page = readLocalSessionTranscriptPage('codex-cli', sid, { limit: 12 })
    const lastAssistant = [...page.messages].reverse().find((message) => {
      if (message.role !== 'assistant') return false
      return message.parts.some((part) => part.type === 'text' && part.text.trim())
    })
    if (lastAssistant) {
      const text = lastAssistant.parts
        .map((part) => (part.type === 'text' ? part.text : null))
        .filter(Boolean)
        .join('\n')
        .trim()
      if (text) return text
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  return null
}

async function executeBoundLocalAgentPromptCore(
  agentInput: LocalRuntimeAgentRef,
  prompt: string,
  kind: LocalSessionKind,
  workingDirectory: string | undefined,
  options: LocalAgentPromptExecutionOptions = {},
): Promise<LocalSessionExecutionResult> {
    if (!isAgentStillRegistered(agentInput)) {
      return EMPTY_EXECUTION_RESULT
    }

    const freshAgent = getFreshAgentRecord(agentInput)
    if (!isAgentStillRegistered(freshAgent)) {
      return EMPTY_EXECUTION_RESULT
    }
    const permissionMode = resolveLocalCliPermissionMode(freshAgent, options.permissionMode)
    const agentExecOptions = (cwd?: string, workerSessionId?: string | null) =>
      buildAgentExecutionOptions(freshAgent, cwd ?? workingDirectory, permissionMode, workerSessionId, kind, options)
    let activeSessionKey = getExistingAgentSessionKey(freshAgent)
    const roleHash = computeAgentRoleHash(freshAgent)
    const parsedConfig = getParsedLocalAgentSessionConfig(freshAgent)
    const autoProvisionAllowed = canAutoProvisionLocalSession(freshAgent, kind)
    const resolveCwd = (sessionKey?: string | null) =>
      resolveLocalExecutionWorkingDirectory(
        kind,
        sessionKey ?? activeSessionKey ?? null,
        freshAgent,
        workingDirectory,
      )

    if (activeSessionKey) {
      const bindingCheck = validateAgentSessionBinding(freshAgent, activeSessionKey, kind)
      if (!bindingCheck.ok) {
        logger.warn(
          { agentId: freshAgent.id, sessionKey: activeSessionKey, reason: bindingCheck.reason, framework: kind },
          'Stale or conflicting agent session binding; will reprovision on use',
        )
        persistAgentSessionBinding(freshAgent, {
          sessionKey: null,
          state: 'pending',
          roleHash,
          sessionBootstrapHash: null,
          sessionBootstrapState: 'pending',
          sessionBootstrapError: null,
          lastSessionError: bindingCheck.reason,
          status: 'idle',
        })
        activeSessionKey = null
      }
    }

    if (activeSessionKey) {
      const executionWorkingDirectory = resolveCwd(activeSessionKey)
      let shouldReprovisionAfterReset = false
      try {
        if (shouldBootstrapSession(freshAgent, roleHash)) {
          if (
            autoProvisionAllowed &&
            parsedConfig.mode === 'dedicated' &&
            parsedConfig.sessionBootstrapHash &&
            parsedConfig.sessionBootstrapHash !== roleHash
          ) {
            logger.info(
              { agentId: freshAgent.id, framework: kind },
              'Agent role definition changed; reprovisioning dedicated session',
            )
            persistAgentSessionBinding(freshAgent, {
              sessionKey: null,
              state: 'pending',
              roleHash,
              sessionBootstrapHash: null,
              sessionBootstrapState: 'pending',
              sessionBootstrapError: null,
              lastSessionError: null,
              status: 'idle',
            })
            shouldReprovisionAfterReset = true
          } else {
            const combinedBootstrap = buildSessionBootstrapWithUserPrompt(freshAgent, prompt, permissionMode)
            if (combinedBootstrap) {
              const bootstrapResult = await executeLocalSessionPrompt(
                kind,
                activeSessionKey,
                combinedBootstrap,
                agentExecOptions(executionWorkingDirectory, activeSessionKey),
              )
              persistAgentSessionBinding(freshAgent, {
                sessionKey: bootstrapResult.sessionId || activeSessionKey,
                state: 'ready',
                lastSessionError: null,
                roleHash,
                sessionBootstrapHash: roleHash,
                sessionBootstrapState: 'ready',
                sessionBootstrapError: null,
                status: 'idle',
                sessionProjectPath: executionWorkingDirectory,
              })
              return bootstrapResult
            }
            await bootstrapAgentSession(
              freshAgent,
              kind,
              activeSessionKey,
              roleHash,
              executionWorkingDirectory,
            )
          }
        }

        if (shouldReprovisionAfterReset) {
          throw new Error('Dedicated session reset requested and needs reprovisioning')
        }

        const reboundAgent = getFreshAgentRecord(freshAgent)
        const reboundSessionKey = getExistingAgentSessionKey(reboundAgent) || activeSessionKey
        if (!reboundSessionKey) {
          throw new Error('Agent session binding was reset and needs reprovisioning')
        }

        const reboundCheck = validateAgentSessionBinding(reboundAgent, reboundSessionKey, kind)
        if (!reboundCheck.ok) {
          throw new Error(`Agent session binding is invalid (${reboundCheck.reason}) and needs reprovisioning`)
        }

        const reboundCwd = resolveLocalExecutionWorkingDirectory(
          kind,
          reboundSessionKey,
          reboundAgent,
          workingDirectory,
        )
        const result = await executeLocalSessionPrompt(
          kind,
          reboundSessionKey,
          prompt,
          agentExecOptions(reboundCwd, reboundSessionKey),
        )
        persistAgentSessionBinding(reboundAgent, {
          sessionKey: result.sessionId || reboundSessionKey,
          state: 'ready',
          lastSessionError: null,
          roleHash,
          sessionBootstrapHash: roleHash,
          sessionBootstrapState: roleHash ? 'ready' : parsedConfig.sessionBootstrapState,
          sessionBootstrapError: null,
          status: 'idle',
          sessionProjectPath: reboundCwd,
        })
        return result
      } catch (error) {
        if (!autoProvisionAllowed || !isRecoverableSessionResumeError(error)) {
          throw error
        }

        logger.warn(
          { err: error, agentId: freshAgent.id, sessionKey: activeSessionKey, framework: kind },
          'Bound local session is invalid; reprovisioning dedicated session',
        )
        persistAgentSessionBinding(freshAgent, {
          sessionKey: null,
          state: 'pending',
          roleHash,
          sessionBootstrapHash: null,
          sessionBootstrapState: 'pending',
          sessionBootstrapError: null,
          lastSessionError: (error as Error)?.message || 'Bound session is invalid',
          status: 'idle',
        })
      }
    }

    if (!autoProvisionAllowed) {
      throw new Error('Recipient agent has no session key configured')
    }

    const adapter = LOCAL_RUNTIME_EXECUTORS[kind]
    if (!adapter.start) {
      persistAgentSessionBinding(freshAgent, {
        state: 'unsupported',
        roleHash,
        sessionBootstrapHash: null,
        sessionBootstrapState: 'unsupported',
        sessionBootstrapError: `Runtime ${kind} does not support dedicated session auto-provision`,
        lastSessionError: `Runtime ${kind} does not support dedicated session auto-provision`,
        status: 'error',
      })
      throw new Error(`Runtime ${kind} does not support dedicated session auto-provision`)
    }

    persistAgentSessionBinding(freshAgent, {
      state: 'provisioning',
      roleHash,
      sessionBootstrapHash: null,
      sessionBootstrapState: 'provisioning',
      sessionBootstrapError: null,
      lastSessionError: null,
      status: 'idle',
    })

    try {
      const needsRoleBootstrap = Boolean(buildSessionRolePreamble(freshAgent, permissionMode))
      const startupPrompt = needsRoleBootstrap
        ? (buildSessionBootstrapWithUserPrompt(freshAgent, prompt, permissionMode) || prompt)
        : prompt
      const provisionWorkingDirectory =
        kind === 'codex-cli'
          ? resolveCodexWorkingDirectoryForAgent(freshAgent)
          : resolveCwd(null)
      const result = await adapter.start(startupPrompt, {
        ...buildAgentExecutionOptions(freshAgent, provisionWorkingDirectory, permissionMode, null, kind, options),
        agentName: asTrimmedString(freshAgent.name),
        excludeAgentId: freshAgent.id ?? null,
      })

      if (!result.sessionId) {
        persistAgentSessionBinding(freshAgent, {
          state: 'broken',
          roleHash,
          sessionBootstrapHash: null,
          sessionBootstrapState: 'broken',
          sessionBootstrapError: `Runtime ${kind} executed the prompt but did not return a session id`,
          lastSessionError: `Runtime ${kind} executed the prompt but did not return a session id`,
          status: 'error',
        })
        throw new Error(`Runtime ${kind} executed the prompt but did not return a session id`)
      }

      persistAgentSessionBinding(freshAgent, {
        sessionKey: result.sessionId,
        state: 'ready',
        roleHash,
        sessionBootstrapHash: needsRoleBootstrap ? roleHash : null,
        sessionBootstrapState: 'ready',
        sessionBootstrapError: null,
        lastSessionError: null,
        status: 'idle',
        sessionProjectPath: provisionWorkingDirectory,
      })

      return result
    } catch (error) {
      persistAgentSessionBinding(freshAgent, {
        state: 'broken',
        roleHash,
        sessionBootstrapHash: null,
        sessionBootstrapState: 'broken',
        sessionBootstrapError: (error as Error)?.message || `Failed to provision ${kind} session`,
        lastSessionError: (error as Error)?.message || `Failed to provision ${kind} session`,
        status: 'error',
      })
      throw error
    }
}

/** Create a dedicated local CLI session (bootstrap only) and bind it to the agent. */
export async function provisionAgentDedicatedSession(
  agentInput: LocalRuntimeAgentRef,
): Promise<LocalSessionExecutionResult> {
  const freshAgent = getFreshAgentRecord(agentInput)
  if (!isAgentStillRegistered(freshAgent)) {
    throw new Error('Agent not found')
  }

  const kind = getLocalSessionKindForFramework(freshAgent.framework)
  if (!kind) {
    throw new Error('Agent framework is not a supported local runtime')
  }

  const existingSessionKey = getExistingAgentSessionKey(freshAgent)
  if (existingSessionKey) {
    return {
      sessionId: existingSessionKey,
      reply: 'Dedicated session is already bound to this agent.',
    }
  }

  const adapter = LOCAL_RUNTIME_EXECUTORS[kind]
  if (!adapter.start) {
    throw new Error(`Runtime ${kind} does not support dedicated session provisioning`)
  }

  const roleHash = computeAgentRoleHash(freshAgent)
  const kindForCwd = getLocalSessionKindForFramework(freshAgent.framework)
  const workingDirectory =
    kindForCwd === 'codex-cli'
      ? resolveCodexWorkingDirectoryForAgent(freshAgent)
      : getLocalRuntimeWorkingDirectory({
          workspacePath: freshAgent.workspace_path,
          config: freshAgent.config,
        })
  const permissionMode = resolveLocalCliPermissionMode(freshAgent)
  const bootstrapPrompt = buildSessionBootstrapPrompt(freshAgent, permissionMode)
    || [
      'E-Agent-Client dedicated-session setup.',
      'Reply with exactly: READY',
    ].join('\n')

  const executionKey = getSerializedAgentExecutionKey(freshAgent, kind)
  return runSerializedAgentExecution(executionKey, async () => {
    persistAgentSessionBinding(freshAgent, {
      state: 'provisioning',
      roleHash,
      sessionBootstrapHash: null,
      sessionBootstrapState: 'provisioning',
      sessionBootstrapError: null,
      lastSessionError: null,
      status: 'idle',
    })

    try {
      const result = await adapter.start!(bootstrapPrompt, {
        ...buildAgentExecutionOptions(freshAgent, workingDirectory),
        agentName: asTrimmedString(freshAgent.name),
        excludeAgentId: freshAgent.id ?? null,
      })

      if (!result.sessionId) {
        throw new Error(`Runtime ${kind} executed bootstrap but did not return a session id`)
      }

      const rebound = getFreshAgentRecord(freshAgent)
      persistAgentSessionBinding(rebound, {
        sessionKey: result.sessionId,
        state: 'ready',
        roleHash,
        sessionBootstrapHash: roleHash,
        sessionBootstrapState: 'ready',
        sessionBootstrapError: null,
        lastSessionError: null,
        status: 'idle',
        sessionProjectPath: workingDirectory,
      })

      return result
    } catch (error) {
      persistAgentSessionBinding(freshAgent, {
        state: 'broken',
        roleHash,
        sessionBootstrapHash: null,
        sessionBootstrapState: 'broken',
        sessionBootstrapError: (error as Error)?.message || `Failed to provision ${kind} session`,
        lastSessionError: (error as Error)?.message || `Failed to provision ${kind} session`,
        status: 'error',
      })
      throw error
    }
  })
}

export function agentRequiresDedicatedSession(agent: {
  framework?: unknown
  session_key?: unknown
  config?: unknown
} | null | undefined): boolean {
  if (String(agent?.session_key || '').trim()) return false
  const kind = getLocalSessionKindForFramework(
    typeof agent?.framework === 'string' ? agent.framework : null,
  )
  return kind != null
}

export function agentBlocksMessageUntilSessionReady(agent: {
  framework?: unknown
  session_key?: unknown
  config?: unknown
} | null | undefined): boolean {
  if (!agentRequiresDedicatedSession(agent)) return false
  const parsed = getParsedLocalAgentSessionConfig(agent as LocalRuntimeAgentRef)
  return parsed.mode === 'manual'
}

export function shouldAutoProvisionSessionOnCreate(agent: {
  framework?: unknown
  session_key?: unknown
  config?: unknown
} | null | undefined): boolean {
  if (String(agent?.session_key || '').trim()) return false
  const kind = getLocalSessionKindForFramework(
    typeof agent?.framework === 'string' ? agent.framework : null,
  )
  if (!kind) return false
  const parsed = getParsedLocalAgentSessionConfig(agent as LocalRuntimeAgentRef)
  if (parsed.runtimeManaged) return false
  return parsed.mode !== 'manual'
}

/** Queue dedicated-session bootstrap after agent create; returns immediately. */
export function enqueueProvisionAgentDedicatedSession(
  agentInput: LocalRuntimeAgentRef,
): { accepted: true } {
  const freshAgent = getFreshAgentRecord(agentInput)
  if (!shouldAutoProvisionSessionOnCreate(freshAgent)) {
    return { accepted: true }
  }

  const kind = getLocalSessionKindForFramework(freshAgent.framework)
  if (!kind) {
    return { accepted: true }
  }

  const executionKey = getSerializedAgentExecutionKey(freshAgent, kind)
  scheduleSerializedLocalPrompt(
    executionKey,
    kind,
    null,
    () => provisionAgentDedicatedSession(freshAgent),
  )

  return { accepted: true }
}

export async function executeBoundLocalAgentPrompt(
  agentInput: LocalRuntimeAgentRef,
  promptInput: string,
  options: LocalAgentPromptExecutionOptions = {},
): Promise<LocalSessionExecutionResult> {
  const prompt = sanitizePrompt(promptInput)
  if (!prompt || prompt.length > 6000) {
    throw new Error('prompt is required (max 6000 chars)')
  }

  const kind = getLocalSessionKindForFramework(agentInput.framework)
  if (!kind) {
    throw new Error('Agent framework is not a supported local runtime')
  }

  const overrideSessionKey = asTrimmedString(options.overrideSessionKey)
  const freshForCwd = getFreshAgentRecord(agentInput)
  const workingDirectory = resolveWorkingDirectory(options.workingDirectory)
    || (kind === 'codex-cli'
      ? resolveCodexWorkingDirectoryForAgent(freshForCwd)
      : getLocalRuntimeWorkingDirectory({
          workspacePath: freshForCwd.workspace_path,
          config: freshForCwd.config,
        }))

  if (overrideSessionKey) {
    return executeLocalSessionPrompt(
      kind,
      overrideSessionKey,
      prompt,
      buildAgentExecutionOptions(freshForCwd, workingDirectory, options.permissionMode, overrideSessionKey, kind, options),
    )
  }

  const executionKey = getSerializedAgentExecutionKey(agentInput, kind)
  return runSerializedAgentExecution(executionKey, () =>
    executeBoundLocalAgentPromptCore(agentInput, prompt, kind, workingDirectory, options),
  )
}

function notifyPromptLifecycle(
  kind: LocalSessionKind,
  sessionId: string | null | undefined,
  reason: string,
  pendingPrompt?: string,
  agentId?: number | null,
) {
  if (!sessionId && agentId == null) return
  notifySessionTranscriptUpdated(
    kind,
    sessionId || '',
    reason,
    {
      ...(pendingPrompt ? { pendingPrompt } : {}),
      ...(agentId != null ? { agentId } : {}),
    },
  )
}

function scheduleSerializedLocalPrompt(
  executionKey: string,
  kind: LocalSessionKind,
  sessionIdHint: string | null,
  operation: () => Promise<LocalSessionExecutionResult>,
  pendingPrompt?: string,
  agentId?: number | null,
): void {
  void executeSerializedLocalPrompt(
    executionKey,
    kind,
    sessionIdHint,
    operation,
    pendingPrompt,
    agentId,
  ).catch((error) => {
    logger.error({ err: error, kind, sessionIdHint, agentId }, 'Background local prompt failed')
    if (typeof agentId === 'number') {
      const rebound = getFreshAgentRecord({ id: agentId })
      const parsed = getParsedLocalAgentSessionConfig(rebound)
      if (parsed.state === 'broken' || parsed.lastSessionError) {
        eventBus.broadcast('agent.updated', {
          id: agentId,
          session_key: rebound.session_key ?? null,
          session_state: parsed.state,
          last_session_error: parsed.lastSessionError,
        })
      }
    }
  })
}

async function executeSerializedLocalPrompt(
  executionKey: string,
  kind: LocalSessionKind,
  sessionIdHint: string | null,
  operation: () => Promise<LocalSessionExecutionResult>,
  pendingPrompt?: string,
  agentId?: number | null,
): Promise<LocalSessionExecutionResult> {
  if (sessionIdHint || pendingPrompt) {
    notifyPromptLifecycle(kind, sessionIdHint, 'prompt_queued', pendingPrompt, agentId)
  }

  try {
    const result = await runSerializedAgentExecution(executionKey, operation)
    const sessionId = result.sessionId || sessionIdHint
    notifyPromptLifecycle(kind, sessionId, 'prompt_completed', undefined, agentId)
    if (result.sessionId && result.sessionId !== sessionIdHint) {
      notifyLocalSessionVisibility(kind, result.sessionId, 'session_provisioned', agentId)
    }
    return result
  } catch (error) {
    notifyPromptLifecycle(kind, sessionIdHint, 'prompt_failed', undefined, agentId)
    throw error
  }
}

/** Queue agent prompt; returns immediately. Reply appears in session transcript. */
export function enqueueBoundLocalAgentPrompt(
  agentInput: LocalRuntimeAgentRef,
  promptInput: string,
  options: LocalAgentPromptExecutionOptions = {},
): LocalPromptEnqueueResult {
  const prompt = sanitizePrompt(promptInput)
  if (!prompt || prompt.length > 6000) {
    throw new Error('prompt is required (max 6000 chars)')
  }

  const kind = getLocalSessionKindForFramework(agentInput.framework)
  if (!kind) {
    throw new Error('Agent framework is not a supported local runtime')
  }

  const overrideSessionKey = asTrimmedString(options.overrideSessionKey)
  const freshAgent = getFreshAgentRecord(agentInput)
  const workingDirectory = resolveWorkingDirectory(options.workingDirectory)
    || (kind === 'codex-cli'
      ? resolveCodexWorkingDirectoryForAgent(freshAgent)
      : getLocalRuntimeWorkingDirectory({
          workspacePath: freshAgent.workspace_path,
          config: freshAgent.config,
        }))
  const parsed = getParsedLocalAgentSessionConfig(freshAgent)
  const sessionKeyHint = overrideSessionKey || getExistingAgentSessionKey(freshAgent)

  if (typeof freshAgent.id === 'number') {
    persistAgentSessionBinding(freshAgent, {
      state: parsed.state,
      status: 'busy',
      roleHash: parsed.roleHash,
      sessionBootstrapHash: parsed.sessionBootstrapHash,
      sessionBootstrapState: parsed.sessionBootstrapState,
      sessionBootstrapError: parsed.sessionBootstrapError,
      lastSessionError: null,
    })
  }

  const executionKey = getSerializedAgentExecutionKey(freshAgent, kind)
  const executionCwd = overrideSessionKey
    ? resolveLocalExecutionWorkingDirectory(kind, overrideSessionKey, freshAgent, workingDirectory)
    : workingDirectory
  const operation = overrideSessionKey
    ? () => executeLocalSessionPrompt(
      kind,
      overrideSessionKey,
      prompt,
      buildAgentExecutionOptions(freshAgent, executionCwd, options.permissionMode, overrideSessionKey, kind, options),
    )
    : () => executeBoundLocalAgentPromptCore(freshAgent, prompt, kind, workingDirectory, options)

  scheduleSerializedLocalPrompt(executionKey, kind, sessionKeyHint, async () => {
    if (!isAgentStillRegistered(freshAgent)) {
      return EMPTY_EXECUTION_RESULT
    }
    try {
      return await operation()
    } finally {
      if (typeof freshAgent.id === 'number' && isAgentStillRegistered(freshAgent)) {
        const rebound = getFreshAgentRecord(freshAgent)
        const reboundParsed = getParsedLocalAgentSessionConfig(rebound)
        persistAgentSessionBinding(rebound, {
          state: reboundParsed.state,
          status: reboundParsed.state === 'broken' ? 'error' : 'idle',
          roleHash: reboundParsed.roleHash,
          sessionBootstrapHash: reboundParsed.sessionBootstrapHash,
          sessionBootstrapState: reboundParsed.sessionBootstrapState,
          sessionBootstrapError: reboundParsed.sessionBootstrapError,
          lastSessionError: reboundParsed.lastSessionError,
        })
      }
    }
  }, prompt, typeof freshAgent.id === 'number' ? freshAgent.id : null)

  return { accepted: true, sessionKey: sessionKeyHint, kind }
}

/** Queue continue on an existing session; returns immediately. */
export function enqueueLocalSessionPrompt(
  kind: LocalSessionKind,
  sessionId: string,
  promptInput: string,
  options: LocalSessionExecutionOptions = {},
): LocalPromptEnqueueResult {
  const prompt = sanitizePrompt(promptInput)
  if (!prompt || prompt.length > 6000) {
    throw new Error('prompt is required (max 6000 chars)')
  }
  ensureValidSessionId(sessionId)

  const agent = options.agent ? getFreshAgentRecord(options.agent) : null
  const executionKey = `session:${kind}:${sessionId}`
  const executionCwd = resolveLocalExecutionWorkingDirectory(
    kind,
    sessionId,
    agent,
    options.workingDirectory ?? undefined,
  )
  scheduleSerializedLocalPrompt(
    executionKey,
    kind,
    sessionId,
    () => executeLocalSessionPrompt(kind, sessionId, prompt, {
      ...options,
      agent,
      workingDirectory: executionCwd,
      workerSessionId: options.workerSessionId || sessionId,
      sessionKind: options.sessionKind || kind,
    }),
    prompt,
    agent?.id,
  )

  return { accepted: true, sessionKey: sessionId, kind }
}

/** Run a session continuation through the per-session queue and resolve after the CLI exits. */
export async function executeLocalSessionPromptAndWait(
  kind: LocalSessionKind,
  sessionId: string,
  promptInput: string,
  options: LocalSessionExecutionOptions = {},
): Promise<LocalSessionExecutionResult> {
  const prompt = sanitizePrompt(promptInput)
  if (!prompt || prompt.length > 6000) {
    throw new Error('prompt is required (max 6000 chars)')
  }
  ensureValidSessionId(sessionId)

  const agent = options.agent ? getFreshAgentRecord(options.agent) : null
  const executionCwd = resolveLocalExecutionWorkingDirectory(
    kind,
    sessionId,
    agent,
    options.workingDirectory ?? undefined,
  )
  return executeSerializedLocalPrompt(
    `session:${kind}:${sessionId}`,
    kind,
    sessionId,
    () => executeLocalSessionPrompt(kind, sessionId, prompt, {
      ...options,
      agent,
      workingDirectory: executionCwd,
      workerSessionId: options.workerSessionId || sessionId,
      sessionKind: options.sessionKind || kind,
    }),
    prompt,
    agent?.id,
  )
}
