'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { isBindableSessionKind } from '@/lib/agent-session-binding'
import {
  getAgentClientId,
  getAgentDisplayName,
  getAgentLocalAgentId,
} from '@/lib/agent-card-helpers'
import { isHumanWatchAgent, normalizeHumanWatchFramework } from '@/lib/human-watch-helpers'
import { HumanWatchRulesConfig } from '@/components/panels/human-watch-rules-config'
import type { Agent } from '@/store'
import { useAgentCenterStore } from '@/store'

interface BridgeClient {
  id: string
  name: string
  status: string
}

export function HumanWatchCreateStewardModal({
  onClose,
  onCreated,
  defaultClientId = '',
  allAgents = [],
}: {
  onClose: () => void
  onCreated: () => void
  defaultClientId?: string
  allAgents?: Agent[]
}) {
  const t = useTranslations('humanWatch')
  const ta = useTranslations('agentSquadPhase3')
  const tc = useTranslations('common')
  const [policy, setPolicy] = useState<{
    available: boolean
    subscription_entitled?: boolean
    subscriptions_url?: string
  } | null>(null)
  const [clients, setClients] = useState<BridgeClient[]>([])
  const [clientId, setClientId] = useState(defaultClientId)
  const [stewardName, setStewardName] = useState('')
  const [stewardFramework, setStewardFramework] = useState<'claude-code' | 'codex-cli'>('claude-code')
  const [workerLocalId, setWorkerLocalId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successHint, setSuccessHint] = useState<string | null>(null)

  const workersForClient = useMemo(() => {
    if (!clientId) return []
    return allAgents.filter((a) => {
      if (getAgentClientId(a) !== clientId) return false
      if (isHumanWatchAgent(a)) return false
      const wf = normalizeHumanWatchFramework(a.framework)
      if (stewardFramework && wf && wf !== stewardFramework) return false
      return getAgentLocalAgentId(a) != null
    })
  }, [allAgents, clientId, stewardFramework])

  const loadMeta = useCallback(async () => {
    try {
      const [policyRes, clientsRes] = await Promise.all([
        fetch('/api/human-watch/policy'),
        fetch('/api/bridge/clients'),
      ])
      const policyJson = await policyRes.json().catch(() => ({}))
      const clientsData = await clientsRes.json().catch(() => ({}))
      if (policyRes.ok) {
        setPolicy({
          available: Boolean(policyJson.available ?? policyJson.enabled),
          subscription_entitled: Boolean(policyJson.subscription_entitled),
          subscriptions_url:
            typeof policyJson.subscriptions_url === 'string' ? policyJson.subscriptions_url : undefined,
        })
      } else {
        setPolicy({ available: false, subscription_entitled: false })
      }
      setClients(Array.isArray(clientsData.clients) ? clientsData.clients : [])
    } catch {
      setPolicy({ available: false, subscription_entitled: false })
    }
  }, [])

  useEffect(() => {
    void loadMeta()
  }, [loadMeta])

  useEffect(() => {
    if (defaultClientId) setClientId(defaultClientId)
  }, [defaultClientId])

  useEffect(() => {
    setWorkerLocalId('')
  }, [clientId, stewardFramework])

  const handleCreate = async () => {
    if (!clientId.trim() || !stewardName.trim()) return
    setBusy(true)
    setError(null)
    setSuccessHint(null)
    try {
      const res = await fetch('/api/human-watch/stewards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId.trim(),
          name: stewardName.trim(),
          framework: stewardFramework,
          ...(workerLocalId
            ? { worker_local_agent_id: Number(workerLocalId) }
            : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data.steward && data.binding_failed) {
          throw new Error(
            `${data.error || t('createBindingFailed')}（${t('createStewardPartialSuccess')}）`,
          )
        }
        throw new Error(data.error || t('createStewardFailed'))
      }
      const agentsRes = await fetch('/api/agents?include_bridge=1')
      if (agentsRes.ok) {
        const agentsData = await agentsRes.json()
        if (Array.isArray(agentsData.agents)) {
          useAgentCenterStore.getState().setAgents(agentsData.agents)
        }
      }
      if (data.binding) {
        setSuccessHint(t('createStewardWithBindingSuccess'))
      } else if (workerLocalId) {
        setSuccessHint(t('createStewardBindingSkipped'))
      }
      onCreated()
      if (data.binding || !workerLocalId) {
        onClose()
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('createStewardFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-lg font-semibold text-foreground">{ta('addHumanWatchSteward')}</h3>
          <p className="text-sm text-muted-foreground mt-1">{t('description')}</p>
        </div>

        {policy && !policy.available ? (
          <div className="text-sm text-amber-200 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 space-y-1">
            <p>
              {policy.subscription_entitled === false
                ? t('subscriptionRequired')
                : t('featureDisabled')}
            </p>
            {policy.subscription_entitled === false && policy.subscriptions_url ? (
              <a
                href={policy.subscriptions_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline text-xs"
              >
                {t('goSubscribe')}
              </a>
            ) : null}
          </div>
        ) : null}

        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
        {successHint ? <p className="text-sm text-emerald-400">{successHint}</p> : null}

        <HumanWatchRulesConfig compact />

        <label className="block text-xs text-muted-foreground">
          {t('clientId')}
          <select
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">{t('selectClient')}</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.status})
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-muted-foreground">
          {t('stewardName')}
          <input
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={stewardName}
            onChange={(e) => setStewardName(e.target.value)}
            placeholder={t('stewardName')}
          />
        </label>

        <label className="block text-xs text-muted-foreground">
          {t('framework')}
          <select
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={stewardFramework}
            onChange={(e) => {
              const v = e.target.value
              if (isBindableSessionKind(v) && (v === 'claude-code' || v === 'codex-cli')) {
                setStewardFramework(v)
              }
            }}
          >
            <option value="claude-code">Claude</option>
            <option value="codex-cli">Codex</option>
          </select>
        </label>

        <label className="block text-xs text-muted-foreground">
          {t('bindWorkerOnCreate')}
          <select
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={workerLocalId}
            onChange={(e) => setWorkerLocalId(e.target.value)}
            disabled={!clientId}
          >
            <option value="">{t('bindWorkerOnCreateOptional')}</option>
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
        {clientId && workersForClient.length === 0 ? (
          <p className="text-2xs text-muted-foreground">{ta('humanWatchNoWorkerHint')}</p>
        ) : (
          <p className="text-2xs text-muted-foreground">{t('bindWorkerOnCreateHint')}</p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {tc('cancel')}
          </Button>
          <Button
            size="sm"
            disabled={busy || policy?.available === false || !clientId || !stewardName.trim()}
            onClick={() => void handleCreate()}
          >
            {busy
              ? ta('creatingHumanWatch')
              : workerLocalId
                ? t('createStewardAndBind')
                : t('createSteward')}
          </Button>
        </div>
      </div>
    </div>
  )
}
