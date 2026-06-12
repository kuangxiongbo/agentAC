'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Agent } from '@/store'
import {
  getAgentClientId,
  getAgentLocalAgentId,
  getAgentBridgeSyncIndexId,
} from '@/lib/agent-card-helpers'

export interface ResolvedEdgeIdentity {
  clientId: string
  localAgentId: number
  syncIndexId: number | null
}

export function useAgentEdgeIdentity(agent: Agent) {
  const [identity, setIdentity] = useState<ResolvedEdgeIdentity | null>(null)
  const [resolving, setResolving] = useState(true)

  const resolve = useCallback(async () => {
    setResolving(true)
    const directClientId = getAgentClientId(agent)
    const directLocalId = getAgentLocalAgentId(agent)
    if (directClientId && directLocalId != null) {
      setIdentity({
        clientId: directClientId,
        localAgentId: directLocalId,
        syncIndexId: getAgentBridgeSyncIndexId(agent),
      })
      setResolving(false)
      return
    }

    try {
      const res = await fetch(`/api/agents/${agent.id}/edge-identity`)
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.client_id && data.local_agent_id != null) {
        setIdentity({
          clientId: String(data.client_id),
          localAgentId: Number(data.local_agent_id),
          syncIndexId:
            typeof data.sync_index_id === 'number' && Number.isFinite(data.sync_index_id)
              ? data.sync_index_id
              : null,
        })
      } else {
        setIdentity(null)
      }
    } catch {
      setIdentity(null)
    } finally {
      setResolving(false)
    }
  }, [agent])

  useEffect(() => {
    void resolve()
  }, [resolve])

  return { identity, resolving: resolving, reloadIdentity: resolve }
}
