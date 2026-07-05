'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader } from '@/components/ui/loader'

type EdgeMessageStatus =
  | 'pending'
  | 'leased'
  | 'completed'
  | 'failed_retryable'
  | 'dead_letter'
  | 'cancelled'

interface EdgeMessageRow {
  id: string
  client_id: string
  type: string
  status: EdgeMessageStatus
  correlation_id: string
  attempt_count: number
  last_error_code: string | null
  last_error_message: string | null
  created_at: number
  updated_at: number
}

const WATCH_STATUSES: EdgeMessageStatus[] = [
  'pending',
  'leased',
  'failed_retryable',
  'dead_letter',
]

export function HumanWatchMailboxPanel() {
  const [messages, setMessages] = useState<EdgeMessageRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const batches = await Promise.all(
        WATCH_STATUSES.map(async (status) => {
          const params = new URLSearchParams({
            status,
            limit: status === 'pending' || status === 'leased' ? '50' : '20',
          })
          const res = await fetch(`/api/edge/messages?${params}`, { cache: 'no-store' })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.error || `Failed to load ${status}`)
          return Array.isArray(data.messages) ? data.messages as EdgeMessageRow[] : []
        }),
      )
      setMessages(
        batches
          .flat()
          .filter((message) => message.type.startsWith('human_watch.')
            || message.type.startsWith('session.')
            || message.type.startsWith('permission.'))
          .sort((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mailbox backlog')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const counts = useMemo(() => {
    return WATCH_STATUSES.reduce<Record<EdgeMessageStatus, number>>((acc, status) => {
      acc[status] = messages.filter((message) => message.status === status).length
      return acc
    }, {
      pending: 0,
      leased: 0,
      completed: 0,
      failed_retryable: 0,
      dead_letter: 0,
      cancelled: 0,
    })
  }, [messages])

  if (loading) return <Loader variant="inline" label="加载消息队列…" />

  if (error) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-rose-400">{error}</p>
        <RefreshButton onClick={load} />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge label="pending" value={counts.pending} tone="amber" />
          <Badge label="leased" value={counts.leased} tone="cyan" />
          <Badge label="retry" value={counts.failed_retryable} tone="rose" />
          <Badge label="dead" value={counts.dead_letter} tone="rose" />
        </div>
        <RefreshButton onClick={load} />
      </div>

      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无待处理或失败的可靠消息。</p>
      ) : (
        <div className="max-h-[360px] overflow-y-auto rounded-lg border border-border/60">
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Client</th>
                <th className="px-3 py-2 text-left font-medium">Type</th>
                <th className="px-3 py-2 text-left font-medium">Attempts</th>
                <th className="px-3 py-2 text-left font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((message) => (
                <tr key={message.id} className="border-b border-border/40 last:border-0">
                  <td className="px-3 py-2">
                    <span className={statusClass(message.status)}>{message.status}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-foreground/80">{message.client_id}</td>
                  <td className="px-3 py-2">
                    <div className="font-mono text-foreground/80">{message.type}</div>
                    {message.last_error_message ? (
                      <div className="mt-1 max-w-[320px] truncate text-rose-300/90">
                        {message.last_error_code ? `${message.last_error_code}: ` : ''}
                        {message.last_error_message}
                      </div>
                    ) : (
                      <div className="mt-1 max-w-[320px] truncate text-muted-foreground">
                        {message.correlation_id}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">{message.attempt_count}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatTs(message.updated_at || message.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Badge({ label, value, tone }: { label: string; value: number; tone: 'amber' | 'cyan' | 'rose' }) {
  const color = tone === 'amber'
    ? 'border-amber-500/40 text-amber-300'
    : tone === 'cyan'
      ? 'border-cyan-500/40 text-cyan-300'
      : 'border-rose-500/40 text-rose-300'
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-1 ${color}`}>
      <span>{label}</span>
      <span className="font-mono">{value}</span>
    </span>
  )
}

function RefreshButton({ onClick }: { onClick: () => void | Promise<void> }) {
  return (
    <button type="button" className="text-xs text-cyan-400 hover:underline" onClick={() => void onClick()}>
      刷新
    </button>
  )
}

function statusClass(status: EdgeMessageStatus): string {
  if (status === 'pending') return 'text-amber-300'
  if (status === 'leased') return 'text-cyan-300'
  if (status === 'failed_retryable' || status === 'dead_letter') return 'text-rose-300'
  return 'text-muted-foreground'
}

function formatTs(ts: number): string {
  if (!ts) return '-'
  return new Date(ts * 1000).toLocaleString()
}
