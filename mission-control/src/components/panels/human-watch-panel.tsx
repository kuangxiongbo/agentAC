'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader } from '@/components/ui/loader'
import { useAgentCenterStore } from '@/store'

interface BindingRow {
  id: number
  client_id: string
  worker_name: string | null
  steward_name: string | null
  worker_local_agent_id: number | null
  steward_local_agent_id: number | null
  enabled: boolean
  mode: string
}

/** 绑定列表与审计导出（创建/绑定入口已移至智能体页） */
export function HumanWatchPanel() {
  const t = useTranslations('humanWatch')
  const { centralMode } = useAgentCenterStore()

  const [policyEnabled, setPolicyEnabled] = useState<boolean | null>(null)
  const [bindings, setBindings] = useState<BindingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [policyRes, bindingsRes] = await Promise.all([
        fetch('/api/human-watch/policy'),
        fetch('/api/human-watch/bindings'),
      ])
      const policy = await policyRes.json().catch(() => ({}))
      const bindingsData = await bindingsRes.json().catch(() => ({}))
      if (!policyRes.ok) throw new Error(policy.error || 'policy failed')
      setPolicyEnabled(Boolean(policy.enabled))
      setBindings(Array.isArray(bindingsData.bindings) ? bindingsData.bindings : [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  if (!centralMode) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t('centralOnly')}
      </div>
    )
  }

  if (loading) {
    return <Loader variant="panel" label={t('loading')} />
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t('title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t('description')}</p>
        <p className="text-sm text-cyan-400/90 mt-2">{t('movedToAgentsHint')}</p>
      </div>

      {policyEnabled === false ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          {t('featureDisabled')}
        </div>
      ) : null}

      {error ? <p className="text-sm text-rose-400">{error}</p> : null}

      <section className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold">{t('bindingsTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('bindingsAuditOnlyHint')}</p>

        <p className="text-[10px] text-muted-foreground">
          {t('exportHint')}{' '}
          <a
            href="/api/export?type=human_watch_interventions&format=csv"
            className="text-cyan-400 hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            CSV
          </a>
        </p>

        {bindings.length > 0 ? (
          <ul className="mt-4 space-y-2 border-t border-border/40 pt-3">
            {bindings.map((b) => (
              <li key={b.id} className="text-xs text-muted-foreground flex flex-wrap gap-2">
                <span className="font-mono text-foreground/80">#{b.id}</span>
                <span>{b.client_id}</span>
                <span>{b.worker_name || b.worker_local_agent_id}</span>
                <span>→</span>
                <span>{b.steward_name || b.steward_local_agent_id}</span>
                <span className={b.enabled ? 'text-emerald-400' : 'text-slate-500'}>
                  {b.enabled ? t('enabled') : t('disabled')}
                </span>
                <span>{b.mode}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t('noBindings')}</p>
        )}
      </section>
    </div>
  )
}
