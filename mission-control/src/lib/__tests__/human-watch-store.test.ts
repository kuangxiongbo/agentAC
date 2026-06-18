import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAgentCenterStore } from '@/store'

describe('human-watch store', () => {
  beforeEach(() => {
    useAgentCenterStore.setState({ humanWatchEvents: [] })
  })

  afterEach(() => {
    useAgentCenterStore.setState({ humanWatchEvents: [] })
  })

  it('merges fetched events instead of replacing unrelated existing events', () => {
    useAgentCenterStore.getState().upsertHumanWatchEvent({
      id: 'event-a',
      workspace_id: 1,
      tenant_id: 1,
      client_id: 'client-a',
      binding_id: null,
      worker_sync_index_id: null,
      worker_local_agent_id: 5,
      worker_name: 'worker-a',
      worker_session_id: 'sess-a',
      steward_sync_index_id: null,
      steward_local_agent_id: 9,
      steward_name: 'steward-a',
      permission_request_id: null,
      source: 'worker_tool',
      status: 'visible',
      priority: 'medium',
      title: 'event a',
      summary: 'summary a',
      context: null,
      latest_worker_message: null,
      suggested_action: 'send_message_to_worker',
      claimed_by_type: null,
      claimed_by_user_id: null,
      claimed_by_agent_id: null,
      claimed_at: null,
      resolved_action: null,
      resolved_note: null,
      resolved_by_type: null,
      resolved_by_user_id: null,
      resolved_by_agent_id: null,
      resolved_at: null,
      dedupe_key: null,
      created_at: 100,
      updated_at: 100,
    })

    useAgentCenterStore.getState().setHumanWatchEvents([
      {
        id: 'event-b',
        workspace_id: 1,
        tenant_id: 1,
        client_id: 'client-b',
        binding_id: null,
        worker_sync_index_id: null,
        worker_local_agent_id: 6,
        worker_name: 'worker-b',
        worker_session_id: 'sess-b',
        steward_sync_index_id: null,
        steward_local_agent_id: 10,
        steward_name: 'steward-b',
        permission_request_id: null,
        source: 'permission_request',
        status: 'pending',
        priority: 'high',
        title: 'event b',
        summary: 'summary b',
        context: null,
        latest_worker_message: 'need help',
        suggested_action: 'approve_request',
        claimed_by_type: null,
        claimed_by_user_id: null,
        claimed_by_agent_id: null,
        claimed_at: null,
        resolved_action: null,
        resolved_note: null,
        resolved_by_type: null,
        resolved_by_user_id: null,
        resolved_by_agent_id: null,
        resolved_at: null,
        dedupe_key: null,
        created_at: 200,
        updated_at: 200,
      },
    ])

    const ids = useAgentCenterStore.getState().humanWatchEvents.map((item) => item.id)
    expect(ids).toContain('event-a')
    expect(ids).toContain('event-b')
  })
})
