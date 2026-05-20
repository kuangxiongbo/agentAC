'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import type { Agent } from '@/store'
import {
  getAgentClientId,
  getAgentDisplayName,
  getAgentLocalAgentId,
} from '@/lib/agent-card-helpers'
import { isHumanWatchAgent, normalizeHumanWatchFramework } from '@/lib/human-watch-helpers'
import { HumanWatchRulesConfig } from '@/components/panels/human-watch-rules-config'

interface BindingRow {
  id: number
  worker_local_agent_id: number | null
  worker_name: string | null
  steward_local_agent_id: number | null
  enabled: boolean
  rules_override?: Record<string, unknown> | null
}

export function HumanWatchStewardBindTab({
  agent,
  allAgents,
}: {
  agent: Agent
  allAgents: Agent[]
}) {
  const t = useTranslations('humanWatch')
  const ta = useTranslations('agentSquadPhase3')
  const clientId = getAgentClientId(agent) || ''
  const stewardLocalId = getAgentLocalAgentId(agent)
  const stewardFramework = normalizeHumanWatchFramework(agent.framework)

  const [policyAvailable, setPolicyAvailable] = useState<boolean | null>(null)
  const [bindings, setBindings] = useState<BindingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [workerLocalId, setWorkerLocalId] = useState('')

  const workersForClient = useMemo(() => {
    const boundWorkerIds = new Set(
      bindings
        .map((b) => b.worker_local_agent_id)
        .filter((id): id is number => id != null),
    )
    return allAgents.filter((a) => {
      if (getAgentClientId(a) !== clientId) return false
      if (isHumanWatchAgent(a)) return false
      const wf = normalizeHumanWatchFramework(a.framework)
      if (stewardFramework && wf && wf !== stewardFramework) return false
      const lid = getAgentLocalAgentId(a)
      if (lid == null) return false
      if (boundWorkerIds.has(lid)) return false
      return true
    })
  }, [allAgents, clientId, stewardFramework, bindings])

  const stewardBindings = useMemo(() => {
    if (stewardLocalId == null) return []
    return bindings.filter((b) => b.steward_local_agent_id === stewardLocalId)
  }, [bindings, stewardLocalId])

  const load = useCallback(async () => {
    if (!clientId || stewardLocalId == null) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [policyRes, bindingsRes] = await Promise.all([
        fetch('/api/human-watch/policy'),
        fetch(`/api/human-watch/bindings?client_id=${encodeURIComponent(clientId)}`),
      ])
      const policy = await policyRes.json().catch(() => ({}))
      const bindingsData = await bindingsRes.json().catch(() => ({}))
      if (policyRes.ok) {
        setPolicyAvailable(Boolean(policy.available ?? policy.enabled))
      }
      setBindings(Array.isArray(bindingsData.bindings) ? bindingsData.bindings : [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [clientId, stewardLocalId, t])

  useEffect(() => {
    void load()
  }, [load])

  const saveBinding = async () => {
    if (!clientId || stewardLocalId == null || !workerLocalId) return
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch('/api/human-watch/bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          worker_local_agent_id: Number(workerLocalId),
          steward_local_agent_id: stewardLocalId,
          mode: 'auto_send',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('createBindingFailed'))
      setMessage(t('createBindingSuccess'))
      setWorkerLocalId('')
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('createBindingFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (!clientId || stewardLocalId == null) {
    return (
      <p className="text-sm text-muted-foreground p-4">{ta('humanWatchBindNeedEdge')}</p>
    )
  }

  if (loading) {
    return <Loader variant="inline" label={t('loading')} />
  }

  return (
    <div className="p-4 space-y-4 max-w-lg">
      <p className="text-xs text-muted-foreground">{ta('humanWatchStewardBindHint')}</p>

      <HumanWatchRulesConfig
        rulesOverride={
          stewardBindings[0]?.rules_override ?? null
        }
        compact
      />

      {policyAvailable === false ? (
        <p className="text-sm text-amber-200 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          {t('featureDisabled')}
        </p>
      ) : null}

      {error ? <p className="text-sm text-rose-400">{error}</p> : null}
      {message ? <p className="text-sm text-emerald-400">{message}</p> : null}

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">{ta('humanWatchBoundWorkers')}</p>
        {stewardBindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{ta('humanWatchStewardNoWorkers')}</p>
        ) : (
          <ul className="text-sm space-y-1">
            {stewardBindings.map((b) => (
              <li
                key={b.id}
                className="rounded-md border border-border/60 bg-surface-1/40 px-3 py-2"
              >
                {b.worker_name || `Worker #${b.worker_local_agent_id}`}
                {!b.enabled ? (
                  <span className="ml-2 text-2xs text-muted-foreground">({t('disabled')})</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <label className="block text-xs text-muted-foreground">
        {ta('humanWatchSelectWorker')}
        <select
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          value={workerLocalId}
          onChange={(e) => setWorkerLocalId(e.target.value)}
        >
          <option value="">{ta('humanWatchSelectWorkerPlaceholder')}</option>
          {workersForClient.map((a) => {
            const lid = getAgentLocalAgentId(a)
            if (lid == null) return null
            return (
              <option key={`w-${lid}`} value={String(lid)}>
                {getAgentDisplayName(a)} ({a.framework || '?'})
              </option>
            )
          })}
        </select>
      </label>

      {workersForClient.length === 0 && stewardBindings.length === 0 ? (
        <p className="text-xs text-muted-foreground">{ta('humanWatchNoWorkerHint')}</p>
      ) : null}

      <Button
        size="sm"
        disabled={busy || policyAvailable === false || !workerLocalId}
        onClick={() => void saveBinding()}
      >
        {t('createBinding')}
      </Button>
    </div>
  )
}
