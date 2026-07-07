import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config'
import { MEMORY_ALLOWED_PREFIXES, MEMORY_PATH } from './memory-path'
import { searchMemory } from './memory-search'

export interface SyncableMemoryAgent {
  name: string
  dbSize: number
  totalChunks: number
  totalFiles: number
  files: Array<{ path: string; chunks: number; textSize: number }>
}

export interface LocalMemorySearchResult {
  source: string
  agentName?: string | null
  path: string
  title?: string | null
  snippet: string
}

const memoryDbDir = config.openclawStateDir
  ? path.join(config.openclawStateDir, 'memory')
  : ''

function getAgentData(dbPath: string, agentName: string): SyncableMemoryAgent | null {
  try {
    const dbStat = statSync(dbPath)
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    let files: SyncableMemoryAgent['files'] = []
    let totalChunks = 0
    let totalFiles = 0

    try {
      const tableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'")
        .get() as { name?: string } | undefined

      if (tableCheck?.name) {
        const rows = db
          .prepare('SELECT path, COUNT(*) as chunks FROM chunks GROUP BY path ORDER BY chunks DESC')
          .all() as Array<{ path: string; chunks: number }>

        files = rows.map((row) => ({
          path: row.path || '(unknown)',
          chunks: row.chunks,
          textSize: 0,
        }))
        totalChunks = files.reduce((sum, file) => sum + file.chunks, 0)
        totalFiles = files.length
      }
    } finally {
      db.close()
    }

    return {
      name: agentName,
      dbSize: dbStat.size,
      totalChunks,
      totalFiles,
      files,
    }
  } catch {
    return null
  }
}

export function getSyncableMemoryAgents(): SyncableMemoryAgent[] {
  if (!memoryDbDir || !existsSync(memoryDbDir)) return []
  const entries = readdirSync(memoryDbDir).filter((file) => file.endsWith('.sqlite'))
  const agents: SyncableMemoryAgent[] = []

  for (const entry of entries) {
    const agentName = entry.replace(/\.sqlite$/, '')
    const dbPath = path.join(memoryDbDir, entry)
    const data = getAgentData(dbPath, agentName)
    if (data) agents.push(data)
  }

  return agents.sort((a, b) => b.totalChunks - a.totalChunks)
}

function queryTerms(query: string): string[] {
  const normalized = String(query || '')
    .replace(/[<>{}[\]()`"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return []
  const rawTokens = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu) ?? []
  const terms: string[] = []
  for (const token of rawTokens) {
    if (token.length < 2) continue
    if (/^[\p{Script=Han}]+$/u.test(token) && token.length > 4) {
      for (let index = 0; index <= token.length - 2 && terms.length < 16; index += 1) {
        terms.push(token.slice(index, index + 2))
      }
      continue
    }
    terms.push(token)
  }
  return Array.from(new Set(terms)).slice(0, 12)
}

function makeSnippet(text: string, terms: string[], maxChars = 260): string {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (value.length <= maxChars) return value
  const lower = value.toLowerCase()
  const idx = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((item) => item >= 0)
    .sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, idx - Math.floor(maxChars * 0.35))
  return `${start > 0 ? '...' : ''}${value.slice(start, start + maxChars)}${start + maxChars < value.length ? '...' : ''}`
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function searchSqliteMemoryDb(dbPath: string, agentName: string, query: string, limit: number): LocalMemorySearchResult[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return []

  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'")
      .get() as { name?: string } | undefined
    if (!tableCheck?.name) return []

    const columns = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>
    const names = new Set(columns.map((col) => col.name))
    const textCol = ['text', 'content', 'chunk', 'chunk_text', 'body'].find((name) => names.has(name))
    const pathCol = ['path', 'file_path', 'source', 'filename'].find((name) => names.has(name))
    if (!textCol && !pathCol) return []

    const clauses: string[] = []
    const params: string[] = []
    for (const term of terms) {
      const like = `%${term}%`
      if (textCol) {
        clauses.push(`${quoteIdent(textCol)} LIKE ?`)
        params.push(like)
      }
      if (pathCol) {
        clauses.push(`${quoteIdent(pathCol)} LIKE ?`)
        params.push(like)
      }
    }

    const selectText = textCol ? quoteIdent(textCol) : "''"
    const selectPath = pathCol ? quoteIdent(pathCol) : "'(memory)'"
    const rows = db
      .prepare(
        `SELECT ${selectPath} as path, ${selectText} as text
         FROM chunks
         WHERE ${clauses.join(' OR ')}
         LIMIT ?`,
      )
      .all(...params, limit) as Array<{ path: string | null; text: string | null }>

    return rows.map((row) => ({
      source: 'openclaw-sqlite',
      agentName,
      path: row.path || '(memory)',
      title: row.path || agentName,
      snippet: makeSnippet(row.text || row.path || '', terms),
    }))
  } finally {
    db.close()
  }
}

export async function searchLocalMemory(query: string, opts?: { limit?: number }): Promise<LocalMemorySearchResult[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 5, 1), 20)
  const results: LocalMemorySearchResult[] = []

  if (memoryDbDir && existsSync(memoryDbDir)) {
    const entries = readdirSync(memoryDbDir).filter((file) => file.endsWith('.sqlite'))
    for (const entry of entries) {
      if (results.length >= limit) break
      const agentName = entry.replace(/\.sqlite$/, '')
      try {
        results.push(
          ...searchSqliteMemoryDb(path.join(memoryDbDir, entry), agentName, query, limit - results.length),
        )
      } catch {
        // Skip unreadable or incompatible memory databases.
      }
    }
  }

  if (results.length < limit && MEMORY_PATH) {
    try {
      const response = await searchMemory(MEMORY_PATH, MEMORY_ALLOWED_PREFIXES, query, { limit: limit - results.length })
      results.push(
        ...response.results.map((result) => ({
          source: 'memory-fts',
          agentName: null,
          path: result.path,
          title: result.title,
          snippet: String(result.snippet || '').replace(/<\/?mark>/g, ''),
        })),
      )
    } catch {
      // FTS memory is optional for edge-side judge assistance.
    }
  }

  return results.slice(0, limit)
}
