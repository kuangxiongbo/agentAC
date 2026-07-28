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
  error_message: string | null
  evidence: {
    watch_event_id: string | null
    watch_event_status: string | null
    watch_event_priority: string | null
    message_id: string | null
    correlation_id: string | null
    mailbox_status: string | null
    attempt_count: number | null
    queued_at: number | null
    completed_at: number | null
    worker_reply: string | null
    last_error_code: string | null
    last_error_message: string | null
    trigger_at: number
    queue_delay_seconds: number | null
    delivery_duration_seconds: number | null
    total_duration_seconds: number | null
  }
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
            {row.evidence.worker_reply ? (
              <div className="mt-2 border-l-2 border-emerald-500/60 pl-2">
                <p className="text-[10px] text-muted-foreground">{t('interventionsWorkerReply')}</p>
                <p className="text-xs text-foreground/90 whitespace-pre-wrap">{row.evidence.worker_reply}</p>
              </div>
            ) : null}
            {(row.evidence.message_id || row.evidence.watch_event_id) ? (
              <div className="mt-2 grid gap-1 text-[10px] text-muted-foreground sm:grid-cols-2">
                {row.evidence.watch_event_id ? (
                  <p className="truncate" title={row.evidence.watch_event_id}>
                    {t('interventionsWatchEvent')}: <span className="font-mono">{row.evidence.watch_event_id}</span>
                    {row.evidence.watch_event_status ? ` · ${row.evidence.watch_event_status}` : ''}
                  </p>
                ) : null}
                {row.evidence.message_id ? (
                  <p className="truncate" title={row.evidence.message_id}>
                    {t('interventionsMessage')}: <span className="font-mono">{row.evidence.message_id}</span>
                  </p>
                ) : null}
                {row.evidence.correlation_id ? (
                  <p className="truncate sm:col-span-2" title={row.evidence.correlation_id}>
                    {t('interventionsCorrelation')}: <span className="font-mono">{row.evidence.correlation_id}</span>
                  </p>
                ) : null}
                {row.evidence.mailbox_status ? (
                  <p>
                    {t('interventionsDelivery')}: {row.evidence.mailbox_status}
                    {row.evidence.attempt_count != null ? ` · ${t('interventionsAttempts', { count: row.evidence.attempt_count })}` : ''}
                  </p>
                ) : null}
                <p>{formatTimeline(row)}</p>
              </div>
            ) : null}
            {(row.evidence.last_error_message || row.error_message) ? (
              <p className="mt-1 text-xs text-rose-400/90">
                {row.evidence.last_error_code ? `${row.evidence.last_error_code}: ` : ''}
                {row.evidence.last_error_message || row.error_message}
              </p>
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

function formatTimeline(row: InterventionRow): string {
  const evidence = row.evidence
  if (evidence.total_duration_seconds != null) {
    return `${formatTs(evidence.trigger_at ?? row.created_at)} -> ACK ${evidence.total_duration_seconds}s`
  }
  if (evidence.queued_at != null) {
    return `${formatTs(row.created_at)} -> ${formatTs(evidence.queued_at)}`
  }
  return formatTs(row.created_at)
}
