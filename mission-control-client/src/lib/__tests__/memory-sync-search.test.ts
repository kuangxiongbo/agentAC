import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('memory-sync searchLocalMemory', () => {
  let tempDir: string | null = null
  const previousStateDir = process.env.OPENCLAW_STATE_DIR

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
    vi.resetModules()
  })

  it('finds OpenClaw sqlite chunks with Chinese phrase fragments', async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mc-memory-sync-'))
    const memoryDir = path.join(tempDir, 'memory')
    mkdirSync(memoryDir, { recursive: true })

    const dbPath = path.join(memoryDir, 'human-watch.sqlite')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE chunks (
        path TEXT,
        text TEXT
      );
    `)
    db.prepare(`INSERT INTO chunks (path, text) VALUES (?, ?)`).run(
      'human-watch/sop.md',
      '生产部署确认策略：小范围验证通过后，值守可以回复“继续”，但必须确认健康检查、版本号和回滚路径。',
    )
    db.close()

    process.env.OPENCLAW_STATE_DIR = tempDir
    vi.resetModules()
    const { searchLocalMemory } = await import('@/lib/memory-sync')

    const results = await searchLocalMemory('Worker 正在等待用户确认：是否继续部署生产？', { limit: 3 })

    expect(results).toEqual([
      expect.objectContaining({
        source: 'openclaw-sqlite',
        agentName: 'human-watch',
        path: 'human-watch/sop.md',
        snippet: expect.stringContaining('小范围验证'),
      }),
    ])
  })
})
