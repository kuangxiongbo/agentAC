import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bridge-server', () => ({
  getConnectedBridgeClients: vi.fn(() => []),
  requestBridgeClientActivitySnapshot: vi.fn(),
}))

import { projectedWorkActivityId } from '@/lib/work-activity-projection'

describe('work activity projection', () => {
  it('creates stable client-scoped negative IDs for numeric and session events', () => {
    expect(projectedWorkActivityId('edge-a', '9')).toBe(projectedWorkActivityId('edge-a', '9'))
    expect(projectedWorkActivityId('edge-a', '9')).toBeLessThan(0)
    expect(projectedWorkActivityId('edge-a', '9')).not.toBe(projectedWorkActivityId('edge-b', '9'))
    expect(projectedWorkActivityId('edge-a', 'session:codex:s-1:20')).not.toBe(
      projectedWorkActivityId('edge-a', 'session:codex:s-1:21'),
    )
    expect(Number.isSafeInteger(projectedWorkActivityId('edge-a', '9'))).toBe(true)
  })
})
