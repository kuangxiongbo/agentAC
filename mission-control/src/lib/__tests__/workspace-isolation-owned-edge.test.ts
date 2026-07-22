import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as Database.Database | null, audits: [] as unknown[] }))
vi.mock('../db', () => ({ getDatabase: () => state.db, logAuditEvent: (event: unknown) => state.audits.push(event) }))
vi.mock('../config', () => ({ config: { memoryDir: '/tmp/memory' } }))

import type { User } from '../auth'
import { denyResourceOutsideWorkspace } from '../workspace-isolation'

const strictUser = { id: 2, username: 'strict', role: 'admin', workspace_id: 2, tenant_id: 10 } as User

beforeAll(() => {
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE workspaces (id INTEGER PRIMARY KEY, tenant_id INTEGER, isolation TEXT);
    CREATE TABLE sync_clients (client_id TEXT PRIMARY KEY, workspace_id INTEGER);
    CREATE TABLE sync_sessions (client_id TEXT, session_id TEXT, session_kind TEXT);
    CREATE TABLE sync_agent_index (client_id TEXT, local_agent_id INTEGER);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, workspace_id INTEGER);
    INSERT INTO workspaces VALUES (2, 10, 'strict'), (3, 10, 'strict');
    INSERT INTO sync_clients VALUES ('edge-owned', 2), ('edge-other', 3);
    INSERT INTO sync_sessions VALUES ('edge-owned', 'session-1', 'codex-cli');
    INSERT INTO sync_agent_index VALUES ('edge-owned', 7);
    INSERT INTO agents VALUES (9, 2);
  `)
})
afterAll(() => state.db?.close())

describe('strict workspace resource ownership', () => {
  it('allows a fully owned edge session and local managed agent', () => {
    expect(denyResourceOutsideWorkspace(strictUser, 'local_sessions', '/continue', {
      clientId: 'edge-owned', localAgentId: 7, sessionId: 'session-1', sessionKind: 'codex-cli',
    })).toBeNull()
    expect(denyResourceOutsideWorkspace(strictUser, 'local_sessions', '/continue', { localAgentId: 9 })).toBeNull()
  })

  it('denies unowned, partial, and deployment-global resources', async () => {
    expect(denyResourceOutsideWorkspace(strictUser, 'local_sessions', '/continue', {
      clientId: 'edge-other', sessionId: 'session-1', sessionKind: 'codex-cli',
    })?.status).toBe(403)
    expect(denyResourceOutsideWorkspace(strictUser, 'local_sessions', '/continue', {
      clientId: 'edge-owned', sessionId: 'session-1',
    })?.status).toBe(403)
    const denied = denyResourceOutsideWorkspace(strictUser, 'gateway_sessions', '/sessions')
    expect(denied?.status).toBe(403)
    expect(await denied?.json()).toEqual(expect.objectContaining({ error: expect.stringContaining('ownership') }))
  })
})
