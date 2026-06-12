import {
  isBridgeClientOnline,
  requestBridgeClientAgentDetail,
  requestBridgeClientStewardDelete,
  requestBridgeClientStewardUpdate,
} from './bridge-server'
import {
  deleteHumanWatchBindingsForSteward,
} from './human-watch-bindings'
import { isHumanWatchAgent } from './human-watch-helpers'
import {
  deleteBridgeAgentIndexByLocalId,
  getBridgeAgentIndexById,
  type SyncAgentIndexRow,
} from './sync-agent-index'
export async function resolveBridgeStewardHumanWatch(
  indexRow: SyncAgentIndexRow,
): Promise<boolean> {
  if (indexRow.role === 'human-watch') return true
  if (!isBridgeClientOnline(indexRow.client_id)) {
    return indexRow.role === 'human-watch'
  }
  try {
    const detail = await requestBridgeClientAgentDetail({
      clientId: indexRow.client_id,
      localAgentId: indexRow.local_agent_id,
    })
    return isHumanWatchAgent({
      role: typeof detail.agent?.role === 'string' ? detail.agent.role : indexRow.role,
      config: detail.agent?.config,
    })
  } catch {
    return false
  }
}

export async function deleteHumanWatchStewardOnEdge(input: {
  workspaceId: number
  indexRow: SyncAgentIndexRow
}): Promise<{ deleted: string; bindingsRemoved: number }> {
  if (!isBridgeClientOnline(input.indexRow.client_id)) {
    throw new Error('Bridge client is offline')
  }

  const remote = await requestBridgeClientStewardDelete({
    clientId: input.indexRow.client_id,
    localAgentId: input.indexRow.local_agent_id,
  })

  const bindingsRemoved = deleteHumanWatchBindingsForSteward(
    input.workspaceId,
    input.indexRow.client_id,
    input.indexRow.local_agent_id,
  )

  deleteBridgeAgentIndexByLocalId(
    input.indexRow.client_id,
    input.indexRow.local_agent_id,
  )

  return {
    deleted: remote.name || input.indexRow.original_name,
    bindingsRemoved,
  }
}

export async function updateHumanWatchStewardOnEdge(input: {
  indexRow: SyncAgentIndexRow
  name?: string | null
  soulContent?: string | null
  configPatch?: Record<string, unknown> | null
}): Promise<Record<string, unknown> | null> {
  if (!isBridgeClientOnline(input.indexRow.client_id)) {
    throw new Error('Bridge client is offline')
  }

  const remote = await requestBridgeClientStewardUpdate({
    clientId: input.indexRow.client_id,
    localAgentId: input.indexRow.local_agent_id,
    name: input.name,
    soulContent: input.soulContent,
    configPatch: input.configPatch,
  })

  return remote.agent
}
