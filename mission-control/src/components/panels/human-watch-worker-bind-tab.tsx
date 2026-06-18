'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useNavigateToPanel } from '@/lib/navigation'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import type { Agent } from '@/store'
import {
  getAgentClientId,
  getAgentDisplayName,
  getAgentLocalAgentId,
  humanWatchBindingMatchesWorker,
  resolveHumanWatchStewardLabel,
} from '@/lib/agent-card-helpers'
import { isHumanWatchAgent, normalizeHumanWatchFramework } from '@/lib/human-watch-helpers'
import { HumanWatchRulesConfig } from '@/components/panels/human-watch-rules-config'
import { HumanWatchBindingControls } from '@/components/panels/human-watch-binding-controls'
import { useAgentEdgeIdentity } from '@/components/panels/use-agent-edge-identity'
import { HumanWatchEventsTab } from '@/components/panels/human-watch-events-tab'

interface BindingRow {
  id: number
  client_id: string
  worker_sync_index_id: number | null
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
  const navigateToPanel = useNavigateToPanel()
  const { identity, resolving } = useAgentEdgeIdentity(agent)
  const clientId = identity?.clientId || getAgentClientId(agent) || ''
  const workerResolved = useMemo(
    () =>
      identity
        ? { local_agent_id: identity.localAgentId, sync_index_id: identity.syncIndexId }
        : undefined,
    [identity?.localAgentId, identity?.syncIndexId],
  )
  const workerLocalId = identity?.localAgentId ?? getAgentLocalAgentId(agent)
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
      const stewardClient = getAgentClientId(a)
      if (stewardClient !== clientId) return false
      if (!isHumanWatchAgent(a)) return false
      const sf = normalizeHumanWatchFramework(a.framework)
      return !workerFramework || !sf || sf === workerFramework
    })
  }, [allAgents, clientId, workerFramework])

  const currentBinding = useMemo(() => {
    return (
      bindings.find((b) => humanWatchBindingMatchesWorker(b, agent, workerResolved)) ?? null
    )
  }, [bindings, agent, workerResolved])

  const stewardLabel = useMemo(() => {
    if (!currentBinding) return null
    return resolveHumanWatchStewardLabel(currentBinding, allAgents, clientId)
  }, [currentBinding, allAgents, clientId])

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
      const existing =
        rows.find((b: BindingRow) => humanWatchBindingMatchesWorker(b, agent, workerResolved)) ??
        null
      if (existing?.steward_local_agent_id) {
        setStewardLocalId(String(existing.steward_local_agent_id))
      } else {
        setStewardLocalId('')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [clientId, agent, workerResolved, t])

  useEffect(() => {
    if (!resolving) void load()
  }, [load, resolving])

  const effectiveWorkerLocalId =
    workerLocalId ?? currentBinding?.worker_local_agent_id ?? null

  const saveBinding = async () => {
    if (!clientId || effectiveWorkerLocalId == null || !stewardLocalId) return
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const payload = {
        client_id: clientId,
        worker_local_agent_id: effectiveWorkerLocalId,
        steward_local_agent_id: Number(stewardLocalId),
        mode: 'auto_send',
      }

      const res = currentBinding
        ? await fetch(`/api/human-watch/bindings/${currentBinding.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              steward_local_agent_id: Number(stewardLocalId),
              mode: 'auto_send',
            }),
          })
        : await fetch('/api/human-watch/bindings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })

      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('createBindingFailed'))
      setMessage(currentBinding ? t('updateBindingSuccess') : t('createBindingSuccess'))
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('createBindingFailed'))
    } finally {
      setBusy(false)
    }
  }

  const unbind = async () => {
    if (!currentBinding) return
    if (!window.confirm(t('unbindConfirm'))) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await fetch(`/api/human-watch/bindings/${currentBinding.id}`, {
        method: 'DELETE',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('unbindFailed'))
      setMessage(t('unbindSuccess'))
      setStewardLocalId('')
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('unbindFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (resolving || loading) {
    return <Loader variant="inline" label={t('loading')} />
  }

  if (!clientId || (workerLocalId == null && !currentBinding)) {
    return (
      <p className="text-sm text-muted-foreground p-4">{ta('humanWatchBindNeedEdge')}</p>
    )
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

      {currentBinding && stewardLabel ? (
        <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2.5">
          <p className="text-sm text-foreground">
            {ta('humanWatchCurrentBinding', { steward: stewardLabel })}
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{ta('humanWatchNoBinding')}</p>
      )}

      {currentBinding ? (
        <p className="text-xs text-muted-foreground">{ta('humanWatchRebindHint')}</p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t('globalRulesBindHint')}{' '}
        <button
          type="button"
          className="text-cyan-400 hover:underline"
          onClick={() => navigateToPanel('settings')}
        >
          {t('openSettingsGlobalRules')}
        </button>
      </p>
      <HumanWatchRulesConfig compact variant="summary" />
      {currentBinding?.id ? (
        <HumanWatchBindingControls
          bindingId={currentBinding.id}
          enabled={currentBinding.enabled}
          mode={(currentBinding.mode as 'auto_send' | 'suggest_only') || 'auto_send'}
          onSaved={load}
        />
      ) : null}

      <div className="rounded-lg border border-border/60 bg-surface-1/40 p-3 space-y-2">
        <p className="text-xs font-medium text-foreground">{t('eventsTitle')}</p>
        <HumanWatchEventsTab
          clientId={clientId}
          workerLocalAgentId={effectiveWorkerLocalId}
        />
      </div>

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

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || policyEnabled === false || !stewardLocalId}
          onClick={() => void saveBinding()}
        >
          {currentBinding ? ta('humanWatchUpdateBinding') : t('createBinding')}
        </Button>
        {currentBinding ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-rose-300"
            disabled={busy || policyEnabled === false}
            onClick={() => void unbind()}
          >
            {t('unbind')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
