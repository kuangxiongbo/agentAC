import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config'

export interface SyncableMemoryAgent {
  name: string
  dbSize: number
  totalChunks: number
  totalFiles: number
  files: Array<{ path: string; chunks: number; textSize: number }>
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
