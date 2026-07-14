import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { createSupervisionGoal } from '@/lib/supervision-goals'
import {
  forgetStewardMemories,
  recordStewardMemoryUsageOutcome,
  searchStewardMemories,
} from '@/lib/steward-memory-search'
import { createStewardMemory, getStewardMemory } from '@/lib/steward-memories'

describe('steward memory search and feedback', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    db.prepare(`
      INSERT INTO sync_agent_index (
        client_id, client_name, local_agent_id, original_name, remote_name,
        role, status, framework, session_key, updated_at
      ) VALUES ('edge-a', 'Mac', 7, 'Steward', 'edge-a-Steward',
        'human-watch', 'idle', 'codex', 'steward-session', unixepoch())
    `).run()
    createSupervisionGoal({
      id: 'goal-search',
      workspaceId: 1,
      tenantId: 1,
      clientId: 'edge-a',
      stewardLocalAgentId: 7,
      title: 'Production release',
      objective: 'Verify and publish safely',
      successCriteria: [{ id: 'tests', text: 'Tests pass' }],
      budget: {
        max_tasks: 2,
        max_parallel_workers: 1,
        max_retries_per_task: 1,
        max_replans: 1,
        max_runtime_seconds: 3600,
        max_model_calls: 10,
      },
      createdBy: '2',
    }, db)
    createStewardMemory({
      id: 'memory-procedure',
      workspaceId: 1,
      tenantId: 1,
      scopeType: 'user',
      scopeId: '2',
      category: 'procedure',
      content: 'For production release, run the full test suite before publishing the image.',
      confidence: 0.8,
      status: 'approved',
      createdByType: 'human_user',
    }, db)
    createStewardMemory({
      id: 'memory-candidate',
      workspaceId: 1,
      tenantId: 1,
      scopeType: 'user',
      scopeId: '2',
      category: 'preference',
      content: 'Candidate memory must not be injected.',
      status: 'candidate',
      createdByType: 'steward_agent',
    }, db)
    createStewardMemory({
      id: 'memory-other-user',
      workspaceId: 1,
      tenantId: 1,
      scopeType: 'user',
      scopeId: '99',
      category: 'procedure',
      content: 'Production release for another user.',
      status: 'approved',
      createdByType: 'human_user',
    }, db)
  })

  afterEach(() => db.close())

  it('returns only approved, active and scope-matched memories and records usage', () => {
    const result = searchStewardMemories({
      workspaceId: 1,
      tenantId: 1,
      goalId: 'goal-search',
      query: 'production release tests',
      limit: 5,
      maxChars: 500,
    }, db)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({
      matched_scope: 'user:2',
      memory: { id: 'memory-procedure' },
    })
    expect(result.context).toContain('full test suite')
    expect(result.total_chars).toBeLessThanOrEqual(500)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM steward_memory_usage`).get() as { count: number }).count).toBe(1)
  })

  it('updates confidence from outcomes and expires repeatedly harmful memory', () => {
    const usageIds: string[] = []
    for (let index = 0; index < 3; index++) {
      usageIds.push(searchStewardMemories({
        workspaceId: 1,
        tenantId: 1,
        goalId: 'goal-search',
        query: 'production release tests',
      }, db).hits[0].usage_id)
    }
    for (const usageId of usageIds) {
      recordStewardMemoryUsageOutcome({
        usageId,
        workspaceId: 1,
        adopted: true,
        outcome: 'harmful',
        score: 0,
      }, db)
    }
    expect(getStewardMemory('memory-procedure', 1, db)?.confidence).toBeLessThan(0.5)
    expect(forgetStewardMemories({ workspaceId: 1 }, db).harmful).toBe(1)
    expect(getStewardMemory('memory-procedure', 1, db)?.status).toBe('expired')
  })

  it('expires approved memories at their configured expiry time', () => {
    createStewardMemory({
      id: 'memory-expiring',
      workspaceId: 1,
      tenantId: 1,
      scopeType: 'workspace',
      scopeId: '1',
      category: 'fact',
      content: 'Temporary environment fact.',
      status: 'approved',
      expiresAt: 100,
      createdByType: 'human_user',
    }, db)
    expect(forgetStewardMemories({ workspaceId: 1, nowSeconds: 100 }, db).expired).toBe(1)
    expect(getStewardMemory('memory-expiring', 1, db)?.status).toBe('expired')
  })
})
