import fs from 'node:fs'
import path from 'node:path'
import { invalidateClaudeSessionSync } from './claude-sessions'
import { config } from './config'
import { eventBus } from './event-bus'
import { logger } from './logger'
import {
  type SessionRealtimePayload,
  type SessionRealtimeSource,
  sessionKindFromSource,
} from './session-realtime-events'
import { invalidateSessionCache } from './sessions'

type WatcherState = {
  started: boolean
  watchers: fs.FSWatcher[]
  timers: Map<string, NodeJS.Timeout>
}

const globalState = globalThis as typeof globalThis & {
  __sessionRealtimeWatcherState?: WatcherState
}

const state = globalState.__sessionRealtimeWatcherState ?? {
  started: false,
  watchers: [],
  timers: new Map<string, NodeJS.Timeout>(),
}
globalState.__sessionRealtimeWatcherState = state

const WATCH_DEBOUNCE_MS = 120

function scheduleBroadcast(eventType: 'session.list.updated' | 'session.transcript.updated', payload: SessionRealtimePayload) {
  const eventKey = payload.sessionId || payload.sessionKey || '*'
  const timerKey = `${eventType}:${payload.source}:${eventKey}`
  const current = state.timers.get(timerKey)
  if (current) clearTimeout(current)

  state.timers.set(
    timerKey,
    setTimeout(() => {
      state.timers.delete(timerKey)
      eventBus.broadcast(eventType, payload)
    }, WATCH_DEBOUNCE_MS)
  )
}

function emitListUpdate(source: SessionRealtimeSource, reason: string) {
  scheduleBroadcast('session.list.updated', {
    source,
    sessionKind: sessionKindFromSource(source),
    reason,
  })
}

function emitTranscriptUpdate(source: SessionRealtimeSource, reason: string, sessionId?: string) {
  scheduleBroadcast('session.transcript.updated', {
    source,
    sessionKind: sessionKindFromSource(source),
    sessionId,
    reason,
  })
}

function sessionIdFromJsonl(filePath: string): string | undefined {
  const base = path.basename(filePath, '.jsonl')
  if (!base) return undefined
  const match = base.match(/([0-9a-f]{8,}-[0-9a-f-]{8,})$/i)
  return match?.[1] || base
}

function startWatch(root: string, options: {
  recursive?: boolean
  filter: (fullPath: string) => boolean
  onRelevantChange: (fullPath: string) => void
}) {
  if (!root || !fs.existsSync(root)) return

  try {
    const watcher = fs.watch(root, { recursive: options.recursive ?? false }, (_eventType, filename) => {
      const fullPath = filename ? path.join(root, String(filename)) : root
      if (!options.filter(fullPath)) return
      options.onRelevantChange(fullPath)
    })
    state.watchers.push(watcher)
  } catch (err) {
    logger.warn({ err, root }, 'Failed to start session realtime watcher')
  }
}

export function ensureSessionRealtimeBridge() {
  if (state.started) return
  state.started = true

  const claudeRoot = path.join(config.claudeHome, 'projects')
  startWatch(claudeRoot, {
    recursive: true,
    filter: (fullPath) => fullPath.endsWith('.jsonl'),
    onRelevantChange: (fullPath) => {
      invalidateClaudeSessionSync()
      emitListUpdate('claude', 'file_changed')
      emitTranscriptUpdate('claude', 'file_changed', sessionIdFromJsonl(fullPath))
    },
  })

  const codexRoot = path.join(config.homeDir, '.codex', 'sessions')
  startWatch(codexRoot, {
    recursive: true,
    filter: (fullPath) => fullPath.endsWith('.jsonl'),
    onRelevantChange: (fullPath) => {
      emitListUpdate('codex', 'file_changed')
      emitTranscriptUpdate('codex', 'file_changed', sessionIdFromJsonl(fullPath))
    },
  })

  const hermesRoot = path.join(config.homeDir, '.hermes')
  startWatch(hermesRoot, {
    filter: (fullPath) => {
      const name = path.basename(fullPath)
      return name === 'state.db' || name === 'state.db-wal' || name === 'state.db-shm' || name === 'gateway.pid'
    },
    onRelevantChange: () => {
      emitListUpdate('hermes', 'db_changed')
      emitTranscriptUpdate('hermes', 'db_changed')
    },
  })

  const gatewayAgentsRoot = config.openclawStateDir
    ? path.join(config.openclawStateDir, 'agents')
    : ''
  startWatch(gatewayAgentsRoot, {
    recursive: true,
    filter: (fullPath) => {
      if (!fullPath.includes(`${path.sep}sessions${path.sep}`)) return false
      return fullPath.endsWith('sessions.json') || fullPath.endsWith('.jsonl')
    },
    onRelevantChange: (fullPath) => {
      invalidateSessionCache()
      emitListUpdate('gateway', 'file_changed')
      if (fullPath.endsWith('.jsonl')) {
        emitTranscriptUpdate('gateway', 'file_changed', sessionIdFromJsonl(fullPath))
      }
    },
  })
}
