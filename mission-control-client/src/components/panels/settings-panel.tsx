'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'

interface Setting {
  key: string
  value: string
}

interface SchedulerTask {
  id: string
  name: string
  enabled: boolean
  lastRun: number | null
  nextRun: number
  running: boolean
  lastResult?: { ok: boolean; message: string; timestamp: number }
}

interface ServerSyncDiagnostics {
  upstream: {
    server_url: string
    client_name: string
    token_configured: boolean
    bridge_info?: {
      ok: boolean
      status?: number
      error?: string
      payload?: {
        service?: { http_base_url?: string }
        bridge?: { ws_url?: string; port?: number }
        gateway?: { http_base_url?: string }
      }
    }
  }
  scheduler: {
    tasks: SchedulerTask[]
  }
  local_counts: {
    total: number
    bridge: number
    runtime: number
    local: number
  }
  backlog: {
    unsynced_messages: number
    remote_tasks_pending_notify: number
    remote_tasks_total: number
  }
}

export function SettingsPanel() {
  const t = useTranslations('settings')
  const [settings, setSettings] = useState<Setting[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const [schedulerTasks, setSchedulerTasks] = useState<SchedulerTask[]>([])
  const [syncDiagnostics, setSyncDiagnostics] = useState<ServerSyncDiagnostics | null>(null)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)

  const showFeedback = (ok: boolean, text: string) => {
    setFeedback({ ok, text })
    setTimeout(() => setFeedback(null), 3000)
  }

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings')
      if (res.ok) {
        const data = await res.json()
        setSettings(data.settings || [])
      }
    } catch {
       // Silent
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchSchedulerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/scheduler')
      if (res.ok) {
        const data = await res.json()
        setSchedulerTasks(data.tasks || [])
      }
    } catch {
      // Silent
    }
  }, [])

  const fetchSyncDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true)
    try {
      const res = await fetch('/api/server-sync/status')
      if (res.ok) {
        const data = await res.json()
        setSyncDiagnostics(data)
      }
    } catch {
      // Silent
    } finally {
      setDiagnosticsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
    fetchSchedulerStatus()
    fetchSyncDiagnostics()
    const interval = setInterval(() => {
      fetchSchedulerStatus()
      fetchSyncDiagnostics()
    }, 30000)
    return () => clearInterval(interval)
  }, [fetchSettings, fetchSchedulerStatus, fetchSyncDiagnostics])

  const handleEdit = (key: string, value: string) => {
    setEdits(prev => ({ ...prev, [key]: value }))
  }

  const hasChanges = Object.keys(edits).length > 0

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: edits }),
      })
      if (res.ok) {
        showFeedback(true, t('clientChangesSaved'))
        setEdits({})
        fetchSettings()
      } else {
        showFeedback(false, t('saveFailed'))
      }
    } catch {
      showFeedback(false, t('networkError'))
    } finally {
      setSaving(false)
    }
  }

  const handleSyncNow = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: 'server_gateway_sync' }),
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        showFeedback(true, data.message || t('clientSyncSuccessful'))
        fetchSchedulerStatus()
        fetchSyncDiagnostics()
      } else {
        showFeedback(false, data.error || data.message || t('clientSyncFailed'))
      }
    } catch {
      showFeedback(false, t('clientSyncNetworkError'))
    } finally {
      setSyncing(false)
    }
  }

  if (loading) return <Loader variant="panel" label={t('loadingSettings')} />

  const getVal = (key: string) => edits[key] ?? settings.find(s => s.key === key)?.value ?? ''
  const syncTask = schedulerTasks.find(t => t.id === 'server_gateway_sync')
  const diagnosticSyncTask = syncDiagnostics?.scheduler.tasks.find(t => t.id === 'server_gateway_sync')
  const bridgeInfo = syncDiagnostics?.upstream.bridge_info
  const discoveredHttpBase = bridgeInfo?.payload?.service?.http_base_url || ''
  const discoveredWsUrl = bridgeInfo?.payload?.bridge?.ws_url || ''

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('clientTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('clientDescription')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleSyncNow}
            disabled={syncing}
            variant="outline"
            size="sm"
          >
            {syncing ? t('clientSyncing') : t('clientSyncNow')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            variant={hasChanges ? 'default' : 'secondary'}
            size="sm"
          >
            {saving ? t('saving') : t('saveChanges')}
          </Button>
        </div>
      </div>

      {feedback && (
        <div className={`rounded-lg p-3 text-xs font-medium ${feedback.ok ? 'bg-green-500/10 text-green-400' : 'bg-destructive/10 text-destructive'}`}>
          {feedback.text}
        </div>
      )}

      <div className="space-y-4 bg-card border border-border rounded-lg p-4 mt-6">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('clientServerGatewayUrlLabel')}</label>
          <input
            type="text"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm"
            placeholder={t('clientServerGatewayUrlPlaceholder')}
            value={getVal('gateway.server_url')}
            onChange={(e) => handleEdit('gateway.server_url', e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">{t('clientServerGatewayUrlHint')}</p>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('clientGatewayApiTokenLabel')}</label>
          <input
            type="password"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm"
            placeholder={t('clientGatewayApiTokenPlaceholder')}
            value={getVal('gateway.token')}
            onChange={(e) => handleEdit('gateway.token', e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">{t('clientGatewayApiTokenHint')}</p>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">{t('clientLocalClientNameLabel')}</label>
          <input
            type="text"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm"
            placeholder={t('clientLocalClientNamePlaceholder')}
            value={getVal('gateway.client_name')}
            onChange={(e) => handleEdit('gateway.client_name', e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">{t('clientLocalClientNameHint')}</p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">{t('clientSyncStatusTitle')}</h3>
        <div className="space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">{t('clientAutomaticSync')}</span>
            <span className={syncTask?.enabled ? 'text-green-400' : 'text-yellow-400'}>
              {syncTask?.enabled ? t('clientEnabledEvery60s') : t('disabled')}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">{t('clientLastSyncResult')}</span>
            <span className={syncTask?.lastResult?.ok ? 'text-green-400' : 'text-red-400'}>
              {syncTask?.lastResult?.message || t('neverRun')}
            </span>
          </div>
          {syncTask?.lastRun && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{t('clientLastRunAt')}</span>
              <span>{new Date(syncTask.lastRun).toLocaleString()}</span>
            </div>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">{t('syncDiagnosticsTitle')}</h3>
          <Button
            onClick={fetchSyncDiagnostics}
            variant="outline"
            size="xs"
            disabled={diagnosticsLoading}
          >
            {diagnosticsLoading ? t('syncDiagnosticsRefreshing') : t('syncDiagnosticsRefresh')}
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-border/60 bg-surface-1/40 p-3 space-y-2">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('configuredParentUrl')}</span>
              <span className="font-mono text-right break-all">{syncDiagnostics?.upstream.server_url || getVal('gateway.server_url') || '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('discoveredHttpBase')}</span>
              <span className="font-mono text-right break-all">{discoveredHttpBase || '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('discoveredBridgeWs')}</span>
              <span className="font-mono text-right break-all">{discoveredWsUrl || '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('tokenConfigured')}</span>
              <span className={syncDiagnostics?.upstream.token_configured ? 'text-green-400' : 'text-yellow-400'}>
                {syncDiagnostics?.upstream.token_configured ? t('yes') : t('no')}
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-surface-1/40 p-3 space-y-2">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('discoveryStatus')}</span>
              <span className={bridgeInfo?.ok ? 'text-green-400' : 'text-red-400'}>
                {bridgeInfo ? (bridgeInfo.ok ? t('reachable') : t('failed')) : t('unknown')}
              </span>
            </div>
            {bridgeInfo?.error && <div className="text-destructive break-words">{bridgeInfo.error}</div>}
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('clientLocalAgents')}</span>
              <span>{syncDiagnostics?.local_counts.total ?? '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('unsyncedMessages')}</span>
              <span>{syncDiagnostics?.backlog.unsynced_messages ?? '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('pendingRemoteTaskNotify')}</span>
              <span>{syncDiagnostics?.backlog.remote_tasks_pending_notify ?? '-'}</span>
            </div>
          </div>
        </div>

        {diagnosticSyncTask && (
          <div className="rounded-lg border border-border/60 bg-surface-1/40 p-3 text-xs space-y-1">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('periodicUpstreamSync')}</span>
              <span className={diagnosticSyncTask.enabled ? 'text-green-400' : 'text-yellow-400'}>
                {diagnosticSyncTask.enabled ? t('enabled') : t('disabled')}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('lastResult')}</span>
              <span className={diagnosticSyncTask.lastResult?.ok ? 'text-green-400' : 'text-red-400'}>
                {diagnosticSyncTask.lastResult?.message || t('neverRun')}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
