import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from '@/lib/config'
import { logger } from '@/lib/logger'

export type MessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export type TranscriptMessage = {
  role: 'user' | 'assistant' | 'system'
  parts: MessageContentPart[]
  timestamp?: string
}

export type LocalSessionTranscriptKind = 'claude-code' | 'codex-cli' | 'hermes'

/** One page of transcript loaded from disk (newest page first when `before` is omitted). */
export type TranscriptPageResult = {
  messages: TranscriptMessage[]
  hasMoreOlder: boolean
  /** Opaque cursor: `msg:<index>` for small logs, `<byteOffset>` for chunked JSONL reads. */
  nextOlderCursor: string | null
  sourceMtimeMs: number
  sourceSize: number
}

const TRANSCRIPT_PAGE_SCAN_BYTES = 8 * 1024 * 1024

function messageTimestampMs(message: TranscriptMessage): number {
  if (!message.timestamp) return 0
  const ts = new Date(message.timestamp).getTime()
  return Number.isFinite(ts) ? ts : 0
}

function listRecentFiles(root: string, ext: string, limit: number): string[] {
  if (!root || !fs.existsSync(root)) return []

  const files: Array<{ path: string; mtimeMs: number }> = []
  const stack = [root]

  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) continue

    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = path.join(dir, entry)
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        stack.push(full)
        continue
      }

      if (!stat.isFile() || !full.endsWith(ext)) continue
      files.push({ path: full, mtimeMs: stat.mtimeMs })
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return files.slice(0, Math.max(1, limit)).map((f) => f.path)
}

function deriveJsonlSessionId(filePath: string): string {
  const base = path.basename(filePath, '.jsonl')
  const match = base.match(/([0-9a-f]{8,}-[0-9a-f-]{8,})$/i)
  return match?.[1] || base
}

/** Locate a session JSONL by id without reading file bodies (path / filename match). */
function findSessionJsonlFile(root: string, sessionId: string): string | null {
  if (!root || !sessionId || !fs.existsSync(root)) return null

  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) continue

    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const full = path.join(dir, entry)
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        stack.push(full)
        continue
      }

      if (!stat.isFile() || !full.endsWith('.jsonl')) continue
      if (full.includes(sessionId) || deriveJsonlSessionId(full) === sessionId) {
        return full
      }
    }
  }

  return null
}

function fileSnippetContains(filePath: string, needle: string, bytes = 8192): boolean {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const read = fs.readSync(fd, buf, 0, bytes, 0)
      return buf.subarray(0, read).toString('utf-8').includes(needle)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

function listClaudeTranscriptCandidates(root: string, sessionId: string): string[] {
  const recent = listRecentFiles(root, '.jsonl', 80)
  const matched: string[] = []
  for (const file of recent) {
    if (file.includes(sessionId) || fileSnippetContains(file, sessionId)) {
      matched.push(file)
    }
  }
  return matched
}

const MAX_TRANSCRIPT_READ_BYTES = 6 * 1024 * 1024

function readFileStat(filePath: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = fs.statSync(filePath)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

function readFileRangeUtf8(filePath: string, startInclusive: number, endExclusive: number): string {
  const start = Math.max(0, startInclusive)
  const end = Math.max(start, endExclusive)
  const length = end - start
  if (length <= 0) return ''

  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, start)
    return buf.toString('utf-8')
  } finally {
    fs.closeSync(fd)
  }
}

function parseBeforeCursor(before?: string): { mode: 'byte' | 'msg'; value: number } | null {
  if (!before) return null
  if (before.startsWith('msg:')) {
    const value = Number.parseInt(before.slice(4), 10)
    return Number.isFinite(value) && value >= 0 ? { mode: 'msg', value } : null
  }
  const value = Number.parseInt(before, 10)
  return Number.isFinite(value) && value >= 0 ? { mode: 'byte', value } : null
}

function emptyTranscriptPage(filePath?: string): TranscriptPageResult {
  const stat = filePath ? readFileStat(filePath) : null
  return {
    messages: [],
    hasMoreOlder: false,
    nextOlderCursor: null,
    sourceMtimeMs: stat?.mtimeMs ?? 0,
    sourceSize: stat?.size ?? 0,
  }
}

function parseCodexJsonlLine(parsed: any, sessionId: string, out: TranscriptMessage[], matchedSession: { value: boolean }) {
  if (!matchedSession.value && parsed?.type === 'session_meta' && parsed?.payload?.id === sessionId) {
    matchedSession.value = true
  }
  if (!matchedSession.value) return

  const ts = typeof parsed?.timestamp === 'string' ? parsed.timestamp : undefined
  if (parsed?.type !== 'response_item') return

  const payload = parsed?.payload
  if (payload?.type !== 'message') return

  const role = payload?.role === 'assistant' ? 'assistant' as const : 'user' as const
  const parts: MessageContentPart[] = []
  if (typeof payload?.content === 'string') {
    const part = textPart(payload.content)
    if (part) parts.push(part)
  } else if (Array.isArray(payload?.content)) {
    for (const block of payload.content) {
      const blockType = String(block?.type || '')
      if (
        (blockType === 'text' || blockType === 'input_text' || blockType === 'output_text')
        && typeof block?.text === 'string'
      ) {
        const part = textPart(block.text)
        if (part) parts.push(part)
      }
    }
  }
  pushMessage(out, role, parts, ts)
}

function parseCodexLines(lines: string[], sessionId: string, pathIncludesSession: boolean): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  const matchedSession = { value: pathIncludesSession }
  for (const line of lines) {
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    parseCodexJsonlLine(parsed, sessionId, out, matchedSession)
  }
  return out
}

function readCodexTranscriptPage(
  sessionId: string,
  limit: number,
  before?: string,
  maxScanBytes = TRANSCRIPT_PAGE_SCAN_BYTES,
): TranscriptPageResult {
  const root = path.join(config.homeDir, '.codex', 'sessions')
  const file = findSessionJsonlFile(root, sessionId)
  if (!file) return emptyTranscriptPage()

  const stat = readFileStat(file)
  if (!stat) return emptyTranscriptPage()

  const cursor = parseBeforeCursor(before)

  if (stat.size <= MAX_TRANSCRIPT_READ_BYTES) {
    let raw = ''
    try {
      raw = fs.readFileSync(file, 'utf-8')
    } catch {
      return emptyTranscriptPage(file)
    }
    const all = parseCodexLines(raw.split('\n').filter(Boolean), sessionId, file.includes(sessionId))
      .sort((a, b) => messageTimestampMs(a) - messageTimestampMs(b))
    const endIndex = cursor?.mode === 'msg' ? cursor.value : all.length
    const startIndex = Math.max(0, endIndex - limit)
    return {
      messages: all.slice(startIndex, endIndex),
      hasMoreOlder: startIndex > 0,
      nextOlderCursor: startIndex > 0 ? `msg:${startIndex}` : null,
      sourceMtimeMs: stat.mtimeMs,
      sourceSize: stat.size,
    }
  }

  const endExclusive = cursor?.mode === 'byte' ? cursor.value : stat.size
  const scanStart = Math.max(0, endExclusive - maxScanBytes)
  let text = readFileRangeUtf8(file, scanStart, endExclusive)
  if (scanStart > 0) {
    const firstNl = text.indexOf('\n')
    if (firstNl >= 0) text = text.slice(firstNl + 1)
  }

  const chunkMessages = parseCodexLines(text.split('\n').filter(Boolean), sessionId, file.includes(sessionId))
    .sort((a, b) => messageTimestampMs(a) - messageTimestampMs(b))
  const page = chunkMessages.slice(-limit)

  return {
    messages: page,
    hasMoreOlder: scanStart > 0,
    nextOlderCursor: scanStart > 0 ? String(scanStart) : null,
    sourceMtimeMs: stat.mtimeMs,
    sourceSize: stat.size,
  }
}

/** Read full JSONL into memory (small files only). */
function readJsonlTextForTranscript(filePath: string): string {
  const stat = readFileStat(filePath)
  if (!stat || stat.size > MAX_TRANSCRIPT_READ_BYTES) return ''
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function pushMessage(
  list: TranscriptMessage[],
  role: TranscriptMessage['role'],
  parts: MessageContentPart[],
  timestamp?: string,
) {
  if (parts.length === 0) return
  list.push({ role, parts, timestamp })
}

function textPart(content: string | null, limit = 8000): MessageContentPart | null {
  const text = String(content || '').trim()
  if (!text) return null
  return { type: 'text', text: text.slice(0, limit) }
}

function readClaudeTranscript(sessionId: string, limit: number): TranscriptMessage[] {
  const root = path.join(config.claudeHome, 'projects')
  const files = listClaudeTranscriptCandidates(root, sessionId)
  const out: TranscriptMessage[] = []

  for (const file of files) {
    const raw = readJsonlTextForTranscript(file)
    if (!raw) continue

    const lines = raw.split('\n').filter(Boolean)
    for (const line of lines) {
      let parsed: any
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }

      if (parsed?.sessionId !== sessionId || parsed?.isSidechain) continue

      const ts = typeof parsed?.timestamp === 'string' ? parsed.timestamp : undefined
      if (parsed?.type === 'user') {
        const rawContent = parsed?.message?.content
        if (Array.isArray(rawContent) && rawContent.some((b: any) => b?.type === 'tool_result')) {
          const parts: MessageContentPart[] = []
          for (const block of rawContent) {
            if (block?.type === 'tool_result') {
              const resultContent = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: any) => c?.text || '').join('\n')
                  : ''
              if (resultContent.trim()) {
                parts.push({
                  type: 'tool_result',
                  toolUseId: block.tool_use_id || '',
                  content: resultContent.trim().slice(0, 8000),
                  isError: block.is_error === true,
                })
              }
            }
          }
          pushMessage(out, 'system', parts, ts)
        } else {
          const content = typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent.map((b: any) => b?.text || '').join('\n').trim()
              : ''
          const part = textPart(content)
          if (part) pushMessage(out, 'user', [part], ts)
        }
      } else if (parsed?.type === 'assistant') {
        const parts: MessageContentPart[] = []
        if (Array.isArray(parsed?.message?.content)) {
          for (const block of parsed.message.content) {
            if (block?.type === 'thinking' && typeof block?.thinking === 'string') {
              const thinking = block.thinking.trim()
              if (thinking) parts.push({ type: 'thinking', thinking: thinking.slice(0, 4000) })
            } else if (block?.type === 'text' && typeof block?.text === 'string') {
              const part = textPart(block.text)
              if (part) parts.push(part)
            } else if (block?.type === 'tool_use') {
              parts.push({
                type: 'tool_use',
                id: block.id || '',
                name: block.name || 'unknown',
                input: JSON.stringify(block.input || {}).slice(0, 500),
              })
            }
          }
        }
        pushMessage(out, 'assistant', parts, ts)
      }
    }
  }

  return out.slice().sort((a, b) => messageTimestampMs(a) - messageTimestampMs(b)).slice(-limit)
}

function readCodexTranscript(sessionId: string, limit: number): TranscriptMessage[] {
  return readCodexTranscriptPage(sessionId, limit).messages
}

type HermesMessageRow = {
  role: string
  content: string | null
  tool_call_id: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number
}

function epochSecondsToISO(epoch: number | null | undefined): string | undefined {
  if (!epoch || !Number.isFinite(epoch) || epoch <= 0) return undefined
  return new Date(epoch * 1000).toISOString()
}

export function readHermesTranscriptFromDbPath(dbPath: string, sessionId: string, limit: number): TranscriptMessage[] {
  if (!dbPath || !fs.existsSync(dbPath)) return []

  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })

    const rows = db.prepare(`
      SELECT role, content, tool_call_id, tool_calls, tool_name, timestamp
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(sessionId, Math.max(1, limit * 4)) as HermesMessageRow[]

    const messages: TranscriptMessage[] = []

    for (const row of rows) {
      const timestamp = epochSecondsToISO(row.timestamp)
      const parts: MessageContentPart[] = []

      if (row.role === 'assistant' && row.tool_calls) {
        try {
          const toolCalls = JSON.parse(row.tool_calls) as Array<Record<string, unknown>>
          for (const call of toolCalls) {
            const fn = call.function
            const fnRecord = fn && typeof fn === 'object' ? fn as Record<string, unknown> : null
            const name = typeof fnRecord?.name === 'string'
              ? fnRecord.name
              : typeof call.tool_name === 'string'
                ? String(call.tool_name)
                : typeof row.tool_name === 'string'
                  ? row.tool_name
                  : 'tool'
            const id = typeof call.call_id === 'string'
              ? call.call_id
              : typeof call.id === 'string'
                ? call.id
                : ''
            const input = typeof fnRecord?.arguments === 'string'
              ? fnRecord.arguments
              : JSON.stringify(fnRecord?.arguments || {})
            parts.push({
              type: 'tool_use',
              id,
              name,
              input: String(input).slice(0, 4000),
            })
          }
        } catch {
          // Ignore malformed tool call payloads and fall back to text content if present.
        }
      }

      const text = textPart(row.content)
      if (text) parts.push(text)

      if (row.role === 'tool') {
        pushMessage(messages, 'system', [{
          type: 'tool_result',
          toolUseId: row.tool_call_id || '',
          content: String(row.content || '').trim().slice(0, 8000),
          isError: row.content?.includes('"success": false') || row.content?.includes('"error"'),
        }], timestamp)
        continue
      }

      if (row.role === 'assistant') {
        pushMessage(messages, 'assistant', parts, timestamp)
        continue
      }

      if (row.role === 'user') {
        pushMessage(messages, 'user', parts, timestamp)
      }
    }

    return messages.slice(-limit)
  } catch (error) {
    logger.warn({ err: error, dbPath, sessionId }, 'Failed to read Hermes transcript')
    return []
  } finally {
    try { db?.close() } catch { /* noop */ }
  }
}

function readHermesTranscript(sessionId: string, limit: number): TranscriptMessage[] {
  const dbPath = path.join(config.homeDir, '.hermes', 'state.db')
  return readHermesTranscriptFromDbPath(dbPath, sessionId, limit)
}

export function readLocalSessionTranscript(kind: LocalSessionTranscriptKind, sessionId: string, limit: number): TranscriptMessage[] {
  return readLocalSessionTranscriptPage(kind, sessionId, { limit }).messages
}

export function readLocalSessionTranscriptPage(
  kind: LocalSessionTranscriptKind,
  sessionId: string,
  options: { limit: number; before?: string },
): TranscriptPageResult {
  const limit = Math.max(1, options.limit)
  if (kind === 'codex-cli') {
    return readCodexTranscriptPage(sessionId, limit, options.before)
  }
  if (kind === 'claude-code') {
    const messages = readClaudeTranscript(sessionId, limit)
    return {
      messages,
      hasMoreOlder: false,
      nextOlderCursor: null,
      sourceMtimeMs: 0,
      sourceSize: 0,
    }
  }
  const messages = readHermesTranscript(sessionId, limit)
  return {
    messages,
    hasMoreOlder: false,
    nextOlderCursor: null,
    sourceMtimeMs: 0,
    sourceSize: 0,
  }
}
