import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import { eventBus } from '@/lib/event-bus'

const dbRef = vi.hoisted(() => ({ current: null as Database.Database | null }))

vi.mock('@/lib/db', () => ({
  getDatabase: () => dbRef.current,
}))

import { initWebhookListener } from '@/lib/webhooks'

describe('webhooks for human-watch events', () => {
  let db: Database.Database
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    db = new Database(':memory:')
    dbRef.current = db
    runMigrations(db)
    initWebhookListener()
    fetchMock = vi.fn().mockResolvedValue({ status: 200, text: async () => 'ok' })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    db.close()
    eventBus.removeAllListeners('server-event')
    vi.unstubAllGlobals()
  })

  function insertWebhook(events: string[]) {
    db.prepare(
      `INSERT INTO webhooks (name, url, secret, events, enabled, workspace_id) VALUES (?, ?, ?, ?, 1, 1)`,
    ).run('test-hook', 'https://example.com/hook', null, JSON.stringify(events))
  }

  it('fires the generic human_watch.event webhook for any priority', async () => {
    insertWebhook(['human_watch.event'])

    eventBus.broadcast('human_watch.event', { id: 'evt-1', workspace_id: 1, priority: 'medium' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers['X-MC-Event']).toBe('human_watch.event')
  })

  it('also fires human_watch.event.high for high-priority events, for accounts subscribed to just that', async () => {
    insertWebhook(['human_watch.event.high'])

    eventBus.broadcast('human_watch.event', { id: 'evt-2', workspace_id: 1, priority: 'high' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers['X-MC-Event']).toBe('human_watch.event.high')
  })

  it('does not fire human_watch.event.high for medium-priority events', async () => {
    insertWebhook(['human_watch.event.high'])

    eventBus.broadcast('human_watch.event', { id: 'evt-3', workspace_id: 1, priority: 'medium' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fires permission.requested webhooks', async () => {
    insertWebhook(['permission.requested'])

    eventBus.broadcast('permission.requested', { id: 'pr-1', workspace_id: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers['X-MC-Event']).toBe('permission.requested')
  })
})
