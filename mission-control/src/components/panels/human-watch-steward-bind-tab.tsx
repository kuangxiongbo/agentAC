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
  humanWatchBindingMatchesSteward,
} from '@/lib/agent-card-helpers'
import { isHumanWatchAgent, normalizeHumanWatchFramework } from '@/lib/human-watch-helpers'
import { HumanWatchRulesConfig } from '@/components/panels/human-watch-rules-config'
import { HumanWatchBindingControls } from '@/components/panels/human-watch-binding-controls'
import { useAgentEdgeIdentity } from '@/components/panels/use-agent-edge-identity'
import { HumanWatchEventsTab } from '@/components/panels/human-watch-events-tab'

interface BindingRow {
  id: number
  worker_local_agent_id: number | null
  worker_sync_index_id?: number | null
  worker_name: string | null
  steward_local_agent_id: number | null
  steward_sync_index_id?: number | null
  enabled: boolean
  mode?: 'auto_send' | 'suggest_only'
  rules_override?: Record<string, unknown> | null
}

export function HumanWatchStewardBindTab({
  agent,
  allAgents,
}: {
  agent: Agent
  allAgents: Agent[]
}) {
  const tc = useTranslations('common')
  const t = useTranslations('humanWatch')
  const ta = useTranslations('agentSquadPhase3')
  const navigateToPanel = useNavigateToPanel()
  const { identity, resolving } = useAgentEdgeIdentity(agent)
  const clientId = identity?.clientId || getAgentClientId(agent) || ''
  const stewardResolved = useMemo(
    () =>
      identity
        ? { local_agent_id: identity.localAgentId, sync_index_id: identity.syncIndexId }
        : undefined,
    [identity?.localAgentId, identity?.syncIndexId],
  )
  const stewardLocalId = identity?.localAgentId ?? getAgentLocalAgentId(agent)
  const stewardFramework = normalizeHumanWatchFramework(agent.framework)

  const [policyAvailable, setPolicyAvailable] = useState<boolean | null>(null)
  const [bindings, setBindings] = useState<BindingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [workerLocalId, setWorkerLocalId] = useState('')
  const [stewardName, setStewardName] = useState(getAgentDisplayName(agent))
  const [soulContent, setSoulContent] = useState('')
  const [unbindConfirm, setUnbindConfirm] = useState<number | null>(null)

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
    return bindings.filter((b) => humanWatchBindingMatchesSteward(b, agent, stewardResolved))
  }, [bindings, agent, stewardResolved])

  const primaryBinding = stewardBindings[0] ?? null

  const load = useCallback(async () => {
    if (!clientId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [policyRes, bindingsRes, agentRes] = await Promise.all([
        fetch('/api/human-watch/policy'),
        fetch(`/api/human-watch/bindings?client_id=${encodeURIComponent(clientId)}`),
        fetch(`/api/agents/${agent.id}`),
      ])
      const policy = await policyRes.json().catch(() => ({}))
      const bindingsData = await bindingsRes.json().catch(() => ({}))
      const agentData = await agentRes.json().catch(() => ({}))
      if (policyRes.ok) {
        setPolicyAvailable(Boolean(policy.available ?? policy.enabled))
      }
      setBindings(Array.isArray(bindingsData.bindings) ? bindingsData.bindings : [])
      const detail = agentData.agent
      if (detail) {
        setStewardName(getAgentDisplayName(detail as Agent))
        setSoulContent(String(detail.soul_content || ''))
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [clientId, agent.id, agent, t])

  useEffect(() => {
    if (!resolving) void load()
  }, [load, resolving])

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

  const unbindWorker = async (bindingId: number) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/human-watch/bindings/${bindingId}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('unbindFailed'))
      setMessage(t('unbindSuccess'))
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('unbindFailed'))
    } finally {
      setBusy(false)
    }
  }

  const saveStewardProfile = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: stewardName.trim(),
          soul_content: soulContent,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('saveStewardFailed'))
      setMessage(t('saveStewardSuccess'))
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('saveStewardFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (resolving || loading) {
    return <Loader variant="inline" label={t('loading')} />
  }

  if (!clientId || stewardLocalId == null) {
    return (
      <p className="text-sm text-muted-foreground p-4">{ta('humanWatchBindNeedEdge')}</p>
    )
  }

  return (
    <div className="p-4 space-y-4 max-w-lg">
      <p className="text-xs text-muted-foreground">{ta('humanWatchStewardBindHint')}</p>

      <div className="space-y-2 rounded-lg border border-border/60 bg-surface-1/40 p-3">
        <p className="text-xs font-medium text-foreground">{t('editStewardTitle')}</p>
        <label className="block text-xs text-muted-foreground">
          {t('stewardName')}
          <input
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={stewardName}
            onChange={(e) => setStewardName(e.target.value)}
          />
        </label>
        <label className="block text-xs text-muted-foreground">
          {t('stewardSoul')}
          <textarea
            rows={4}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm font-mono"
            value={soulContent}
            onChange={(e) => setSoulContent(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || policyAvailable === false}
          onClick={() => void saveStewardProfile()}
        >
          {t('saveSteward')}
        </Button>
      </div>

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
      {primaryBinding?.id ? (
        <HumanWatchBindingControls
          bindingId={primaryBinding.id}
          enabled={primaryBinding.enabled}
          mode={primaryBinding.mode || 'auto_send'}
          rulesOverride={primaryBinding.rules_override}
          onSaved={load}
        />
      ) : null}

      {policyAvailable === false ? (
        <p className="text-sm text-amber-200 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          {t('featureDisabled')}
        </p>
      ) : null}

      <div className="space-y-2 rounded-lg border border-border/60 bg-surface-1/40 p-3">
        <p className="text-xs font-medium text-foreground">{t('eventsTitle')}</p>
        <HumanWatchEventsTab clientId={clientId} stewardLocalAgentId={stewardLocalId} />
      </div>

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
                className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-surface-1/40 px-3 py-2"
              >
                <span>
                  {b.worker_name || `Worker #${b.worker_local_agent_id}`}
                  {!b.enabled ? (
                    <span className="ml-2 text-2xs text-muted-foreground">({t('disabled')})</span>
                  ) : null}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-rose-300 shrink-0"
                  disabled={busy}
                  onClick={() => setUnbindConfirm(b.id)}
                >
                  {t('unbind')}
                </Button>
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

      {unbindConfirm != null ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-2xl">
            <div className="text-sm font-semibold text-foreground">{t('unbindConfirmTitle')}</div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {t('unbindConfirmBody')}
            </p>
            {error ? (
              <div className="mt-2 rounded border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-2xs text-rose-300">
                {error}
              </div>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => setUnbindConfirm(null)}>
                {tc('cancel')}
              </Button>
              <Button
                size="sm"
                className="bg-rose-500/20 text-rose-200 border border-rose-500/30 hover:bg-rose-500/30"
                disabled={busy}
                onClick={async () => {
                  await unbindWorker(unbindConfirm)
                  setUnbindConfirm(null)
                }}
              >
                {t('unbind')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

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
