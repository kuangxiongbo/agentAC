import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  createStewardMemory,
  getStewardMemory,
  listStewardMemories,
  reviewStewardMemory,
} from '@/lib/steward-memories'

describe('steward memories', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => db.close())

  it('stores layered candidate memory with source, evidence and expiry', () => {
    const memory = createStewardMemory({
      id: 'memory-1',
      workspaceId: 1,
      tenantId: 1,
      scopeType: 'project',
      scopeId: 'agent-center',
      category: 'procedure',
      content: 'Run the full test suite before publishing an image.',
      summary: 'Release verification procedure',
      sourceRefs: ['goal:release-1', 'task:42'],
      evidence: [{ type: 'test', passed: true }],
      confidence: 0.72,
      expiresAt: 2_100_000_000,
      createdByType: 'steward_agent',
    }, db)
    expect(memory).toMatchObject({
      status: 'candidate',
      scope_type: 'project',
      category: 'procedure',
      confidence: 0.72,
      source_refs: ['goal:release-1', 'task:42'],
    })
    expect(listStewardMemories({ workspaceId: 1, tenantId: 1, status: 'candidate' }, db).total).toBe(1)
  })

  it('supports correction, approval and immutable supersede history', () => {
    createStewardMemory({
      id: 'memory-old',
      workspaceId: 1,
      tenantId: 1,
      scopeType: 'user',
      scopeId: '2',
      category: 'preference',
      content: 'Prefer a ten second response window.',
      createdByType: 'steward_agent',
    }, db)
    const corrected = reviewStewardMemory({
      id: 'memory-old',
      workspaceId: 1,
      action: 'correct',
      reviewer: '2',
      content: 'Prefer a five second response window.',
      confidence: 0.9,
    }, db)
    expect(corrected).toMatchObject({ status: 'candidate', confidence: 0.9 })
    expect(reviewStewardMemory({
      id: 'memory-old',
      workspaceId: 1,
      action: 'approve',
      reviewer: '2',
    }, db).status).toBe('approved')

    createStewardMemory({
      id: 'memory-new',
      workspaceId: 1,
      tenantId: 1,
      scopeType: 'user',
      scopeId: '2',
      category: 'preference',
      content: 'Prefer a three second response window.',
      createdByType: 'human_user',
    }, db)
    reviewStewardMemory({
      id: 'memory-old',
      workspaceId: 1,
      action: 'supersede',
      reviewer: '2',
      supersedesId: 'memory-new',
    }, db)
    expect(getStewardMemory('memory-old', 1, db)?.status).toBe('superseded')
    expect(getStewardMemory('memory-new', 1, db)?.supersedes_id).toBe('memory-old')
  })

  it('can explicitly clear a legacy zero expiry during review', () => {
    createStewardMemory({
      id: 'memory-zero-expiry',
      workspaceId: 1,
      tenantId: 1,
      scopeType: 'project',
      scopeId: '1',
      category: 'fact',
      content: 'Reusable project fact.',
      expiresAt: 0,
      createdByType: 'steward_agent',
    }, db)

    const approved = reviewStewardMemory({
      id: 'memory-zero-expiry',
      workspaceId: 1,
      action: 'approve',
      reviewer: '2',
      expiresAt: null,
    }, db)

    expect(approved).toMatchObject({ status: 'approved', expires_at: null })
  })

  it('rejects invalid scopes, confidence and expiry ranges', () => {
    expect(() => createStewardMemory({
      workspaceId: 1,
      scopeType: 'workspace',
      scopeId: '1',
      category: 'fact',
      content: 'Invalid confidence',
      confidence: 2,
      createdByType: 'system',
    }, db)).toThrow('Invalid memory confidence')
    expect(() => createStewardMemory({
      workspaceId: 1,
      scopeType: 'goal',
      scopeId: 'goal-1',
      category: 'episode',
      content: 'Invalid expiry',
      effectiveAt: 200,
      expiresAt: 100,
      createdByType: 'system',
    }, db)).toThrow('expires_at must be after effective_at')
  })
})
