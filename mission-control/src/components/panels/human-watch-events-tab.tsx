'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'
import { useAgentCenterStore } from '@/store'

interface HumanWatchEventRow {
  id: string
  client_id: string
  worker_name: string | null
  worker_session_id: string | null
  steward_name: string | null
  source: string
  status: string
  priority: string
  title: string
  summary: string
  latest_worker_message: string | null
  permission_request_id: string | null
  suggested_action: string | null
  created_at: number
}

type EventViewMode = 'pending' | 'active' | 'history'

export function HumanWatchEventsTab({
  clientId,
  workerLocalAgentId,
  stewardLocalAgentId,
}: {
  clientId?: string | null
  workerLocalAgentId?: number | null
  stewardLocalAgentId?: number | null
}) {
  const t = useTranslations('humanWatch')
  const { humanWatchEvents, setHumanWatchEvents } = useAgentCenterStore()
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<EventViewMode>('active')

  const visibleEvents = useMemo(() => {
    return humanWatchEvents
      .filter((event) => event.client_id === clientId)
      .filter((event) => (workerLocalAgentId != null ? event.worker_local_agent_id === workerLocalAgentId : true))
      .filter((event) => (stewardLocalAgentId != null ? event.steward_local_agent_id === stewardLocalAgentId : true))
      .filter((event) => {
        if (viewMode === 'pending') return event.status === 'pending'
        if (viewMode === 'active') return event.status === 'pending' || event.status === 'visible' || event.status === 'claimed'
        return event.status === 'resolved' || event.status === 'dismissed' || event.status === 'expired'
      })
      .sort((a, b) => b.created_at - a.created_at)
  }, [humanWatchEvents, clientId, workerLocalAgentId, stewardLocalAgentId, viewMode])

  const load = useCallback(async () => {
    if (!clientId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        client_id: clientId,
        limit: '30',
      })
      if (viewMode === 'pending') params.set('status', 'pending')
      if (workerLocalAgentId != null) params.set('worker_local_agent_id', String(workerLocalAgentId))
      if (stewardLocalAgentId != null) params.set('steward_local_agent_id', String(stewardLocalAgentId))
      const res = await fetch(`/api/human-watch/events?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('eventsLoadFailed'))
      setHumanWatchEvents(Array.isArray(data.events) ? data.events : [])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('eventsLoadFailed'))
    } finally {
      setLoading(false)
    }
  }, [clientId, workerLocalAgentId, stewardLocalAgentId, t, setHumanWatchEvents, viewMode])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!clientId) return
    const timer = window.setInterval(() => {
      void load()
    }, 8000)
    return () => window.clearInterval(timer)
  }, [clientId, load])

  const handleAction = async (
    eventId: string,
    action: 'send_message_to_worker' | 'approve_request' | 'deny_request' | 'dismiss',
  ) => {
    setBusyId(eventId)
    setError(null)
    setMessage(null)
    try {
      const body: Record<string, unknown> = { action }
      if (action === 'send_message_to_worker') {
        const input = window.prompt(t('eventsReplyPrompt'))
        if (!input?.trim()) {
          setBusyId(null)
          return
        }
        body.message = input.trim()
      }
      const res = await fetch(`/api/human-watch/events/${encodeURIComponent(eventId)}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('eventsActionFailed'))
      setMessage(t('eventsActionSuccess'))
      await load()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('eventsActionFailed'))
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <Loader variant="inline" label={t('eventsLoading')} />
  if (error) return <p className="text-sm text-rose-400">{error}</p>

  return (
    <div className="space-y-3">
      {message ? <p className="text-sm text-emerald-400">{message}</p> : null}
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-2">
          {(['pending', 'active', 'history'] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={viewMode === mode ? 'secondary' : 'ghost'}
              onClick={() => setViewMode(mode)}
            >
              {t(mode === 'pending' ? 'eventsViewPending' : mode === 'active' ? 'eventsViewActive' : 'eventsViewHistory')}
            </Button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          {t('refresh')}
        </Button>
      </div>
      {visibleEvents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('eventsEmpty')}</p>
      ) : (
        <ul className="space-y-3">
          {visibleEvents.map((event) => (
            <li key={event.id} className="rounded-lg border border-border/60 bg-card p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono text-foreground/80">{event.source}</span>
                <span>{event.priority}</span>
                <span>{event.status}</span>
                <span className="ml-auto">{new Date(event.created_at * 1000).toLocaleString()}</span>
              </div>
              <div className="text-sm font-medium text-foreground">{event.title}</div>
              <div className="text-sm text-muted-foreground">{event.summary}</div>
              <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground/80">
                {event.worker_name ? <span>worker: {event.worker_name}</span> : null}
                {event.steward_name ? <span>steward: {event.steward_name}</span> : null}
                {event.worker_session_id ? <span>session: {event.worker_session_id}</span> : null}
                {event.permission_request_id ? <span>request: {event.permission_request_id}</span> : null}
              </div>
              {event.latest_worker_message ? (
                <div className="text-xs font-mono text-muted-foreground/80 line-clamp-3">
                  {event.latest_worker_message}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busyId === event.id}
                  onClick={() => void handleAction(event.id, 'send_message_to_worker')}
                >
                  {t('eventsReplyAction')}
                </Button>
                {event.permission_request_id ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyId === event.id}
                      onClick={() => void handleAction(event.id, 'approve_request')}
                    >
                      {t('eventsApproveAction')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === event.id}
                      onClick={() => void handleAction(event.id, 'deny_request')}
                    >
                      {t('eventsDenyAction')}
                    </Button>
                  </>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === event.id}
                  onClick={() => void handleAction(event.id, 'dismiss')}
                >
                  {t('eventsDismissAction')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
