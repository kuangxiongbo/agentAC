'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { LanguageSwitcherSelect } from '@/components/ui/language-switcher'
import { useAgentCenterStore } from '@/store'
import { useNavigateToPanel } from '@/lib/navigation'
import { SecurityScanCard } from '@/components/onboarding/security-scan-card'
import { AgentRuntimesSection } from '@/components/settings/agent-runtimes-section'
import { Loader } from '@/components/ui/loader'
import { clearOnboardingDismissedThisSession, clearOnboardingReplayFromStart } from '@/lib/onboarding-session'
import { resolveCoordinatorDeliveryTarget, type CoordinatorAgentRecord } from '@/lib/coordinator-routing'
import type { GatewaySession } from '@/lib/sessions'

interface Setting {
  key: string
  value: string
  description: string
  category: string
  updated_by: string | null
  updated_at: number | null
  is_default: boolean
}

interface ApiKeyInfo {
  masked_key: string | null
  source: string
  last_rotated_at: number | null
  last_rotated_by: string | null
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

interface CoordinatorTargetAgent {
  name: string
  openclawId: string
  isDefault: boolean
  sessionKey: string | null
  configRaw: string
}

type CoordinatorSession = GatewaySession & { source?: string }

const COORDINATOR_AGENT = (process.env.NEXT_PUBLIC_COORDINATOR_AGENT || 'coordinator').toLowerCase()

function parseCoordinatorTargetAgents(rawAgents: any[]): CoordinatorTargetAgent[] {
  const out: CoordinatorTargetAgent[] = []
  for (const raw of rawAgents || []) {
    const name = typeof raw?.name === 'string' ? raw.name.trim() : ''
    if (!name) continue
    const config = raw?.config && typeof raw.config === 'object' ? raw.config : {}
    const openclawIdRaw = typeof config.openclawId === 'string' && config.openclawId.trim()
      ? config.openclawId.trim()
      : name
    const openclawId = openclawIdRaw.toLowerCase().replace(/\s+/g, '-')
    out.push({
      name,
      openclawId,
      isDefault: config.isDefault === true,
      sessionKey: typeof raw?.session_key === 'string' && raw.session_key.trim() ? raw.session_key.trim() : null,
      configRaw: JSON.stringify(config),
    })
  }

  const unique = new Map<string, CoordinatorTargetAgent>()
  for (const agent of out) {
    const key = agent.openclawId || agent.name.toLowerCase()
    if (!unique.has(key)) unique.set(key, agent)
  }

  return Array.from(unique.values()).sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

const categoryOrder = ['general', 'security', 'profiles', 'retention', 'chat', 'gateway', 'custom']

export function SettingsPanel() {
  const t = useTranslations('settings')
  const { currentUser, setShowOnboarding, centralMode } = useAgentCenterStore()
  const navigateToPanel = useNavigateToPanel()
  const [settings, setSettings] = useState<Setting[]>([])
  const [grouped, setGrouped] = useState<Record<string, Setting[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)

  // Track edited values (key -> new value)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [activeCategory, setActiveCategory] = useState('general')
  const [schedulerTasks, setSchedulerTasks] = useState<any[]>([])
  const [syncDiagnostics, setSyncDiagnostics] = useState<any | null>(null)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)

  // API key management state
  const [apiKeyInfo, setApiKeyInfo] = useState<ApiKeyInfo | null>(null)
  const [apiKeyLoading, setApiKeyLoading] = useState(false)
  const [newApiKey, setNewApiKey] = useState<string | null>(null)
  const [rotateConfirm, setRotateConfirm] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [keyCopied, setKeyCopied] = useState(false)
  const [showSecurityScan, setShowSecurityScan] = useState(false)
  const [hookProfile, setHookProfile] = useState<string>('standard')
  const [hookProfileSaving, setHookProfileSaving] = useState(false)
  const [coordinatorTargetAgents, setCoordinatorTargetAgents] = useState<CoordinatorTargetAgent[]>([])
  const [coordinatorSessions, setCoordinatorSessions] = useState<CoordinatorSession[]>([])

  // Replay onboarding state
  const [replayingOnboarding, setReplayingOnboarding] = useState(false)

  // Hermes integration state
  const [hermesStatus, setHermesStatus] = useState<{
    installed: boolean
    gatewayRunning: boolean
    hookInstalled: boolean
    activeSessions: number
    cronJobCount?: number
    memoryEntries?: number
  } | null>(null)
  const [hermesLoading, setHermesLoading] = useState(false)
  const [hermesHookAction, setHermesHookAction] = useState(false)

  // Backup state
  const [mcBackupRunning, setMcBackupRunning] = useState(false)
  const [gwBackupRunning, setGwBackupRunning] = useState(false)

  const categoryLabels = useMemo<Record<string, { label: string; icon: string; description: string }>>(() => ({
    general: { label: t('categoryGeneralLabel'), icon: '⚙', description: '' },
    security: { label: t('categorySecurityLabel'), icon: '🔑', description: '' },
    retention: { label: t('categoryRetentionLabel'), icon: '🗄', description: '' },
    chat: { label: t('categoryChatLabel'), icon: '💬', description: '' },
    gateway: { label: t('categoryGatewayLabel'), icon: '🔌', description: '' },
    profiles: { label: t('categoryProfilesLabel'), icon: 'shield', description: '' },
    custom: { label: t('categoryCustomLabel'), icon: '🔧', description: '' },
  }), [t])

  const subscriptionDropdowns = useMemo<Record<string, { label: string; value: string }[]>>(() => ({
    'subscription.plan_override': [
      { label: t('subscriptionAutoDetect'), value: '' },
      { label: t('subscriptionPlanPro20'), value: 'pro' },
      { label: t('subscriptionPlanMax100'), value: 'max' },
      { label: t('subscriptionPlanMax5x200'), value: 'max_5x' },
      { label: t('subscriptionPlanTeam30'), value: 'team' },
      { label: t('subscriptionPlanEnterprise'), value: 'enterprise' },
    ],
    'subscription.codex_plan': [
      { label: t('subscriptionPlanNone'), value: '' },
      { label: t('subscriptionPlanChatgptFree'), value: 'chatgpt' },
      { label: t('subscriptionPlanPlus20'), value: 'plus' },
      { label: t('subscriptionPlanPro200'), value: 'pro' },
      { label: t('subscriptionPlanTeam30'), value: 'team' },
    ],
  }), [t])

  const showFeedback = (ok: boolean, text: string) => {
    setFeedback({ ok, text })
    setTimeout(() => setFeedback(null), 3000)
  }

  const getCoordinatorResolutionPreview = useCallback((configuredTarget: string) => {
    const allAgents: CoordinatorAgentRecord[] = coordinatorTargetAgents.map(agent => ({
      name: agent.name,
      session_key: agent.sessionKey,
      config: agent.configRaw,
    }))
    const directAgent = allAgents.find(agent => agent.name.toLowerCase() === COORDINATOR_AGENT) || null
    const gatewaySessions = coordinatorSessions.filter(session => (session.source || 'gateway') === 'gateway')

    const resolved = resolveCoordinatorDeliveryTarget({
      to: COORDINATOR_AGENT,
      coordinatorAgent: COORDINATOR_AGENT,
      directAgent,
      allAgents,
      sessions: gatewaySessions,
      configuredCoordinatorTarget: configuredTarget || null,
    })

    const viaLabel: Record<string, string> = {
      configured: t('coordinatorViaConfigured'),
      default: t('coordinatorViaDefault'),
      main_session: t('coordinatorViaMainSession'),
      direct: t('coordinatorViaDirect'),
      fallback: t('coordinatorViaFallback'),
    }

    const targetLabel = `${resolved.deliveryName}${resolved.openclawAgentId ? ` (${resolved.openclawAgentId})` : ''}`
    return t('coordinatorResolutionPreview', { target: targetLabel, via: viaLabel[resolved.resolvedBy] || resolved.resolvedBy })
  }, [coordinatorTargetAgents, coordinatorSessions, t])

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings')
      if (res.status === 401) {
        window.location.assign('/login?next=%2Fsettings')
        return
      }
      if (res.status === 403) {
        setError(t('adminAccessRequired'))
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || t('failedToLoadSettings'))
        return
      }
      const data = await res.json()
      setSettings(data.settings || [])
      setGrouped(data.grouped || {})
      // Load hook profile from settings
      const hpSetting = (data.settings || []).find((s: Setting) => s.key === 'hook_profile')
      if (hpSetting) setHookProfile(hpSetting.value)

      // Load agent options for coordinator routing dropdown
      try {
        const agentsRes = await fetch('/api/agents?limit=200')
        if (agentsRes.ok) {
          const agentsData = await agentsRes.json()
          setCoordinatorTargetAgents(parseCoordinatorTargetAgents(agentsData.agents || []))
        }
      } catch {
        // non-critical
      }

      // Load live sessions to preview coordinator routing resolution
      try {
        const sessionsRes = await fetch('/api/sessions')
        if (sessionsRes.ok) {
          const sessionsData = await sessionsRes.json()
          const mapped: CoordinatorSession[] = Array.isArray(sessionsData.sessions)
            ? sessionsData.sessions.map((session: any) => ({
                key: String(session?.key || ''),
                agent: String(session?.agent || ''),
                source: typeof session?.source === 'string' ? session.source : undefined,
                sessionId: String(session?.id || session?.key || ''),
                updatedAt: Number(session?.lastActivity || session?.startTime || 0),
                chatType: String(session?.kind || 'unknown'),
                channel: String(session?.channel || ''),
                model: String(session?.model || ''),
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                contextTokens: 0,
                active: Boolean(session?.active),
              })).filter((session: CoordinatorSession) => session.key && session.agent)
            : []
          setCoordinatorSessions(mapped)
        }
      } catch {
        // non-critical
      }
    } catch {
      setError(t('failedToLoadSettings'))
    } finally {
      setLoading(false)
    }
  }, [t])

  const fetchSyncDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true)
    try {
      const res = await fetch('/api/server-sync/status')
      if (res.ok) {
        setSyncDiagnostics(await res.json())
      }
    } catch {
      // non-critical
    } finally {
      setDiagnosticsLoading(false)
    }
  }, [])

  const fetchApiKeyInfo = useCallback(async () => {
    setApiKeyLoading(true)
    try {
      const res = await fetch('/api/tokens/rotate')
      if (res.ok) {
        const data = await res.json()
        setApiKeyInfo(data)
      }
    } catch {
      // Silent — non-critical
    } finally {
      setApiKeyLoading(false)
    }
  }, [])

  const handleRotateKey = useCallback(async () => {
    setRotating(true)
    try {
      const res = await fetch('/api/tokens/rotate', { method: 'POST' })
      const data = (await res.json().catch(() => ({}))) as { error?: string; key?: string }
      if (res.ok && typeof data.key === 'string') {
        setNewApiKey(data.key)
        setRotateConfirm(false)
        setKeyCopied(false)
        await fetchApiKeyInfo()
      } else {
        showFeedback(false, data.error || t('saveFailed'))
      }
    } catch {
      showFeedback(false, t('networkError'))
    } finally {
      setRotating(false)
    }
  }, [fetchApiKeyInfo, t])

  const handleCopyKey = useCallback(async () => {
    if (!newApiKey) return
    try {
      await navigator.clipboard.writeText(newApiKey)
      setKeyCopied(true)
      setTimeout(() => setKeyCopied(false), 2500)
    } catch {
      showFeedback(false, t('networkError'))
    }
  }, [newApiKey, t])

  const fetchHermesStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/hermes')
      if (res.ok) {
        setHermesStatus(await res.json())
      }
    } catch { /* non-critical */ }
  }, [])

  useEffect(() => {
    fetchSettings()
    fetchApiKeyInfo()
    fetchHermesStatus()
    fetchSyncDiagnostics()
    const interval = setInterval(() => {
      fetchSyncDiagnostics()
    }, 30000)
    return () => clearInterval(interval)
  }, [fetchSettings, fetchApiKeyInfo, fetchHermesStatus, fetchSyncDiagnostics])

  const handleEdit = (key: string, value: string) => {
    setEdits(prev => ({ ...prev, [key]: value }))
  }

  const hasChanges = Object.keys(edits).some(key => {
    const setting = settings.find(s => s.key === key)
    return setting && edits[key] !== setting.value
  })

  const handleSave = async () => {
    const changes: Record<string, string> = {}
    for (const [key, value] of Object.entries(edits)) {
      const setting = settings.find(s => s.key === key)
      if (setting && value !== setting.value) {
        changes[key] = value
      }
    }

    if (Object.keys(changes).length === 0) return

    setSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: changes }),
      })
      const data = await res.json()
      if (res.ok) {
        showFeedback(true, t('savedSettingsCount', { count: data.count }))
        setEdits({})
        fetchSettings()
      } else {
        showFeedback(false, data.error || t('saveFailed'))
      }
    } catch {
      showFeedback(false, t('networkError'))
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async (key: string) => {
    try {
      const res = await fetch(`/api/settings?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
      const data = await res.json()
      if (res.ok) {
        showFeedback(true, t('resetToDefaultSuccess', { key }))
        setEdits(prev => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        fetchSettings()
      } else {
        showFeedback(false, data.error || t('resetFailed'))
      }
    } catch {
      showFeedback(false, t('networkError'))
    }
  }

  const handleDiscard = () => {
    setEdits({})
  }

  if (loading) {
    return <Loader variant="panel" label={t('loadingSettings')} />
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-destructive/10 text-destructive rounded-lg p-4 text-sm">{error}</div>
      </div>
    )
  }

  const categories = categoryOrder.filter(c => c === 'security' || c === 'profiles' || (grouped[c]?.length > 0))
  const discovery = syncDiagnostics?.upstream.bridge_info
  const discoveryHttpBase = discovery?.payload?.service?.http_base_url || ''
  const discoveryWsUrl = discovery?.payload?.bridge?.ws_url || ''
  const syncTask = syncDiagnostics?.scheduler?.tasks?.find((task: { id: string }) => task.id === 'server_gateway_sync')

  return (
    <div className="w-full min-w-0 max-w-4xl mx-auto space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          {hasChanges && (
            <Button
              onClick={handleDiscard}
              variant="outline"
              size="sm"
            >
              {t('discard')}
            </Button>
          )}
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            variant={hasChanges ? 'default' : 'secondary'}
            size="sm"
            className={!hasChanges ? 'cursor-not-allowed' : ''}
          >
            {saving ? t('saving') : t('saveChanges')}
          </Button>
        </div>
      </div>

      {/* Feedback */}
      {feedback && (
        <div className={`rounded-lg p-3 text-xs font-medium animate-in fade-in slide-in-from-top-1 duration-200 ${
          feedback.ok ? 'bg-green-500/10 text-green-400' : 'bg-destructive/10 text-destructive'
        }`}>
          {feedback.text}
        </div>
      )}

      {/* Category tabs */}
      <div className="flex w-full min-w-0 gap-1 border-b border-border pb-px overflow-x-auto no-scrollbar">
        {categories.map(cat => {
          const meta = categoryLabels[cat] || { label: cat, icon: '📋', description: '' }
          const changedCount = (grouped[cat] || []).filter(s => edits[s.key] !== undefined && edits[s.key] !== s.value).length
          return (
            <Button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              variant="ghost"
              size="sm"
              className={`rounded-t-md rounded-b-none relative whitespace-nowrap transition-all ${
                activeCategory === cat
                  ? 'bg-card text-foreground border border-border border-b-card -mb-px'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {meta.label}
              {changedCount > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 text-2xs rounded-full bg-primary text-primary-foreground">
                  {changedCount}
                </span>
              )}
            </Button>
          )
        })}
      </div>

      {/* General Category Content */}
      {activeCategory === 'general' && (
        <div className="w-full min-w-0 space-y-6 animate-in fade-in slide-in-from-top-2 duration-300">
          <LanguageSection />
          <InterfaceModeSelector />
          
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-foreground px-1">{t('stationManagementTitle')}</h3>
            
            {/* Workspace Info */}
            {currentUser?.role === 'admin' && (
              <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300">
                <strong className="text-blue-200">{t('workspaceManagementLabel')}</strong>{' '}
                {t('workspaceManagementDesc1')}{' '}
                <Button
                  onClick={() => navigateToPanel('super-admin')}
                  variant="link"
                  size="xs"
                  className="text-blue-400 hover:text-blue-300 p-0 h-auto"
                >
                  {t('superAdmin')}
                </Button>{' '}
                {t('workspaceManagementDesc2')}
              </div>
            )}

            {/* Replay Onboarding */}
            <div className="flex items-center gap-3 p-3 bg-surface-1/50 border border-border/30 rounded-lg">
              <div className="flex-1">
                <p className="text-xs font-medium">{t('onboarding')}</p>
                <p className="text-2xs text-muted-foreground">{t('onboardingDescription')}</p>
              </div>
              <Button
                variant="outline"
                size="xs"
                className="text-2xs"
                disabled={replayingOnboarding}
                onClick={async () => {
                  setReplayingOnboarding(true)
                  try {
                    await fetch('/api/onboarding', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'reset' }),
                    })
                    clearOnboardingDismissedThisSession()
                    clearOnboardingReplayFromStart()
                    setShowOnboarding(true)
                    showFeedback(true, t('onboardingResetSuccess'))
                  } catch {
                    showFeedback(false, t('onboardingResetFailed'))
                  } finally {
                    setReplayingOnboarding(false)
                  }
                }}
              >
                {replayingOnboarding ? t('resetting') : t('replayOnboarding')}
              </Button>
            </div>

            {/* Agent Runtimes */}
            {!centralMode ? (
              <AgentRuntimesSection showFeedback={showFeedback} />
            ) : (
              <div className="p-3 bg-surface-1/50 border border-border/30 rounded-lg">
                <p className="text-xs font-medium">{t('agentRuntimesTitle')}</p>
                <p className="text-2xs text-muted-foreground mt-0.5">
                  {t('centralModeRuntimeHint')}
                </p>
              </div>
            )}

            {/* Hermes Agent Integration */}
            {hermesStatus?.installed && (
              <div className="p-3 bg-surface-1/50 border border-border/30 rounded-lg space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-medium">{t('hermesTitle')}</p>
                      <span className={`text-2xs px-1.5 py-0.5 rounded ${
                        hermesStatus.gatewayRunning
                          ? 'bg-green-500/15 text-green-400'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {hermesStatus.gatewayRunning ? t('hermesGatewayRunning') : t('hermesGatewayOffline')}
                      </span>
                      {hermesStatus.activeSessions > 0 && (
                        <span className="text-2xs px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">
                          {t('hermesActiveCount', { count: hermesStatus.activeSessions })}
                        </span>
                      )}
                    </div>
                    <p className="text-2xs text-muted-foreground mt-0.5">
                      {hermesStatus.hookInstalled
                        ? t('hermesHookInstalledHint')
                        : t('hermesHookMissingHint')}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    className="text-2xs"
                    disabled={hermesHookAction}
                    onClick={async () => {
                      setHermesHookAction(true)
                      const action = hermesStatus.hookInstalled ? 'uninstall-hook' : 'install-hook'
                      try {
                        const res = await fetch('/api/hermes', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action }),
                        })
                        const data = await res.json()
                        if (res.ok) {
                          showFeedback(true, data.message || (action === 'install-hook' ? t('hookInstalled') : t('hookUninstalled')))
                          fetchHermesStatus()
                        } else {
                          showFeedback(false, data.error || t('hookOperationFailed'))
                        }
                      } catch {
                        showFeedback(false, t('networkError'))
                      } finally {
                        setHermesHookAction(false)
                      }
                    }}
                  >
                    {hermesHookAction
                      ? t('working')
                      : hermesStatus.hookInstalled
                        ? t('uninstallHook')
                        : t('installMcHook')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Gateway Category Content */}
      {activeCategory === 'gateway' && (
        <div className="w-full min-w-0 space-y-6 animate-in fade-in slide-in-from-top-2 duration-300">
          {/* Sync Diagnostics */}
          <div className="rounded-lg border border-border/50 bg-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-foreground">{t('syncDiagnosticsTitle')}</h3>
                <p className="text-2xs text-muted-foreground">{t('syncDiagnosticsDescription')}</p>
              </div>
              <Button
                variant="outline"
                size="xs"
                disabled={diagnosticsLoading}
                onClick={fetchSyncDiagnostics}
              >
                {diagnosticsLoading ? t('syncDiagnosticsRefreshing') : t('syncDiagnosticsRefresh')}
              </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="rounded-lg border border-border/40 bg-surface-1/40 p-3 space-y-2">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{t('configuredParentUrl')}</span>
                  <span className="font-mono text-right break-all">{syncDiagnostics?.upstream.server_url || '-'}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{t('discoveredHttpBase')}</span>
                  <span className="font-mono text-right break-all">{discoveryHttpBase || '-'}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{t('discoveredBridgeWs')}</span>
                  <span className="font-mono text-right break-all">{discoveryWsUrl || '-'}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{t('tokenConfigured')}</span>
                  <span className={syncDiagnostics?.upstream.token_configured ? 'text-green-400 font-medium' : 'text-yellow-400 font-medium'}>
                    {syncDiagnostics?.upstream.token_configured ? t('yes') : t('no')}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-border/40 bg-surface-1/40 p-3 space-y-2">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{t('discoveryStatus')}</span>
                  <span className={discovery?.ok ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
                    {discovery ? (discovery.ok ? t('reachable') : t('failed')) : t('unknown')}
                  </span>
                </div>
                {discovery?.error && <div className="text-destructive break-words">{discovery.error}</div>}
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{t('agentsCount')}</span>
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

            {syncTask && (
              <div className="rounded-lg border border-border/40 bg-surface-1/40 p-3 text-xs space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{t('periodicUpstreamSync')}</span>
                  <span className={syncTask.enabled ? 'text-green-400 font-medium' : 'text-yellow-400 font-medium'}>
                    {syncTask.enabled ? t('enabled') : t('disabled')}
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{t('lastResult')}</span>
                  <span className={syncTask.lastResult?.ok ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
                    {syncTask.lastResult?.message || t('neverRun')}
                  </span>
                </div>
              </div>
            )}
          </div>

          <DownstreamConnectionSection apiKeyInfo={apiKeyInfo} />
          <UpstreamSyncSection
            settings={settings}
            edits={edits}
            handleEdit={handleEdit}
            showFeedback={showFeedback}
          />
        </div>
      )}

      {/* Security Category Content */}
      {activeCategory === 'security' && (
        <div className="w-full min-w-0 space-y-6 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{t('apiKeyTitle')}</span>
                  {apiKeyInfo?.source && (
                    <span className="text-2xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                      {apiKeyInfo.source}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{t('apiKeyDescription')}</p>
              </div>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <code className="text-xs font-mono bg-background border border-border rounded px-3 py-2 text-muted-foreground/80 flex-1">
                {apiKeyLoading ? t('loadingApiKey') : apiKeyInfo?.masked_key || t('noApiKeyConfigured')}
              </code>
              <Button
                onClick={() => setRotateConfirm(true)}
                variant="outline"
                size="sm"
                className="h-9"
              >
                {t('rotateKey')}
              </Button>
            </div>

            {apiKeyInfo?.last_rotated_at && (
              <div className="text-[10px] text-muted-foreground/50 mt-3 flex items-center gap-2">
                <span className="w-1 h-1 rounded-full bg-muted-foreground/30" />
                {t('lastRotatedByOn', {
                  user: apiKeyInfo.last_rotated_by || '-',
                  date: new Date(apiKeyInfo.last_rotated_at * 1000).toLocaleDateString(),
                  time: new Date(apiKeyInfo.last_rotated_at * 1000).toLocaleTimeString(),
                })}
              </div>
            )}

            {rotateConfirm && (
              <div className="mt-4 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
                <p className="text-xs text-amber-300 mb-3">{t('rotateWarning')}</p>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleRotateKey}
                    disabled={rotating}
                    variant="default"
                    size="sm"
                    className="bg-amber-600 hover:bg-amber-700"
                  >
                    {rotating ? t('rotatingKey') : t('confirmRotate')}
                  </Button>
                  <Button
                    onClick={() => setRotateConfirm(false)}
                    variant="ghost"
                    size="sm"
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            )}

            {newApiKey && (
              <div className="mt-4 bg-green-500/10 border border-green-500/20 rounded-lg p-3">
                <p className="text-xs text-green-300 mb-2 font-medium">{t('newApiKeyGenerated')}</p>
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-background border border-border rounded px-3 py-2 text-foreground select-all flex-1 break-all">
                    {newApiKey}
                  </code>
                  <Button
                    onClick={handleCopyKey}
                    variant="outline"
                    size="sm"
                    className="shrink-0 h-9"
                  >
                    {keyCopied ? t('copied') : t('copy')}
                  </Button>
                </div>
                <div className="mt-2">
                  <Button
                    onClick={() => setNewApiKey(null)}
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                  >
                    {t('dismissLabel')}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-medium text-foreground">{t('securityScan')}</h3>
                <p className="text-xs text-muted-foreground">{t('securityDescription')}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSecurityScan(v => !v)}
              >
                {showSecurityScan ? t('hideScan') : t('securityScan')}
              </Button>
            </div>
            {showSecurityScan && (
              <div className="animate-in fade-in zoom-in-95 duration-200">
                <SecurityScanCard />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Profiles Category Content */}
      {activeCategory === 'profiles' && (
        <div className="w-full min-w-0 space-y-6 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="bg-card border border-border rounded-lg p-4">
            <h3 className="text-sm font-medium text-foreground mb-1">{t('hookProfileTitle')}</h3>
            <p className="text-xs text-muted-foreground mb-4">{t('hookProfileDescription')}</p>
            <div className="space-y-2">
              {([
                { value: 'minimal', label: t('hookProfileMinimalLabel'), desc: t('hookProfileMinimalDescription') },
                { value: 'standard', label: t('hookProfileStandardLabel'), desc: t('hookProfileStandardDescription') },
                { value: 'strict', label: t('hookProfileStrictLabel'), desc: t('hookProfileStrictDescription') },
              ] as const).map(profile => (
                <button
                  key={profile.value}
                  onClick={async () => {
                    setHookProfile(profile.value)
                    setHookProfileSaving(true)
                    try {
                      const res = await fetch('/api/settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ key: 'hook_profile', value: profile.value }),
                      })
                      if (res.ok) {
                        showFeedback(true, t('hookProfileSet', { profile: profile.label }))
                      } else {
                        showFeedback(false, t('hookProfileSaveFailed'))
                      }
                    } catch {
                      showFeedback(false, t('networkError'))
                    } finally {
                      setHookProfileSaving(false)
                    }
                  }}
                  disabled={hookProfileSaving}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    hookProfile === profile.value
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/30 bg-secondary'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                      hookProfile === profile.value ? 'border-primary' : 'border-muted-foreground/50'
                    }`}>
                      {hookProfile === profile.value && (
                        <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                      )}
                    </div>
                    <span className="text-sm font-medium text-foreground">{profile.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground ml-5">{profile.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Custom/Maintenance Category Content */}
      {activeCategory === 'custom' && (
        <div className="w-full min-w-0 space-y-6 animate-in fade-in slide-in-from-top-2 duration-300">
          {/* Backup Actions */}
          <div className="bg-card border border-border rounded-lg p-4 space-y-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">{t('backups')}</h3>
              <p className="text-xs text-muted-foreground">{t('backupsDescription')}</p>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={mcBackupRunning}
                onClick={async () => {
                  setMcBackupRunning(true)
                  try {
                    const res = await fetch('/api/backup', { method: 'POST' })
                    const data = await res.json()
                    if (res.ok) {
                      showFeedback(true, t('mcBackupCreated', { size: (data.backup?.size / 1024).toFixed(0) }))
                    } else {
                      showFeedback(false, data.error || t('mcBackupFailed'))
                    }
                  } catch {
                    showFeedback(false, t('networkError'))
                  } finally {
                    setMcBackupRunning(false)
                  }
                }}
              >
                {mcBackupRunning ? t('backingUp') : t('backupMcDatabase')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={gwBackupRunning}
                onClick={async () => {
                  setGwBackupRunning(true)
                  try {
                    const res = await fetch('/api/backup?target=gateway', { method: 'POST' })
                    const data = await res.json()
                    if (res.ok) {
                      showFeedback(true, t('gatewayBackupCreated', { output: data.output }))
                    } else {
                      showFeedback(false, data.error || t('gatewayBackupFailed'))
                    }
                  } catch {
                    showFeedback(false, t('networkError'))
                  } finally {
                    setGwBackupRunning(false)
                  }
                }}
              >
                {gwBackupRunning ? t('backingUp') : t('backupGatewayState')}
              </Button>
            </div>
          </div>

          <AccountOAuthSection />
        </div>
      )}

      {/* Standard Settings Rows for current category — w-full 与各 Tab 自定义区一致，避免仅 max-w 时随内容收缩 */}
      <div className="w-full min-w-0 space-y-3 animate-in fade-in duration-300">
        {(grouped[activeCategory] || [])
          .filter(s => activeCategory !== 'security' || s.key !== 'security.api_key') // Filter out already handled special keys
          .map(setting => {
          const currentValue = edits[setting.key] ?? setting.value
          const isChanged = edits[setting.key] !== undefined && edits[setting.key] !== setting.value
          const isBooleanish = setting.value === 'true' || setting.value === 'false'
          const isNumeric = /^\d+$/.test(setting.value)
          const coordinatorTargetOptions = setting.key === 'chat.coordinator_target_agent'
            ? [
                { label: t('coordinatorAutoFallback'), value: '' },
                ...coordinatorTargetAgents.map(agent => ({
                  label: `${agent.name}${agent.isDefault ? ` (${t('defaultBadge')})` : ''} — ${agent.openclawId}`,
                  value: agent.openclawId,
                })),
              ]
            : null
          const dropdownOptions = coordinatorTargetOptions || subscriptionDropdowns[setting.key]
          const coordinatorPreview = setting.key === 'chat.coordinator_target_agent'
            ? getCoordinatorResolutionPreview(currentValue)
            : null
          const shortKey = setting.key.split('.').pop() || setting.key
          const displayTitle = setting.description || formatLabel(shortKey)

          return (
            <div
              key={setting.key}
              className={`bg-card border rounded-lg p-4 transition-all ${
                isChanged ? 'border-primary/50 shadow-sm shadow-primary/5' : 'border-border'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{displayTitle}</span>
                    {setting.is_default && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium uppercase tracking-tighter">
                        {t('defaultBadge')}
                      </span>
                    )}
                    {isChanged && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium uppercase tracking-tighter">
                        {t('modifiedBadge')}
                      </span>
                    )}
                  </div>
                  <p className="text-2xs text-muted-foreground/60 mt-1 font-mono tracking-tight">{setting.key}</p>
                </div>

                <div className="flex flex-col items-end gap-1 shrink-0">
                  <div className="flex items-center gap-3">
                    {dropdownOptions ? (
                      <select
                        value={currentValue}
                        onChange={e => handleEdit(setting.key, e.target.value)}
                        className="w-64 px-3 py-1.5 text-sm bg-background border border-border rounded-md focus:border-primary focus:outline-none transition-colors"
                      >
                        {dropdownOptions.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                        {currentValue && !dropdownOptions.some(opt => opt.value === currentValue) && (
                          <option value={currentValue}>{t('customValuePrefix', { value: currentValue })}</option>
                        )}
                      </select>
                    ) : isBooleanish ? (
                    <button
                      onClick={() => handleEdit(setting.key, currentValue === 'true' ? 'false' : 'true')}
                      className={`w-11 h-6 rounded-full relative transition-colors select-none ${
                        currentValue === 'true' ? 'bg-primary' : 'bg-muted'
                      }`}
                    >
                      <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-200 ${
                        currentValue === 'true' ? 'left-6' : 'left-1'
                      }`} />
                    </button>
                  ) : isNumeric ? (
                    <input
                      type="number"
                      value={currentValue}
                      onChange={e => handleEdit(setting.key, e.target.value)}
                      className="w-28 px-3 py-1.5 text-sm text-right bg-background border border-border rounded-md focus:border-primary focus:outline-none font-mono"
                    />
                  ) : (
                    <input
                      type="text"
                      value={currentValue}
                      onChange={e => handleEdit(setting.key, e.target.value)}
                      className="w-56 px-3 py-1.5 text-sm bg-background border border-border rounded-md focus:border-primary focus:outline-none"
                    />
                  )}

                    {!setting.is_default && (
                      <Button
                        onClick={() => handleReset(setting.key)}
                        title={t('resetToDefault')}
                        variant="ghost"
                        size="icon-xs"
                        className="w-8 h-8 opacity-40 hover:opacity-100 transition-opacity"
                      >
                        <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M2 8a6 6 0 1111.3-2.8" strokeLinecap="round" />
                          <path d="M14 2v3.5h-3.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </Button>
                    )}
                  </div>
                  {coordinatorPreview && (
                    <p className="text-2xs text-muted-foreground/70 max-w-72 text-right mt-1 leading-tight italic">
                      {coordinatorPreview}
                    </p>
                  )}
                </div>
              </div>

              {setting.updated_by && setting.updated_at && (
                <div className="text-[10px] text-muted-foreground/40 mt-3 flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-muted-foreground/20" />
                  {t('lastUpdatedByOn', {
                    user: setting.updated_by,
                    date: new Date(setting.updated_at * 1000).toLocaleDateString(),
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Unsaved changes bar */}
      {hasChanges && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-card border border-border rounded-lg shadow-lg px-4 py-2.5 flex items-center gap-3 z-40">
          <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
          <span className="text-xs text-foreground">
            {t('unsavedChanges', { count: Object.keys(edits).filter(k => {
              const s = settings.find(s => s.key === k)
              return s && edits[k] !== s.value
            }).length })}
          </span>
          <Button
            onClick={handleDiscard}
            variant="ghost"
            size="xs"
          >
            {t('discard')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            size="xs"
          >
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      )}
    </div>
  )
}

function InterfaceModeSelector() {
  const t = useTranslations('settings')
  const { interfaceMode, setInterfaceMode } = useAgentCenterStore()
  const [saving, setSaving] = useState(false)
  const navigateToPanel = useNavigateToPanel()

  const handleChange = async (mode: 'essential' | 'full') => {
    setInterfaceMode(mode)
    setSaving(true)
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { 'general.interface_mode': mode } }),
      })
      // If switching to essential and on a hidden panel, redirect
      if (mode === 'essential') {
        const essentialIds = new Set(['overview', 'agents', 'tasks', 'chat', 'activity', 'logs', 'settings'])
        const store = useAgentCenterStore.getState()
        if (!essentialIds.has(store.activeTab)) {
          navigateToPanel('overview')
        }
      }
    } catch {}
    setSaving(false)
  }

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <h3 className="text-sm font-medium text-foreground mb-1">{t('interfaceModeTitle')}</h3>
      <p className="text-xs text-muted-foreground mb-3">{t('interfaceModeDescription')}</p>
      <div className="space-y-2">
        {([
          { value: 'essential' as const, label: t('interfaceEssentialLabel'), desc: t('interfaceEssentialDescription') },
          { value: 'full' as const, label: t('interfaceFullLabel'), desc: t('interfaceFullDescription') },
        ]).map(option => (
          <button
            key={option.value}
            onClick={() => handleChange(option.value)}
            disabled={saving}
            className={`w-full text-left p-3 rounded-lg border transition-colors ${
              interfaceMode === option.value
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/30 bg-secondary'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                interfaceMode === option.value ? 'border-primary' : 'border-muted-foreground/50'
              }`}>
                {interfaceMode === option.value && (
                  <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                )}
              </div>
              <span className="text-sm font-medium text-foreground">{option.label}</span>
            </div>
            <p className="text-xs text-muted-foreground ml-5">{option.desc}</p>
          </button>
        ))}
      </div>
      <p className="text-2xs text-muted-foreground/60 mt-2">{t('interfaceSidebarHint')}</p>
    </div>
  )
}

function LanguageSection() {
  const ts = useTranslations('settings')
  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-foreground">{ts('language')}</p>
          <p className="text-2xs text-muted-foreground mt-0.5">{ts('languageDescription')}</p>
        </div>
        <LanguageSwitcherSelect />
      </div>
    </div>
  )
}

/** Convert snake_case key to Title Case label */
function formatLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Account OAuth Section — shows Google connection status with disconnect option
// ---------------------------------------------------------------------------

function AccountOAuthSection() {
  const t = useTranslations('settings')
  const { currentUser } = useAgentCenterStore()
  const [disconnecting, setDisconnecting] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)

  if (!currentUser) return null

  const isGoogleConnected = currentUser.provider === 'google'

  const handleDisconnect = async () => {
    setDisconnecting(true)
    try {
      const res = await fetch('/api/auth/google/disconnect', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setFeedback({ ok: true, text: t('googleDisconnectedSuccess') })
        // Reload after a short delay so the user sees the feedback
        setTimeout(() => window.location.reload(), 1500)
      } else {
        setFeedback({ ok: false, text: data.error || t('googleDisconnectFailed') })
      }
    } catch {
      setFeedback({ ok: false, text: t('networkError') })
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 pt-2">
        <h3 className="text-sm font-medium text-foreground">{t('accountTitle')}</h3>
      </div>

      <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Google icon */}
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
              isGoogleConnected ? 'bg-white' : 'bg-muted'
            }`}>
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
            </div>

            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">Google</span>
                {isGoogleConnected ? (
                  <span className="text-2xs px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">{t('googleConnected')}</span>
                ) : (
                  <span className="text-2xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{t('googleNotConnected')}</span>
                )}
              </div>
              {isGoogleConnected && currentUser.email ? (
                <p className="text-xs text-muted-foreground mt-0.5">{currentUser.email}</p>
              ) : (
                <p className="text-xs text-muted-foreground mt-0.5">{t('googleLinkHint')}</p>
              )}
            </div>
          </div>

          {isGoogleConnected && (
            <Button
              onClick={handleDisconnect}
              disabled={disconnecting}
              variant="outline"
              size="sm"
              className="text-xs hover:text-destructive hover:border-destructive/50"
            >
              {disconnecting ? t('disconnectingGoogle') : t('disconnectGoogle')}
            </Button>
          )}
        </div>

        {feedback && (
          <div className={`mt-3 rounded-md p-2.5 text-xs font-medium ${
            feedback.ok ? 'bg-green-500/10 text-green-400' : 'bg-destructive/10 text-destructive'
          }`}>
            {feedback.text}
          </div>
        )}
      </div>
    </div>
  )
}
function UpstreamSyncSection({ settings, edits, handleEdit, showFeedback }: any) {
  const t = useTranslations('settings')
  const [schedulerTasks, setSchedulerTasks] = useState<any[]>([])
  const [syncDiagnostics, setSyncDiagnostics] = useState<any | null>(null)
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const fetchSchedulerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/scheduler')
      if (res.ok) {
        const data = await res.json()
        setSchedulerTasks(data.tasks || [])
      }
    } catch {}
  }, [])

  const fetchSyncDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true)
    try {
      const res = await fetch('/api/server-sync/status')
      if (res.ok) {
        const data = await res.json()
        setSyncDiagnostics(data)
      }
    } catch {} finally {
      setDiagnosticsLoading(false)
    }
  }, [])

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

  useEffect(() => {
    fetchSchedulerStatus()
    fetchSyncDiagnostics()
    const interval = setInterval(() => {
      fetchSchedulerStatus()
      fetchSyncDiagnostics()
    }, 30000)
    return () => clearInterval(interval)
  }, [fetchSchedulerStatus, fetchSyncDiagnostics])

  const getVal = (key: string) => edits[key] ?? settings.find((s: any) => s.key === key)?.value ?? ''
  const syncTask = schedulerTasks.find(t => t.id === 'server_gateway_sync')
  const diagnosticSyncTask = syncDiagnostics?.scheduler.tasks.find((t: any) => t.id === 'server_gateway_sync')
  const bridgeInfo = syncDiagnostics?.upstream.bridge_info
  const discoveredHttpBase = bridgeInfo?.payload?.service?.http_base_url || ''
  const discoveredWsUrl = bridgeInfo?.payload?.bridge?.ws_url || ''

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('clientTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t('clientDescription')}</p>
        </div>
        <Button
          onClick={handleSyncNow}
          disabled={syncing}
          variant="outline"
          size="sm"
        >
          {syncing ? t('clientSyncing') : t('clientSyncNow')}
        </Button>
      </div>

      <div className="space-y-4 bg-card border border-border rounded-lg p-4">
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">{t('clientServerGatewayUrlLabel')}</label>
          <input
            type="text"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all"
            placeholder={t('clientServerGatewayUrlPlaceholder')}
            value={getVal('gateway.server_url')}
            onChange={(e) => handleEdit('gateway.server_url', e.target.value)}
          />
          <p className="text-2xs text-muted-foreground mt-1">{t('clientServerGatewayUrlHint')}</p>
        </div>
        
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">{t('clientGatewayApiTokenLabel')}</label>
          <input
            type="password"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all"
            placeholder={t('clientGatewayApiTokenPlaceholder')}
            value={getVal('gateway.token')}
            onChange={(e) => handleEdit('gateway.token', e.target.value)}
          />
          <p className="text-2xs text-muted-foreground mt-1">{t('clientGatewayApiTokenHint')}</p>
        </div>
        
        <div>
          <label className="block text-xs font-medium text-foreground mb-1">{t('clientLocalClientNameLabel')}</label>
          <input
            type="text"
            className="w-full bg-background border border-border rounded px-3 py-2 text-sm focus:border-primary focus:ring-1 focus:ring-primary outline-none transition-all"
            placeholder={t('clientLocalClientNamePlaceholder')}
            value={getVal('gateway.client_name')}
            onChange={(e) => handleEdit('gateway.client_name', e.target.value)}
          />
          <p className="text-2xs text-muted-foreground mt-1">{t('clientLocalClientNameHint')}</p>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">{t('clientSyncStatusTitle')}</h3>
        <div className="space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">{t('clientAutomaticSync')}</span>
            <span className={syncTask?.enabled ? 'text-green-400 font-medium' : 'text-yellow-400'}>
              {syncTask?.enabled ? t('clientEnabledEvery60s') : t('disabled')}
            </span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">{t('clientLastSyncResult')}</span>
            <span className={syncTask?.lastResult?.ok ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
              {syncTask?.lastResult?.message || t('neverRun')}
            </span>
          </div>
          {syncTask?.lastRun && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{t('clientLastRunAt')}</span>
              <span className="text-foreground/80">{new Date(syncTask.lastRun).toLocaleString()}</span>
            </div>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-foreground">{t('syncDiagnosticsTitle')}</h3>
          <Button
            onClick={fetchSyncDiagnostics}
            variant="ghost"
            size="xs"
            className="h-7 text-2xs"
            disabled={diagnosticsLoading}
          >
            {diagnosticsLoading ? t('syncDiagnosticsRefreshing') : t('syncDiagnosticsRefresh')}
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('configuredParentUrl')}</span>
              <span className="font-mono text-right break-all text-foreground/70">{syncDiagnostics?.upstream.server_url || getVal('gateway.server_url') || '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('discoveredHttpBase')}</span>
              <span className="font-mono text-right break-all text-foreground/70">{discoveredHttpBase || '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('discoveredBridgeWs')}</span>
              <span className="font-mono text-right break-all text-foreground/70">{discoveredWsUrl || '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('tokenConfigured')}</span>
              <span className={syncDiagnostics?.upstream.token_configured ? 'text-green-400 font-medium' : 'text-yellow-400'}>
                {syncDiagnostics?.upstream.token_configured ? t('yes') : t('no')}
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('discoveryStatus')}</span>
              <span className={bridgeInfo?.ok ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
                {bridgeInfo ? (bridgeInfo.ok ? t('reachable') : t('failed')) : t('unknown')}
              </span>
            </div>
            {bridgeInfo?.error && <div className="text-destructive text-2xs break-words">{bridgeInfo.error}</div>}
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('clientLocalAgents')}</span>
              <span className="text-foreground/80">{syncDiagnostics?.local_counts.total ?? '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('unsyncedMessages')}</span>
              <span className="text-foreground/80">{syncDiagnostics?.backlog.unsynced_messages ?? '-'}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('pendingRemoteTaskNotify')}</span>
              <span className="text-foreground/80">{syncDiagnostics?.backlog.remote_tasks_pending_notify ?? '-'}</span>
            </div>
          </div>
        </div>

        {diagnosticSyncTask && (
          <div className="rounded-lg border border-border/60 bg-muted/10 p-3 text-xs space-y-1">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('periodicUpstreamSync')}</span>
              <span className={diagnosticSyncTask.enabled ? 'text-green-400 font-medium' : 'text-yellow-400'}>
                {diagnosticSyncTask.enabled ? t('enabled') : t('disabled')}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{t('lastResult')}</span>
              <span className={diagnosticSyncTask.lastResult?.ok ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
                {diagnosticSyncTask.lastResult?.message || t('neverRun')}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
function DownstreamConnectionSection({ apiKeyInfo }: { apiKeyInfo: any }) {
  const t = useTranslations('settings')
  const tc = useTranslations('common')
  const [revealing, setRevealing] = useState(false)
  const [fullToken, setFullToken] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [copiedToken, setCopiedToken] = useState(false)

  const serverUrl = typeof window !== 'undefined' ? window.location.origin : ''

  const handleReveal = async () => {
    setRevealing(true)
    try {
      const res = await fetch('/api/tokens/rotate?reveal=true')
      if (res.ok) {
        const data = await res.json()
        setFullToken(data.key)
      }
    } catch {}
    setRevealing(false)
  }

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(serverUrl)
    setCopiedUrl(true)
    setTimeout(() => setCopiedUrl(false), 2000)
  }

  const handleCopyToken = () => {
    if (fullToken) {
      navigator.clipboard.writeText(fullToken)
      setCopiedToken(true)
      setTimeout(() => setCopiedToken(false), 2000)
    }
  }

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('downstreamTitle')}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{t('downstreamDescription')}</p>
      </div>

      <div className="bg-card border border-border rounded-lg p-4 space-y-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-2xs uppercase tracking-wider font-semibold text-muted-foreground/70">
            {t('downstreamUrlLabel')}
          </label>
          <div className="flex gap-2">
            <code className="flex-1 bg-muted/30 border border-border/50 rounded px-3 py-2 text-xs truncate font-mono text-foreground/80">
              {serverUrl}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopyUrl}
              className="shrink-0 h-9"
            >
              {copiedUrl ? t('copied') : t('copyUrl')}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-2xs uppercase tracking-wider font-semibold text-muted-foreground/70">
            {t('downstreamTokenLabel')}
          </label>
          <div className="flex gap-2">
            <code className="flex-1 bg-muted/30 border border-border/50 rounded px-3 py-2 text-xs truncate font-mono text-foreground/80">
              {fullToken || apiKeyInfo?.masked_key || '••••••••'}
            </code>
            {!fullToken ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleReveal}
                disabled={revealing}
                className="shrink-0 h-9"
              >
                {revealing ? tc('loading') : tc('reveal')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={handleCopyToken}
                className="shrink-0 h-9"
              >
                {copiedToken ? t('copied') : t('copyToken')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
