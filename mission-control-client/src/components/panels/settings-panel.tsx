'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
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

export function SettingsPanel() {
  const [settings, setSettings] = useState<Setting[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const [schedulerTasks, setSchedulerTasks] = useState<SchedulerTask[]>([])

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

  useEffect(() => {
    fetchSettings()
    fetchSchedulerStatus()
    const interval = setInterval(fetchSchedulerStatus, 30000)
    return () => clearInterval(interval)
  }, [fetchSettings, fetchSchedulerStatus])

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
        showFeedback(true, `Saved changes`)
        setEdits({})
        fetchSettings()
      } else {
        showFeedback(false, 'Failed to save')
      }
    } catch {
      showFeedback(false, 'Network error')
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
        showFeedback(true, data.message || 'Sync successful')
        fetchSchedulerStatus()
      } else {
        showFeedback(false, data.error || data.message || 'Sync failed')
      }
    } catch {
      showFeedback(false, 'Network error during sync')
    } finally {
      setSyncing(false)
    }
  }

  if (loading) return <Loader variant="panel" label="Loading settings" />

  const getVal = (key: string) => edits[key] ?? settings.find(s => s.key === key)?.value ?? ''
  const syncTask = schedulerTasks.find(t => t.id === 'server_gateway_sync')

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Local Client Settings</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Configure upstream Server Gateway</p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleSyncNow}
            disabled={syncing}
            variant="outline"
            size="sm"
          >
            {syncing ? 'Syncing...' : 'Sync Now'}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            variant={hasChanges ? 'default' : 'secondary'}
            size="sm"
          >
            {saving ? 'Saving...' : 'Save Changes'}
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
          <label className="block text-sm font-medium text-foreground mb-1">Server Gateway URL</label>
          <input
            type="text"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm"
            placeholder="http://192.168.x.x:3000"
            value={getVal('gateway.server_url')}
            onChange={(e) => handleEdit('gateway.server_url', e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">The URL of the central Mission Control server.</p>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Gateway API Token</label>
          <input
            type="password"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm"
            placeholder="api-key-here"
            value={getVal('gateway.token')}
            onChange={(e) => handleEdit('gateway.token', e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">Token generated on the central server for authentication.</p>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Local Client Name</label>
          <input
            type="text"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm"
            placeholder="MacBook-Pro"
            value={getVal('gateway.client_name')}
            onChange={(e) => handleEdit('gateway.client_name', e.target.value)}
          />
          <p className="text-xs text-muted-foreground mt-1">Identifier for this edge node.</p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">Sync Status</h3>
        <div className="space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Automatic Sync</span>
            <span className={syncTask?.enabled ? 'text-green-400' : 'text-yellow-400'}>
              {syncTask?.enabled ? 'Enabled (Every 60s)' : 'Disabled'}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Last Sync Result</span>
            <span className={syncTask?.lastResult?.ok ? 'text-green-400' : 'text-red-400'}>
              {syncTask?.lastResult?.message || 'Never run'}
            </span>
          </div>
          {syncTask?.lastRun && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Last Run At</span>
              <span>{new Date(syncTask.lastRun).toLocaleString()}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
