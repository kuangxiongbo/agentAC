import crypto from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from './config'
import { runCommand } from './command'
import { isHermesInstalled, isHermesGatewayRunning, clearHermesDetectionCache } from './hermes-sessions'
import { logger } from './logger'
import {
  isValidInstallerSha256,
  resolvePinnedNpmRuntimeSpec,
  verifyInstallerSha256,
} from './runtime-install-security'
import {
  getMainAgentRuntimeMeta,
  type MainAgentRuntimeId,
} from './runtime-agents'

export type RuntimeId = MainAgentRuntimeId
export type DeploymentMode = 'local' | 'docker'

export interface RuntimeStatus {
  id: RuntimeId
  name: string
  description: string
  installed: boolean
  version: string | null
  running: boolean
  authRequired: boolean
  authHint: string
  authenticated: boolean
  installSupported: boolean
}

export interface InstallJob {
  id: string
  runtime: RuntimeId
  mode: DeploymentMode
  status: 'pending' | 'running' | 'success' | 'failed'
  output: string
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export interface RuntimeMeta {
  name: string
  description: string
  authRequired: boolean
  authHint: string
  installSupported: boolean
}

const RUNTIME_META: Record<RuntimeId, RuntimeMeta> = {
  openclaw: {
    name: 'OpenClaw',
    description: 'Multi-agent orchestration with gateway, sessions, and memory.',
    authRequired: false,
    authHint: '',
    installSupported: true,
  },
  hermes: {
    name: 'Hermes Agent',
    description: 'Self-improving AI agent with learning loop, skills, and multi-platform messaging.',
    authRequired: false,
    authHint: '',
    installSupported: true,
  },
  claude: {
    name: 'Claude Code',
    description: 'Anthropic CLI agent for software engineering tasks.',
    authRequired: true,
    authHint: 'Run "claude login" after install to authenticate.',
    installSupported: true,
  },
  codex: {
    name: 'Codex CLI',
    description: 'OpenAI CLI agent for code generation and editing.',
    authRequired: true,
    authHint: 'Run "codex auth" after install to authenticate.',
    installSupported: true,
  },
  cursor: {
    name: 'Cursor',
    description: 'Cursor IDE runtime for AI-assisted coding and local sessions.',
    authRequired: false,
    authHint: '',
    installSupported: false,
  },
  opencode: {
    name: 'OpenCode',
    description: 'OpenCode runtime for local coding and agent workflows.',
    authRequired: false,
    authHint: '',
    installSupported: false,
  },
}

export function getRuntimeMeta(id: RuntimeId): RuntimeMeta | undefined {
  return RUNTIME_META[id]
}

// ---------------------------------------------------------------------------
// In-memory job store — ephemeral, not persisted across restarts
// ---------------------------------------------------------------------------

const installJobs = new Map<string, InstallJob>()

// Clean up old jobs (>1 hour) periodically
function pruneJobs() {
  const cutoff = Date.now() - 3600_000
  for (const [id, job] of installJobs) {
    if (job.finishedAt && job.finishedAt < cutoff) installJobs.delete(id)
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function detectOpenClaw(): RuntimeStatus {
  const meta = RUNTIME_META.openclaw
  let installed = false
  let version: string | null = null
  let running = false

  // Check config file existence
  if (config.openclawConfigPath && existsSync(config.openclawConfigPath)) {
    installed = true
  }

  // Try to get version
  try {
    const result = require('node:child_process').spawnSync(
      config.openclawBin || 'openclaw',
      ['--version'],
      { stdio: 'pipe', timeout: 3000 }
    )
    if (result.status === 0) {
      installed = true
      version = (result.stdout?.toString() || '').trim() || null
    }
  } catch {
    // binary not found
  }

  // Check if gateway port is listening (simple sync check)
  try {
    const net = require('node:net')
    const socket = new net.Socket()
    socket.setTimeout(500)
    const connected = new Promise<boolean>((resolve) => {
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
      socket.connect(config.gatewayPort, config.gatewayHost)
    })
    // We can't await here synchronously, so just check config existence for "running"
    running = installed
  } catch {
    // ignore
  }

  return { id: 'openclaw', ...meta, installed, version, running, authenticated: true }
}

function detectHermes(): RuntimeStatus {
  const meta = RUNTIME_META.hermes
  const installed = isHermesInstalled()
  let version: string | null = null

  if (installed) {
    try {
      const candidates = [process.env.HERMES_BIN, 'hermes-agent', 'hermes'].filter(Boolean) as string[]
      for (const bin of candidates) {
        try {
          const result = require('node:child_process').spawnSync(bin, ['--version'], { stdio: 'pipe', timeout: 1200 })
          if (result.status === 0) {
            version = (result.stdout?.toString() || '').trim() || null
            break
          }
        } catch { continue }
      }
    } catch {
      // ignore
    }
  }

  const running = installed && isHermesGatewayRunning()
  return { id: 'hermes', ...meta, installed, version, running, authenticated: true }
}

function detectBinary(bins: string[], versionFlag = '--version'): { installed: boolean; version: string | null } {
  const { spawnSync } = require('node:child_process')
  for (const bin of bins) {
    try {
      const result = spawnSync(bin, [versionFlag], { stdio: 'pipe', timeout: 3000 })
      if (result.status === 0) {
        return { installed: true, version: (result.stdout?.toString() || '').trim() || null }
      }
    } catch { continue }
  }
  return { installed: false, version: null }
}

function detectClaude(): RuntimeStatus {
  const meta = RUNTIME_META.claude
  const { installed, version } = detectBinary(['claude'])

  // Check authentication: ~/.claude/ directory with credentials
  let authenticated = false
  if (installed) {
    try {
      const homedir = require('node:os').homedir()
      const path = require('node:path')
      authenticated = existsSync(path.join(homedir, '.claude', 'credentials.json'))
        || existsSync(path.join(homedir, '.claude', '.credentials'))
        || existsSync(path.join(homedir, '.claude', 'settings.json'))
    } catch {
      // ignore
    }
  }

  return { id: 'claude', ...meta, installed, version, running: false, authenticated }
}

function detectCodex(): RuntimeStatus {
  const meta = RUNTIME_META.codex
  const { installed, version } = detectBinary(['codex'])

  // Check authentication: codex stores config in ~/.codex/
  let authenticated = false
  if (installed) {
    try {
      const homedir = require('node:os').homedir()
      const path = require('node:path')
      authenticated = existsSync(path.join(homedir, '.codex', 'auth.json'))
        || existsSync(path.join(homedir, '.codex', 'config.json'))
    } catch {
      // ignore
    }
  }

  return { id: 'codex', ...meta, installed, version, running: false, authenticated }
}

function detectCursor(): RuntimeStatus {
  const meta = RUNTIME_META.cursor
  const { installed: binaryInstalled, version } = detectBinary(['cursor'])
  let installed = binaryInstalled

  if (!installed) {
    try {
      const homedir = require('node:os').homedir()
      const path = require('node:path')
      installed = [
        '/Applications/Cursor.app',
        path.join(homedir, 'Applications', 'Cursor.app'),
        path.join(homedir, 'Library', 'Application Support', 'Cursor'),
        path.join(homedir, '.cursor'),
      ].some((candidate) => existsSync(candidate))
    } catch {
      // ignore
    }
  }

  return { id: 'cursor', ...meta, installed, version, running: false, authenticated: installed }
}

function detectOpenCode(): RuntimeStatus {
  const meta = RUNTIME_META.opencode
  const { installed: binaryInstalled, version } = detectBinary(['opencode'])
  let installed = binaryInstalled

  if (!installed) {
    try {
      const homedir = require('node:os').homedir()
      const path = require('node:path')
      installed = [
        path.join(homedir, '.opencode'),
        path.join(homedir, '.config', 'opencode'),
        path.join(homedir, 'Library', 'Application Support', 'OpenCode'),
      ].some((candidate) => existsSync(candidate))
    } catch {
      // ignore
    }
  }

  return { id: 'opencode', ...meta, installed, version, running: false, authenticated: installed }
}

const DETECTORS: Record<RuntimeId, () => RuntimeStatus> = {
  openclaw: detectOpenClaw,
  hermes: detectHermes,
  claude: detectClaude,
  codex: detectCodex,
  cursor: detectCursor,
  opencode: detectOpenCode,
}

export function detectRuntime(id: RuntimeId): RuntimeStatus {
  const detector = DETECTORS[id]
  return detector ? detector() : {
    id,
    name: id,
    description: '',
    installed: false,
    version: null,
    running: false,
    authRequired: false,
    authHint: '',
    authenticated: false,
    installSupported: false,
  }
}

export function detectAllRuntimes(): RuntimeStatus[] {
  return Object.values(DETECTORS).map(fn => fn())
}

// ---------------------------------------------------------------------------
// Installation (background jobs)
// ---------------------------------------------------------------------------

export function startInstall(runtime: RuntimeId, mode: DeploymentMode): InstallJob {
  pruneJobs()
  const runtimeMeta = getMainAgentRuntimeMeta(runtime)
  if (!runtimeMeta?.installSupported) {
    throw new Error(`${runtime} does not support automatic installation in this environment`)
  }

  const job: InstallJob = {
    id: crypto.randomUUID(),
    runtime,
    mode,
    status: 'running',
    output: '',
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  }

  installJobs.set(job.id, job)

  if (mode === 'docker') {
    // Docker mode doesn't actually install — just returns the sidecar YAML
    job.output = generateDockerSidecar(runtime)
    job.status = 'success'
    job.finishedAt = Date.now()
    return job
  }

  // Local install — run in background
  const INSTALL_FNS: Record<RuntimeId, (job: InstallJob) => Promise<void>> = {
    openclaw: installOpenClawLocal,
    hermes: installHermesLocal,
    claude: installClaudeLocal,
    codex: installCodexLocal,
    cursor: installCursorLocal,
    opencode: installOpenCodeLocal,
  }
  const installFn = INSTALL_FNS[runtime] || installOpenClawLocal
  installFn(job).catch((err) => {
    job.status = 'failed'
    job.error = String(err?.message || err)
    job.finishedAt = Date.now()
    logger.error({ err, runtime }, 'Agent runtime install failed')
  })

  return job
}

// ---------------------------------------------------------------------------
// Install environment — Docker runs as non-root with HOME=/nonexistent
// ---------------------------------------------------------------------------

function getInstallEnv(): NodeJS.ProcessEnv {
  const path = require('node:path')
  const { mkdirSync } = require('node:fs')
  const dataDir = path.resolve(config.dataDir || '.data')
  const npmPrefix = path.join(dataDir, '.npm-global')
  const homedir = !process.env.HOME || process.env.HOME === '/nonexistent'
    ? dataDir
    : process.env.HOME

  try { mkdirSync(npmPrefix, { recursive: true }) } catch {}
  try { mkdirSync(path.join(homedir, '.npm'), { recursive: true }) } catch {}

  return {
    ...process.env,
    HOME: homedir,
    npm_config_prefix: npmPrefix,
    npm_config_cache: path.join(homedir, '.npm'),
    PATH: `${npmPrefix}/bin:${process.env.PATH || ''}`,
  }
}

async function runInstallCmd(cmd: string, args: string[], job: InstallJob): Promise<boolean> {
  const env = getInstallEnv()
  job.output += `> ${cmd} ${args.join(' ')}\n`
  try {
    const result = await runCommand(cmd, args, { timeoutMs: 300_000, env })
    if (result.stdout) job.output += result.stdout + '\n'
    if (result.stderr) job.output += result.stderr + '\n'
    return result.code === 0
  } catch (err: any) {
    job.output += `> Error: ${err?.message || 'command not found'}\n`
    return false
  }
}

async function downloadVerifiedInstaller(
  url: string,
  expectedSha256: string,
  job: InstallJob,
  env: NodeJS.ProcessEnv,
): Promise<{ scriptPath: string; tempDir: string } | null> {
  if (!isValidInstallerSha256(expectedSha256)) {
    job.output += '> SECURITY: Installer blocked because no valid SHA-256 digest is configured.\n'
    return null
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'mc-install-'))
  const scriptPath = join(tempDir, 'install.sh')
  try {
    const downloaded = await runCommand('curl', [
      '--fail', '--silent', '--show-error', '--location',
      '--proto', '=https', '--tlsv1.2', '--output', scriptPath, url,
    ], { timeoutMs: 60_000, env })
    if (downloaded.code !== 0) {
      job.output += `> Installer download failed (exit ${downloaded.code}).\n`
      rmSync(tempDir, { recursive: true, force: true })
      return null
    }

    const verified = verifyInstallerSha256(readFileSync(scriptPath), expectedSha256)
    if (!verified.valid) {
      job.output += `> SECURITY: Installer SHA-256 mismatch (received ${verified.actualSha256}).\n`
      rmSync(tempDir, { recursive: true, force: true })
      return null
    }
    job.output += `> Verified installer SHA-256: ${verified.actualSha256}\n`
    return { scriptPath, tempDir }
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true })
    job.output += `> Installer download failed: ${err instanceof Error ? err.message : String(err)}\n`
    return null
  }
}

async function installOpenClawLocal(job: InstallJob): Promise<void> {
  job.output += '> Installing OpenClaw...\n'
  const env = getInstallEnv()
  const reviewed = await downloadVerifiedInstaller(
    'https://get.openclaw.dev',
    process.env.MC_OPENCLAW_INSTALLER_SHA256 || '',
    job,
    env,
  )
  if (!reviewed) {
    job.status = 'failed'
    job.error = 'Installer download or SHA-256 verification failed'
    job.finishedAt = Date.now()
    return
  }
  try {
    const result = await runCommand('bash', [reviewed.scriptPath, '--non-interactive'], {
      timeoutMs: 300_000, env,
    })
    if (result.stdout) job.output += result.stdout + '\n'
    if (result.stderr) job.output += result.stderr + '\n'
    if (result.code === 0) {
      job.output += '\n> OpenClaw installed. Running initial setup...\n'
      try {
        const onboard = await runCommand('openclaw', ['onboard', '--non-interactive'], { timeoutMs: 60_000, env })
        if (onboard.stdout) job.output += onboard.stdout + '\n'
        if (onboard.stderr) job.output += onboard.stderr + '\n'
      } catch {
        job.output += '> Note: "openclaw onboard" skipped (run manually if needed).\n'
      }
      job.status = 'success'
      job.output += '\n> OpenClaw installed successfully.\n'
    } else {
      job.status = 'failed'
      job.error = `Install exited with code ${result.code}`
      job.output += `\n> Install failed (exit code ${result.code}).\n`
    }
  } catch (err: any) {
    job.status = 'failed'
    job.error = err?.message || 'Unknown error'
    job.output += `\n> Error: ${job.error}\n`
  } finally {
    rmSync(reviewed.tempDir, { recursive: true, force: true })
  }
  job.finishedAt = Date.now()
}

async function installHermesLocal(job: InstallJob): Promise<void> {
  job.output += '> Installing Hermes Agent via official installer...\n'
  const env = getInstallEnv()
  const reviewed = await downloadVerifiedInstaller(
    'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh',
    process.env.MC_HERMES_INSTALLER_SHA256 || '',
    job,
    env,
  )
  if (!reviewed) {
    job.status = 'failed'
    job.error = 'Installer download or SHA-256 verification failed'
    job.finishedAt = Date.now()
    return
  }
  try {
    const result = await runCommand('bash', [reviewed.scriptPath, '--skip-setup'], {
      timeoutMs: 600_000, env,
    })
    if (result.stdout) job.output += result.stdout + '\n'
    if (result.stderr) job.output += result.stderr + '\n'
    if (result.code === 0) {
      job.status = 'success'
      job.output += '\n> Hermes Agent installed successfully.\n'
      job.output += '> Run "hermes" to start chatting, or "hermes setup" for full configuration.\n'
      clearHermesDetectionCache()
    } else {
      job.status = 'failed'
      job.error = `Installer exited with code ${result.code}`
      job.output += `\n> Install failed (exit code ${result.code}).\n`
    }
  } catch (err: any) {
    job.status = 'failed'
    job.error = err?.message || 'Unknown error'
    job.output += `\n> Error: ${job.error}\n`
  } finally {
    rmSync(reviewed.tempDir, { recursive: true, force: true })
  }
  job.finishedAt = Date.now()
}

async function installClaudeLocal(job: InstallJob): Promise<void> {
  job.output += '> Installing Claude Code...\n'
  const pinned = resolvePinnedNpmRuntimeSpec('claude')
  if ('error' in pinned) {
    job.status = 'failed'
    job.error = pinned.error
    job.output += `> SECURITY: ${pinned.error}\n`
  } else if (await runInstallCmd('npm', ['install', '-g', pinned.spec], job)) {
    job.status = 'success'
    job.output += '\n> Claude Code installed successfully.\n'
    job.output += '> Run "claude login" to authenticate.\n'
  } else {
    job.status = 'failed'
    job.error = 'npm install failed — see output above'
  }
  job.finishedAt = Date.now()
}

async function installCodexLocal(job: InstallJob): Promise<void> {
  job.output += '> Installing Codex CLI...\n'
  const pinned = resolvePinnedNpmRuntimeSpec('codex')
  if ('error' in pinned) {
    job.status = 'failed'
    job.error = pinned.error
    job.output += `> SECURITY: ${pinned.error}\n`
  } else if (await runInstallCmd('npm', ['install', '-g', pinned.spec], job)) {
    job.status = 'success'
    job.output += '\n> Codex CLI installed successfully.\n'
    job.output += '> Run "codex auth" to authenticate.\n'
  } else {
    job.status = 'failed'
    job.error = 'npm install failed — see output above'
  }
  job.finishedAt = Date.now()
}

async function installCursorLocal(job: InstallJob): Promise<void> {
  job.status = 'failed'
  job.error = 'Cursor automatic installation is not supported; install it through a reviewed local channel'
  job.output += `> SECURITY: ${job.error}\n`
  job.finishedAt = Date.now()
}

async function installOpenCodeLocal(job: InstallJob): Promise<void> {
  job.status = 'failed'
  job.error = 'OpenCode automatic installation is not supported; install it through a reviewed local channel'
  job.output += `> SECURITY: ${job.error}\n`
  job.finishedAt = Date.now()
}

export function getInstallJob(id: string): InstallJob | null {
  return installJobs.get(id) ?? null
}

export function getActiveJobs(): InstallJob[] {
  pruneJobs()
  return [...installJobs.values()]
}

// ---------------------------------------------------------------------------
// Docker sidecar templates
// ---------------------------------------------------------------------------

export function generateDockerSidecar(runtime: RuntimeId): string {
  if (runtime === 'openclaw') {
    return `  # OpenClaw Gateway sidecar
  openclaw-gateway:
    image: ghcr.io/openclaw/openclaw:latest
    container_name: openclaw-gateway
    ports:
      - "\${OPENCLAW_GATEWAY_PORT:-18789}:18789"
    volumes:
      - openclaw-data:/root/.openclaw
    networks:
      - mc-net
    restart: unless-stopped

# Add to volumes section:
#   openclaw-data:`
  }

  if (runtime === 'cursor' || runtime === 'opencode' || runtime === 'claude' || runtime === 'codex') {
    return `# ${RUNTIME_META[runtime].name} runs locally and does not have a bundled sidecar template.
# Use the local install flow or provide a custom install command via environment settings.`
  }

  return `  # Hermes Agent sidecar
  hermes-agent:
    image: ghcr.io/nousresearch/hermes-agent:latest
    container_name: hermes-agent
    environment:
      - MC_URL=http://mission-control:\${PORT:-3000}
      - MC_API_KEY=\${API_KEY:-}
    volumes:
      - hermes-data:/root/.hermes
    networks:
      - mc-net
    restart: unless-stopped

# Add to volumes section:
#   hermes-data:`
}
