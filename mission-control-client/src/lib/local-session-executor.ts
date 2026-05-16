import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { scanCodexSessions } from './codex-sessions'
import { runCommand } from './command'
import { getDatabase } from './db'
import { logger } from './logger'

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

interface LocalSessionExecutionOptions {
  workingDirectory?: string | null
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
    options: LocalSessionExecutionOptions & { agentName?: string | null },
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

function getExistingAgentSessionKey(agent: LocalRuntimeAgentRef | null | undefined): string | null {
  const direct = asTrimmedString(agent?.session_key)
  if (direct) return direct
  return getParsedLocalAgentSessionConfig(agent).primarySessionKey
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

function buildSessionBootstrapPrompt(agent: LocalRuntimeAgentRef): string | null {
  const roleDefinition = buildAgentRoleDefinition(agent)
  if (!roleDefinition) return null

  return [
    'E-Agent-Client dedicated-session bootstrap.',
    'This is not a user task.',
    'Adopt and preserve the following agent role definition for future turns in this session.',
    'Treat it as your standing charter until E-Agent-Client explicitly replaces it.',
    '',
    roleDefinition,
    '',
    'Operating rules:',
    '1. Stay within this role and its scope.',
    '2. Keep responses aligned with the role definition unless a higher-priority system instruction overrides it.',
    '3. If a request conflicts with the role, explain the conflict instead of silently changing identity.',
    '',
    'Reply with exactly: READY',
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

    db.prepare(`
      UPDATE agents
      SET session_key = ?, config = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextSessionKey,
      configJson,
      input.status ?? (input.state === 'broken' ? 'error' : 'idle'),
      now,
      agent.id,
    )
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

function buildCommandEnv(): NodeJS.ProcessEnv {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const existing = process.env[pathKey] || ''
  const prefixes = ['/opt/homebrew/bin', '/usr/local/bin'].filter((p) => existsSync(p))
  const merged = [...prefixes, ...existing.split(path.delimiter).filter(Boolean)].join(path.delimiter)
  return { ...process.env, [pathKey]: merged }
}

function buildCommandOptions(options: LocalSessionExecutionOptions) {
  const commandOptions: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv } = {
    timeoutMs: EXECUTION_TIMEOUT_MS,
    env: buildCommandEnv(),
  }
  const cwd = resolveWorkingDirectory(options.workingDirectory)
  if (cwd) commandOptions.cwd = cwd
  return commandOptions
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
  const bootstrapPrompt = buildSessionBootstrapPrompt(agent)
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
    await executeLocalSessionPrompt(kind, sessionId, bootstrapPrompt, { workingDirectory })
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
      const result = await runCommand('claude', ['--print', '--resume', sessionId, prompt], buildCommandOptions(options))
      return {
        sessionId,
        reply: (result.stdout || '').trim() || (result.stderr || '').trim(),
      }
    },
    async start(prompt, options) {
      const sessionId = randomUUID()
      const result = await runCommand(
        'claude',
        ['--print', '--session-id', sessionId, prompt],
        buildCommandOptions(options),
      )
      return {
        sessionId,
        reply: (result.stdout || '').trim() || (result.stderr || '').trim(),
      }
    },
  },
  'codex-cli': {
    kind: 'codex-cli',
    frameworks: ['codex', 'codex-cli', 'openai'],
    async execute(sessionId, prompt, options) {
      ensureValidSessionId(sessionId)
      const outputPath = path.join('/tmp', `mc-codex-last-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      try {
        await runCommand(resolveCodexBin(), ['exec', 'resume', sessionId, prompt, '--skip-git-repo-check', '-o', outputPath], buildCommandOptions(options))
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

      return { sessionId, reply }
    },
    async start(prompt, options) {
      const outputPath = path.join('/tmp', `mc-codex-start-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
      const knownSessionIds = new Set(scanCodexSessions(200).map((session) => session.sessionId))
      const startedAt = Date.now()

      let commandResult: { stdout: string; stderr: string } | null = null
      try {
        commandResult = await runCommand(
          resolveCodexBin(),
          ['exec', prompt, '--skip-git-repo-check', '--json', '-o', outputPath],
          buildCommandOptions(options),
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

      if (!sessionId) {
        const workingDirectory = resolveWorkingDirectory(options.workingDirectory) || null
        const detected = scanCodexSessions(200)
        const candidate = detected.find((session) => {
          if (knownSessionIds.has(session.sessionId)) return false
          if (!session.lastMessageAt) return false
          const lastMessageAt = new Date(session.lastMessageAt).getTime()
          if (lastMessageAt < startedAt - 5_000) return false
          if (workingDirectory && session.projectPath && path.resolve(session.projectPath) !== workingDirectory) return false
          return true
        }) || detected.find((session) => {
          if (!session.lastMessageAt) return false
          const lastMessageAt = new Date(session.lastMessageAt).getTime()
          if (lastMessageAt < startedAt - 5_000) return false
          if (workingDirectory && session.projectPath && path.resolve(session.projectPath) !== workingDirectory) return false
          return true
        })
        sessionId = candidate?.sessionId || null
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
  if (!result.reply) {
    return {
      sessionId: result.sessionId || sessionId || null,
      reply: 'Session continued, but no text response was returned.',
    }
  }

  return result
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
  const workingDirectory = resolveWorkingDirectory(options.workingDirectory)
    || getLocalRuntimeWorkingDirectory({
      workspacePath: agentInput.workspace_path,
      config: agentInput.config,
    })

  if (overrideSessionKey) {
    return executeLocalSessionPrompt(kind, overrideSessionKey, prompt, { workingDirectory })
  }

  const executionKey = getSerializedAgentExecutionKey(agentInput, kind)
  return runSerializedAgentExecution(executionKey, async () => {
    const freshAgent = getFreshAgentRecord(agentInput)
    const existingSessionKey = getExistingAgentSessionKey(freshAgent)
    const roleHash = computeAgentRoleHash(freshAgent)
    const parsedConfig = getParsedLocalAgentSessionConfig(freshAgent)
    const autoProvisionAllowed = canAutoProvisionLocalSession(freshAgent, kind)

    if (existingSessionKey) {
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
            await bootstrapAgentSession(
              freshAgent,
              kind,
              existingSessionKey,
              roleHash,
              workingDirectory,
            )
          }
        }

        if (shouldReprovisionAfterReset) {
          throw new Error('Dedicated session reset requested and needs reprovisioning')
        }

        const reboundAgent = getFreshAgentRecord(freshAgent)
        const reboundSessionKey = getExistingAgentSessionKey(reboundAgent)
        if (!reboundSessionKey) {
          throw new Error('Agent session binding was reset and needs reprovisioning')
        }

        const result = await executeLocalSessionPrompt(
          kind,
          reboundSessionKey,
          prompt,
          { workingDirectory },
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
        })
        return result
      } catch (error) {
        if (!autoProvisionAllowed || !isRecoverableSessionResumeError(error)) {
          throw error
        }

        logger.warn(
          { err: error, agentId: freshAgent.id, sessionKey: existingSessionKey, framework: kind },
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
      const startupPrompt = buildSessionBootstrapPrompt(freshAgent) || prompt
      const result = await adapter.start(startupPrompt, {
        workingDirectory,
        agentName: asTrimmedString(freshAgent.name),
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

      if (buildSessionBootstrapPrompt(freshAgent)) {
        persistAgentSessionBinding(freshAgent, {
          sessionKey: result.sessionId,
          state: 'ready',
          roleHash,
          sessionBootstrapHash: roleHash,
          sessionBootstrapState: 'ready',
          sessionBootstrapError: null,
          lastSessionError: null,
          status: 'idle',
        })

        const nextResult = await executeLocalSessionPrompt(
          kind,
          result.sessionId,
          prompt,
          { workingDirectory },
        )
        persistAgentSessionBinding(freshAgent, {
          sessionKey: nextResult.sessionId || result.sessionId,
          state: 'ready',
          roleHash,
          sessionBootstrapHash: roleHash,
          sessionBootstrapState: 'ready',
          sessionBootstrapError: null,
          lastSessionError: null,
          status: 'idle',
        })
        return nextResult
      }

      persistAgentSessionBinding(freshAgent, {
        sessionKey: result.sessionId,
        state: 'ready',
        roleHash,
        sessionBootstrapHash: null,
        sessionBootstrapState: 'ready',
        sessionBootstrapError: null,
        lastSessionError: null,
        status: 'idle',
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
