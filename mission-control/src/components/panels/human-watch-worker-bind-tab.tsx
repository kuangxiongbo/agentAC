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
  client_id: string
  worker_local_agent_id: number | null
  steward_local_agent_id: number | null
  steward_name: string | null
  enabled: boolean
  mode: string
  rules_override?: Record<string, unknown> | null
}

export function HumanWatchWorkerBindTab({
  agent,
  allAgents,
}: {
  agent: Agent
  allAgents: Agent[]
}) {
  const t = useTranslations('humanWatch')
  const ta = useTranslations('agentSquadPhase3')
  const clientId = getAgentClientId(agent) || ''
  const workerLocalId = getAgentLocalAgentId(agent)
  const workerFramework = normalizeHumanWatchFramework(agent.framework)

  const [policyEnabled, setPolicyEnabled] = useState<boolean | null>(null)
  const [bindings, setBindings] = useState<BindingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [stewardLocalId, setStewardLocalId] = useState('')

  const stewardsForClient = useMemo(() => {
    return allAgents.filter((a) => {
      if (getAgentClientId(a) !== clientId) return false
      if (!isHumanWatchAgent(a)) return false
      const sf = normalizeHumanWatchFramework(a.framework)
      return !workerFramework || !sf || sf === workerFramework
    })
  }, [allAgents, clientId, workerFramework])

  const currentBinding = useMemo(() => {
    if (workerLocalId == null) return null
    return bindings.find((b) => b.worker_local_agent_id === workerLocalId) ?? null
  }, [bindings, workerLocalId])

  const load = useCallback(async () => {
    if (!clientId) {
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
      if (policyRes.ok) setPolicyEnabled(Boolean(policy.available ?? policy.enabled))
      const rows = Array.isArray(bindingsData.bindings) ? bindingsData.bindings : []
      setBindings(rows)
      const existing = workerLocalId != null
        ? rows.find((b: BindingRow) => b.worker_local_agent_id === workerLocalId)
        : null
      if (existing?.steward_local_agent_id) {
        setStewardLocalId(String(existing.steward_local_agent_id))
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [clientId, workerLocalId, t])

  useEffect(() => {
    void load()
  }, [load])

  const saveBinding = async () => {
    if (!clientId || workerLocalId == null || !stewardLocalId) return
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch('/api/human-watch/bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          worker_local_agent_id: workerLocalId,
          steward_local_agent_id: Number(stewardLocalId),
          mode: 'auto_send',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('createBindingFailed'))
      setMessage(t('createBindingSuccess'))
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('createBindingFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (!clientId || workerLocalId == null) {
    return (
      <p className="text-sm text-muted-foreground p-4">{ta('humanWatchBindNeedEdge')}</p>
    )
  }

  if (loading) {
    return <Loader variant="inline" label={t('loading')} />
  }

  return (
    <div className="p-4 space-y-4 max-w-lg">
      {policyEnabled === false ? (
        <p className="text-sm text-amber-200 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          {t('featureDisabled')}
        </p>
      ) : null}

      {error ? <p className="text-sm text-rose-400">{error}</p> : null}
      {message ? <p className="text-sm text-emerald-400">{message}</p> : null}

      {currentBinding ? (
        <p className="text-sm text-muted-foreground">
          {ta('humanWatchCurrentBinding', {
            steward: currentBinding.steward_name || String(currentBinding.steward_local_agent_id),
          })}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{ta('humanWatchNoBinding')}</p>
      )}

      <HumanWatchRulesConfig rulesOverride={currentBinding?.rules_override ?? null} compact />

      <label className="block text-xs text-muted-foreground">
        {t('stewardAgent')}
        <select
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          value={stewardLocalId}
          onChange={(e) => setStewardLocalId(e.target.value)}
        >
          <option value="">{t('selectSteward')}</option>
          {stewardsForClient.map((a) => {
            const lid = getAgentLocalAgentId(a)
            if (lid == null) return null
            return (
              <option key={`s-${lid}`} value={String(lid)}>
                {getAgentDisplayName(a)} ({a.framework || '?'})
              </option>
            )
          })}
        </select>
      </label>

      {stewardsForClient.length === 0 ? (
        <p className="text-xs text-muted-foreground">{ta('humanWatchNoStewardHint')}</p>
      ) : null}

      <Button
        size="sm"
        disabled={busy || policyEnabled === false || !stewardLocalId}
        onClick={() => void saveBinding()}
      >
        {currentBinding ? ta('humanWatchUpdateBinding') : t('createBinding')}
      </Button>
    </div>
  )
}
