import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, statSync } from 'fs'
import path from 'path'
import { getDatabase } from '@/lib/db'

export const AGENT_WORKSPACES_SETTINGS_KEY = 'general.agent_workspaces'

export interface AgentWorkspace {
  id: string
  name: string
  path: string
  description?: string
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

type StoredWorkspace = {
  id: string
  name: string
  path: string
  description?: string
  is_default?: boolean
  created_at: number
  updated_at: number
}

function normalizePath(value: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  return path.normalize(trimmed.replace(/\\/g, '/'))
}

export function isAbsoluteWorkspacePath(value: string): boolean {
  const trimmed = String(value || '').trim()
  if (!trimmed) return false
  return path.isAbsolute(trimmed)
}

/** Reject bare filesystem roots (/, C:\) — cannot be used as workspace paths. */
export function isUnsafeWorkspaceRoot(value: string): boolean {
  const normalized = normalizePath(value)
  if (!isAbsoluteWorkspacePath(normalized)) return true
  const withoutTrailing = normalized.replace(/[\\/]+$/, '') || normalized
  const parsed = path.parse(withoutTrailing)
  if (!parsed.root) return true
  const relative = path.relative(parsed.root, withoutTrailing)
  return relative === '' || relative === '.'
}

/**
 * Ensure the workspace directory exists. When createIfMissing is true, creates parent dirs (mkdir -p).
 */
export function ensureWorkspaceDirectory(
  value: string,
  createIfMissing = true,
): { path: string; created: boolean } {
  const normalizedPath = normalizePath(value)
  if (!isAbsoluteWorkspacePath(normalizedPath)) {
    throw new Error('Workspace path must be an absolute directory path')
  }
  if (isUnsafeWorkspaceRoot(normalizedPath)) {
    throw new Error('Cannot use a filesystem root as a workspace path')
  }

  if (existsSync(normalizedPath)) {
    const stat = statSync(normalizedPath)
    if (!stat.isDirectory()) {
      throw new Error('Path exists but is not a directory')
    }
    return { path: normalizedPath, created: false }
  }

  if (!createIfMissing) {
    throw new Error('Directory does not exist. Enable "create if missing" or create it manually.')
  }

  try {
    mkdirSync(normalizedPath, { recursive: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create directory'
    throw new Error(`Could not create directory: ${message}`)
  }

  return { path: normalizedPath, created: true }
}

function fromStored(row: StoredWorkspace): AgentWorkspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    description: row.description || undefined,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toStored(workspace: AgentWorkspace): StoredWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    description: workspace.description,
    is_default: workspace.isDefault,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
  }
}

function readStoredRows(): StoredWorkspace[] {
  const db = getDatabase()
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(AGENT_WORKSPACES_SETTINGS_KEY) as { value: string } | undefined
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
  } catch {
    return []
  }
}

function writeStoredRows(rows: StoredWorkspace[], updatedBy = 'system'): void {
  const db = getDatabase()
  const payload = JSON.stringify(rows)
  db.prepare(`
    INSERT INTO settings (key, value, description, category, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_by = excluded.updated_by,
      updated_at = unixepoch()
  `).run(
    AGENT_WORKSPACES_SETTINGS_KEY,
    payload,
    'Registered local agent workspaces (name + directory path)',
    'general',
    updatedBy,
  )
}

export function listAgentWorkspaces(): AgentWorkspace[] {
  return readStoredRows()
    .map(fromStored)
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export function getAgentWorkspace(id: string): AgentWorkspace | null {
  return listAgentWorkspaces().find((ws) => ws.id === id) ?? null
}

export function getDefaultAgentWorkspace(): AgentWorkspace | null {
  return listAgentWorkspaces().find((ws) => ws.isDefault) ?? null
}

export function createAgentWorkspace(input: {
  name: string
  path: string
  description?: string
  isDefault?: boolean
  createIfMissing?: boolean
}): { workspace: AgentWorkspace; directoryCreated: boolean } {
  const name = String(input.name || '').trim()
  if (!name) throw new Error('Workspace name is required')

  const { path: normalizedPath, created: directoryCreated } = ensureWorkspaceDirectory(
    input.path,
    input.createIfMissing !== false,
  )

  const rows = readStoredRows()
  const duplicate = rows.find(
    (row) => row.name.toLowerCase() === name.toLowerCase() || row.path === normalizedPath,
  )
  if (duplicate) throw new Error('A workspace with the same name or path already exists')

  const now = Math.floor(Date.now() / 1000)
  const workspace: AgentWorkspace = {
    id: randomUUID(),
    name,
    path: normalizedPath,
    description: input.description?.trim() || undefined,
    isDefault: Boolean(input.isDefault),
    createdAt: now,
    updatedAt: now,
  }

  let next = [...rows, toStored(workspace)]
  if (workspace.isDefault) {
    next = next.map((row) => ({ ...row, is_default: row.id === workspace.id }))
  }
  writeStoredRows(next)
  return { workspace, directoryCreated }
}

export function updateAgentWorkspace(
  id: string,
  input: Partial<{
    name: string
    path: string
    description: string
    isDefault: boolean
    createIfMissing?: boolean
  }>,
): { workspace: AgentWorkspace; directoryCreated: boolean } {
  const rows = readStoredRows()
  const index = rows.findIndex((row) => row.id === id)
  if (index < 0) throw new Error('Workspace not found')

  const current = fromStored(rows[index])
  const name = input.name !== undefined ? String(input.name).trim() : current.name
  if (!name) throw new Error('Workspace name is required')

  let normalizedPath = current.path
  let directoryCreated = false
  if (input.path !== undefined) {
    const ensured = ensureWorkspaceDirectory(input.path, input.createIfMissing !== false)
    normalizedPath = ensured.path
    directoryCreated = ensured.created
  }

  const conflict = rows.find(
    (row, i) =>
      i !== index &&
      (row.name.toLowerCase() === name.toLowerCase() || row.path === normalizedPath),
  )
  if (conflict) throw new Error('A workspace with the same name or path already exists')

  const updated: AgentWorkspace = {
    ...current,
    name,
    path: normalizedPath,
    description:
      input.description !== undefined ? input.description.trim() || undefined : current.description,
    isDefault: input.isDefault !== undefined ? Boolean(input.isDefault) : current.isDefault,
    updatedAt: Math.floor(Date.now() / 1000),
  }

  let next = [...rows]
  next[index] = toStored(updated)
  if (updated.isDefault) {
    next = next.map((row) => ({ ...row, is_default: row.id === id }))
  }
  writeStoredRows(next)
  return { workspace: updated, directoryCreated }
}

export function deleteAgentWorkspace(id: string): void {
  const rows = readStoredRows().filter((row) => row.id !== id)
  if (rows.length === readStoredRows().length) throw new Error('Workspace not found')
  writeStoredRows(rows)
}

export function countAgentsByWorkspacePath(): Record<string, number> {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT workspace_path as path, COUNT(*) as count
       FROM agents
       WHERE workspace_path IS NOT NULL AND TRIM(workspace_path) != ''
       GROUP BY workspace_path`,
    )
    .all() as Array<{ path: string; count: number }>
  const counts: Record<string, number> = {}
  for (const row of rows) {
    counts[normalizePath(row.path)] = Number(row.count) || 0
  }
  return counts
}
