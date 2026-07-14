import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDatabase } from './db'

export type StewardMemoryCategory = 'preference' | 'fact' | 'episode' | 'procedure'
export type StewardMemoryStatus = 'candidate' | 'approved' | 'rejected' | 'expired' | 'superseded'
export type StewardMemoryScope = 'goal' | 'project' | 'user' | 'steward' | 'client' | 'workspace' | 'tenant'

const CATEGORIES = new Set<StewardMemoryCategory>(['preference', 'fact', 'episode', 'procedure'])
const SCOPES = new Set<StewardMemoryScope>(['goal', 'project', 'user', 'steward', 'client', 'workspace', 'tenant'])
const STATUSES = new Set<StewardMemoryStatus>(['candidate', 'approved', 'rejected', 'expired', 'superseded'])

interface StewardMemoryRow {
  id: string
  workspace_id: number
  tenant_id: number | null
  scope_type: StewardMemoryScope
  scope_id: string
  category: StewardMemoryCategory
  content: string
  summary: string | null
  source_refs_json: string
  evidence_json: string
  confidence: number
  status: StewardMemoryStatus
  supersedes_id: string | null
  effective_at: number | null
  expires_at: number | null
  created_by_type: string
  reviewed_by: string | null
  created_at: number
  updated_at: number
}

export interface StewardMemoryView extends Omit<StewardMemoryRow, 'source_refs_json' | 'evidence_json'> {
  source_refs: string[]
  evidence: Array<Record<string, unknown>>
}

export interface CreateStewardMemoryInput {
  id?: string
  workspaceId: number
  tenantId?: number | null
  scopeType: StewardMemoryScope
  scopeId: string
  category: StewardMemoryCategory
  content: string
  summary?: string | null
  sourceRefs?: string[]
  evidence?: Array<Record<string, unknown>>
  confidence?: number
  status?: StewardMemoryStatus
  supersedesId?: string | null
  effectiveAt?: number | null
  expiresAt?: number | null
  createdByType: 'human_user' | 'steward_agent' | 'system'
}

function dbOr(database?: Database.Database) {
  return database ?? getDatabase()
}

function parseArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function view(row: StewardMemoryRow): StewardMemoryView {
  return {
    ...row,
    source_refs: parseArray<string>(row.source_refs_json),
    evidence: parseArray<Record<string, unknown>>(row.evidence_json),
  }
}

function validateInput(input: CreateStewardMemoryInput) {
  if (!SCOPES.has(input.scopeType)) throw new Error('Invalid memory scope_type')
  if (!input.scopeId.trim()) throw new Error('memory scope_id is required')
  if (!CATEGORIES.has(input.category)) throw new Error('Invalid memory category')
  if (!input.content.trim()) throw new Error('memory content is required')
  if (input.content.trim().length > 10_000) throw new Error('memory content is too long')
  if (input.status && !STATUSES.has(input.status)) throw new Error('Invalid memory status')
  const confidence = input.confidence ?? 0.5
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('Invalid memory confidence')
  if (input.expiresAt && input.effectiveAt && input.expiresAt <= input.effectiveAt) {
    throw new Error('memory expires_at must be after effective_at')
  }
}

export function createStewardMemory(
  input: CreateStewardMemoryInput,
  database?: Database.Database,
): StewardMemoryView {
  validateInput(input)
  const db = dbOr(database)
  const id = input.id ?? randomUUID()
  const now = Math.floor(Date.now() / 1000)
  if (input.supersedesId) {
    const prior = getStewardMemory(input.supersedesId, input.workspaceId, db)
    if (!prior) throw new Error('Superseded memory not found')
  }
  db.prepare(`
    INSERT INTO steward_memories (
      id, workspace_id, tenant_id, scope_type, scope_id, category, content,
      summary, source_refs_json, evidence_json, confidence, status,
      supersedes_id, effective_at, expires_at, created_by_type,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.workspaceId,
    input.tenantId ?? null,
    input.scopeType,
    input.scopeId.trim(),
    input.category,
    input.content.trim(),
    input.summary?.trim() || null,
    JSON.stringify([...new Set(input.sourceRefs ?? [])]),
    JSON.stringify(input.evidence ?? []),
    input.confidence ?? 0.5,
    input.status ?? 'candidate',
    input.supersedesId ?? null,
    input.effectiveAt ?? null,
    input.expiresAt ?? null,
    input.createdByType,
    now,
    now,
  )
  const created = getStewardMemory(id, input.workspaceId, db)
  if (!created) throw new Error('Memory not found after create')
  return created
}

export function getStewardMemory(
  id: string,
  workspaceId: number,
  database?: Database.Database,
): StewardMemoryView | null {
  const row = dbOr(database).prepare(`
    SELECT * FROM steward_memories WHERE id = ? AND workspace_id = ? LIMIT 1
  `).get(id, workspaceId) as StewardMemoryRow | undefined
  return row ? view(row) : null
}

export function listStewardMemories(input: {
  workspaceId: number
  tenantId?: number | null
  status?: StewardMemoryStatus
  category?: StewardMemoryCategory
  scopeType?: StewardMemoryScope
  scopeId?: string
  limit?: number
  offset?: number
}, database?: Database.Database): { memories: StewardMemoryView[]; total: number } {
  const db = dbOr(database)
  const clauses = ['workspace_id = ?']
  const params: Array<string | number> = [input.workspaceId]
  if (input.tenantId != null) {
    clauses.push('tenant_id IS ?')
    params.push(input.tenantId)
  }
  if (input.status) {
    clauses.push('status = ?')
    params.push(input.status)
  }
  if (input.category) {
    clauses.push('category = ?')
    params.push(input.category)
  }
  if (input.scopeType) {
    clauses.push('scope_type = ?')
    params.push(input.scopeType)
  }
  if (input.scopeId) {
    clauses.push('scope_id = ?')
    params.push(input.scopeId)
  }
  const where = clauses.join(' AND ')
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM steward_memories WHERE ${where}`).get(...params) as { count: number }).count
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const offset = Math.max(input.offset ?? 0, 0)
  const rows = db.prepare(`
    SELECT * FROM steward_memories WHERE ${where}
    ORDER BY updated_at DESC, created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as StewardMemoryRow[]
  return { memories: rows.map(view), total }
}

export function reviewStewardMemory(input: {
  id: string
  workspaceId: number
  action: 'approve' | 'reject' | 'correct' | 'expire' | 'supersede'
  reviewer: string
  content?: string
  summary?: string | null
  confidence?: number
  supersedesId?: string | null
  expiresAt?: number | null
}, database?: Database.Database): StewardMemoryView {
  const db = dbOr(database)
  const current = getStewardMemory(input.id, input.workspaceId, db)
  if (!current) throw new Error('Memory not found')
  if (input.confidence != null && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error('Invalid memory confidence')
  }
  const now = Math.floor(Date.now() / 1000)
  db.transaction(() => {
    if (input.action === 'correct') {
      if (current.status !== 'candidate') throw new Error('Only candidate memory can be corrected in place')
      const content = input.content?.trim()
      if (!content) throw new Error('Corrected memory content is required')
      db.prepare(`
        UPDATE steward_memories
        SET content = ?, summary = ?, confidence = COALESCE(?, confidence),
            reviewed_by = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?
      `).run(content, input.summary?.trim() || null, input.confidence ?? null, input.reviewer, now, current.id, current.workspace_id)
      return
    }
    const nextStatus: StewardMemoryStatus = input.action === 'approve'
      ? 'approved'
      : input.action === 'reject'
        ? 'rejected'
        : input.action === 'expire'
          ? 'expired'
          : 'superseded'
    if (input.action === 'supersede' && !input.supersedesId) throw new Error('supersedes_id is required')
    if (input.action === 'supersede') {
      const replacement = getStewardMemory(input.supersedesId!, input.workspaceId, db)
      if (!replacement) throw new Error('Replacement memory not found')
      db.prepare(`
        UPDATE steward_memories SET supersedes_id = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?
      `).run(current.id, now, replacement.id, input.workspaceId)
    }
    db.prepare(`
      UPDATE steward_memories
      SET status = ?, confidence = COALESCE(?, confidence), reviewed_by = ?,
          expires_at = COALESCE(?, expires_at), updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(nextStatus, input.confidence ?? null, input.reviewer, input.expiresAt ?? null, now, current.id, current.workspace_id)
  })()
  const updated = getStewardMemory(current.id, current.workspace_id, db)
  if (!updated) throw new Error('Memory not found after review')
  return updated
}
