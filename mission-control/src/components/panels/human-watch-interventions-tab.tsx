'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader } from '@/components/ui/loader'
import { getAgentClientId, getAgentLocalAgentId } from '@/lib/agent-card-helpers'
import { isHumanWatchAgent } from '@/lib/human-watch-helpers'

interface InterventionRow {
  id: number
  event_type: string
  decision: string | null
  outcome: string | null
  rules_hit: Record<string, unknown> | null
  fingerprint: string | null
  prompt_preview: string | null
  skip_reason: string | null
  created_at: number
}

interface HumanWatchInterventionsTabProps {
  agent: {
    id?: number
    role?: string
    config?: unknown
    node_id?: string | null
    source?: string
  }
}

export function HumanWatchInterventionsTab({ agent }: HumanWatchInterventionsTabProps) {
  const t = useTranslations('humanWatch')
  const [rows, setRows] = useState<InterventionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const clientId = getAgentClientId(agent)
  const localAgentId = getAgentLocalAgentId(agent)
  const steward = isHumanWatchAgent(agent)

  const load = useCallback(async () => {
    if (!clientId) {
      setError(t('interventionsNeedClient'))
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ client_id: clientId, limit: '20' })
      if (steward && localAgentId != null) {
        params.set('steward_local_agent_id', String(localAgentId))
      } else if (!steward && localAgentId != null) {
        params.set('worker_local_agent_id', String(localAgentId))
      }
      const res = await fetch(`/api/human-watch/interventions?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('interventionsLoadFailed'))
      setRows(Array.isArray(data.interventions) ? data.interventions : [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('interventionsLoadFailed'))
    } finally {
      setLoading(false)
    }
  }, [clientId, localAgentId, steward, t])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <Loader variant="inline" label={t('interventionsLoading')} />

  if (error) {
    return <p className="text-sm text-rose-400">{error}</p>
  }

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('interventionsEmpty')}</p>
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button
          type="button"
          className="text-xs text-cyan-400 hover:underline"
          onClick={() => void load()}
        >
          {t('refresh')}
        </button>
      </div>
      <ul className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono text-foreground/90">{row.event_type}</span>
              {row.decision ? <span>{row.decision}</span> : null}
              {row.outcome ? (
                <span
                  className={
                    row.outcome === 'success'
                      ? 'text-emerald-400'
                      : row.outcome === 'failed'
                        ? 'text-rose-400'
                        : 'text-amber-400'
                  }
                >
                  {row.outcome}
                </span>
              ) : null}
              <span className="ml-auto">{formatTs(row.created_at)}</span>
            </div>
            {row.prompt_preview ? (
              <p className="mt-1.5 text-foreground/80 line-clamp-3">{row.prompt_preview}</p>
            ) : null}
            {row.skip_reason ? (
              <p className="mt-1 text-xs text-amber-400/90">{row.skip_reason}</p>
            ) : null}
            {row.rules_hit && Object.keys(row.rules_hit).length > 0 ? (
              <p className="mt-1 text-[10px] font-mono text-muted-foreground/70 truncate">
                {JSON.stringify(row.rules_hit)}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatTs(ts: number): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString()
}
