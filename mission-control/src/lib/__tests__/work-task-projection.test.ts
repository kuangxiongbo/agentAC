import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bridge-server', () => ({
  getConnectedBridgeClients: vi.fn(() => []),
  requestBridgeClientTaskSnapshot: vi.fn(),
}))

import {
  countTasksByStatus,
  mergeCloudAndProjectedTasks,
  projectedWorkTaskId,
  type ProjectedWorkTask,
} from '@/lib/work-task-projection'

function localTask(overrides: Partial<ProjectedWorkTask> = {}): ProjectedWorkTask {
  return {
    id: projectedWorkTaskId('edge-a', 7),
    title: 'Local execution',
    status: 'done',
    source: 'local_runtime',
    authority: 'local_runtime',
    stale: false,
    local_task_id: 7,
    bridge_client_id: 'edge-a',
    client_id: 'edge-a',
    client_label: 'Mac A',
    metadata: {},
    tags: [],
    created_at: 20,
    updated_at: 30,
    ...overrides,
  }
}

describe('work task projection', () => {
  it('creates stable client-scoped negative IDs', () => {
    expect(projectedWorkTaskId('edge-a', 7)).toBe(projectedWorkTaskId('edge-a', 7))
    expect(projectedWorkTaskId('edge-a', 7)).toBeLessThan(0)
    expect(projectedWorkTaskId('edge-a', 7)).not.toBe(projectedWorkTaskId('edge-b', 7))
    expect(Number.isSafeInteger(projectedWorkTaskId('edge-a', 7))).toBe(true)
  })

  it('uses the local runtime row when it mirrors a cloud control task', () => {
    const cloud = [{
      id: 42,
      title: 'Cloud instruction',
      status: 'assigned',
      project_name: 'Goal',
      metadata: { supervision_goal_id: 'goal-1' },
      created_at: 10,
      updated_at: 15,
    }]
    const merged = mergeCloudAndProjectedTasks(cloud, [
      localTask({ metadata: { remote_task_id: 42 }, status: 'done' }),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      source: 'local_runtime',
      authority: 'local_runtime',
      local_task_id: 7,
      status: 'done',
      project_name: 'Goal',
      metadata: expect.objectContaining({ cloud_task_id: 42, supervision_goal_id: 'goal-1' }),
    })
  })

  it('keeps independent cloud tasks and counts merged statuses', () => {
    const merged = mergeCloudAndProjectedTasks([
      { id: 5, status: 'in_progress', created_at: 5, updated_at: 5, metadata: {} },
    ], [localTask({ status: 'done' })])
    expect(merged.map((task) => task.source)).toEqual(['local_runtime', 'cloud_control'])
    expect(countTasksByStatus(merged)).toEqual({
      total: 2,
      byStatus: { done: 1, in_progress: 1 },
    })
  })
})
