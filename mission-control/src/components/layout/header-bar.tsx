'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { useAgentCenterStore, type ConnectionStatus } from '@/store'
import { extractWsHost } from '@/lib/agent-card-helpers'
import { useWebSocket } from '@/lib/websocket'
import { useNavigateToPanel, usePrefetchPanel } from '@/lib/navigation'
import { Button } from '@/components/ui/button'
import { ThemeSelector } from '@/components/ui/theme-selector'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import { DigitalClock } from '@/components/ui/digital-clock'
import { EdgeDownloadHeaderButton, EdgeDownloadTooltipLink } from '@/components/edge/edge-download-link'
import { getNavigationMetrics, navigationMetricEventName } from '@/lib/navigation-metrics'

interface SearchResult {
  type: string
  id: number
  title: string
  subtitle?: string
  excerpt?: string
  created_at: number
  panel?: string
  source?: 'command' | 'entity'
}

const QUICK_NAV_COMMANDS: Array<{ panel: string; titleKey: string; title: string; aliases: string[] }> = [
  { panel: 'overview', titleKey: 'goToOverview', title: 'Go to Overview', aliases: ['home', 'dashboard'] },
  { panel: 'chat', titleKey: 'goToChat', title: 'Go to Chat', aliases: ['sessions', 'messages'] },
  { panel: 'tasks', titleKey: 'goToTasks', title: 'Go to Tasks', aliases: ['task board', 'tickets'] },
  { panel: 'agents', titleKey: 'goToAgents', title: 'Go to Agents', aliases: ['agent squad', 'workers'] },
  { panel: 'activity', titleKey: 'goToActivityFeed', title: 'Go to Activity Feed', aliases: ['events', 'feed'] },
  { panel: 'notifications', titleKey: 'goToNotifications', title: 'Go to Notifications', aliases: ['alerts inbox'] },
  { panel: 'tokens', titleKey: 'goToTokenUsage', title: 'Go to Token Usage', aliases: ['cost', 'spend'] },
  { panel: 'logs', titleKey: 'goToLogs', title: 'Go to Logs', aliases: ['log viewer'] },
  { panel: 'memory', titleKey: 'goToMemoryBrowser', title: 'Go to Memory Browser', aliases: ['knowledge', 'notes'] },
  { panel: 'integrations', titleKey: 'goToIntegrations', title: 'Go to Integrations', aliases: ['providers', 'api keys'] },
  { panel: 'settings', titleKey: 'goToSettings', title: 'Go to Settings', aliases: ['preferences', 'config'] },
  { panel: 'gateways', titleKey: 'goToGateways', title: 'Go to Gateways', aliases: ['gateway manager'] },
  { panel: 'github', titleKey: 'goToGithubSync', title: 'Go to GitHub Sync', aliases: ['github', 'sync'] },
  { panel: 'office', titleKey: 'goToOffice', title: 'Go to Office', aliases: ['workspace', 'team'] },
  { panel: 'skills', titleKey: 'goToSkills', title: 'Go to Skills', aliases: ['skill packs', 'agent skills'] },
]

export function HeaderBar() {
  const { connection, sessions, unreadNotificationCount, activeTenant, activeProject, dashboardMode, currentUser } = useAgentCenterStore()
  const { isConnected, reconnect } = useWebSocket()
  const navigateToPanel = useNavigateToPanel()
  const prefetchPanel = usePrefetchPanel()
  const th = useTranslations('header')

  const activeSessions = sessions.filter(s => s.active).length

  // Search state
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const searchRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const resultButtonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  const getQuickNavResults = useCallback((q: string): SearchResult[] => {
    const normalized = q.trim().toLowerCase()
    if (!normalized) {
      return QUICK_NAV_COMMANDS.slice(0, 6).map((cmd, index) => ({
        type: 'panel',
        id: -(index + 1),
        title: th(cmd.titleKey),
        subtitle: `/${cmd.panel}`,
        excerpt: th('quickNavigation'),
        created_at: Date.now(),
        panel: cmd.panel,
        source: 'command',
      }))
    }

    const ranked: Array<(SearchResult & { _score: number }) | null> = QUICK_NAV_COMMANDS
      .map((cmd, index) => {
        const translatedTitle = th(cmd.titleKey)
        const haystack = `${translatedTitle} ${cmd.title} ${cmd.panel} ${cmd.aliases.join(' ')}`.toLowerCase()
        if (!haystack.includes(normalized)) return null
        const exactPanel = cmd.panel === normalized
        const startsTitle = translatedTitle.toLowerCase().startsWith(normalized)
        const score = exactPanel ? 3 : startsTitle ? 2 : 1
        return {
          type: 'panel',
          id: -(index + 1),
          title: translatedTitle,
          subtitle: `/${cmd.panel}`,
          excerpt: cmd.aliases.length ? `Aliases: ${cmd.aliases.join(', ')}` : th('quickNavigation'),
          created_at: Date.now(),
          panel: cmd.panel,
          source: 'command' as const,
          _score: score,
        }
      })
    return ranked
      .filter((row): row is SearchResult & { _score: number } => Boolean(row))
      .sort((a, b) => b._score - a._score)
      .map(({ _score, ...row }) => row)
      .slice(0, 8)
  }, [th])

  const openCommandPalette = useCallback(() => {
    setSearchOpen(true)
    setSearchResults(getQuickNavResults(''))
    setSelectedIndex(0)
    setTimeout(() => searchInputRef.current?.focus(), 50)
  }, [getQuickNavResults])

  const handleResultClick = useCallback((result: SearchResult) => {
    if (result.panel) {
      prefetchPanel(result.panel)
      navigateToPanel(result.panel)
      setSearchOpen(false)
      setSearchQuery('')
      setSearchResults([])
      return
    }
    const typeToTab: Record<string, string> = {
      task: 'tasks', agent: 'agents', activity: 'activity',
      audit: 'audit', message: 'agents', notification: 'notifications',
      webhook: 'webhooks', pipeline: 'agents', alert_rule: 'alerts',
    }
    navigateToPanel(typeToTab[result.type] || 'overview')
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults([])
  }, [navigateToPanel, prefetchPanel])

  // Keyboard shortcut: Cmd/Ctrl+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const isTypingTarget =
        !!target &&
        (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target.isContentEditable
        )

      if (searchOpen) {
        if (e.key === 'Tab') {
          const focusables = [
            searchInputRef.current,
            ...resultButtonRefs.current,
          ].filter((el): el is HTMLInputElement | HTMLButtonElement => el !== null)
          if (focusables.length > 0) {
            e.preventDefault()
            const activeEl = document.activeElement as (HTMLInputElement | HTMLButtonElement | null)
            const currentIndex = focusables.findIndex((el) => el === activeEl)
            const nextIndex = e.shiftKey
              ? (currentIndex <= 0 ? focusables.length - 1 : currentIndex - 1)
              : (currentIndex >= focusables.length - 1 ? 0 : currentIndex + 1)
            focusables[nextIndex]?.focus()
          }
          return
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          const next = Math.min(selectedIndex + 1, Math.max(0, searchResults.length - 1))
          setSelectedIndex(next)
          resultButtonRefs.current[next]?.focus()
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          const next = Math.max(selectedIndex - 1, 0)
          setSelectedIndex(next)
          resultButtonRefs.current[next]?.focus()
          return
        }
        if (e.key === 'Home') {
          e.preventDefault()
          setSelectedIndex(0)
          resultButtonRefs.current[0]?.focus()
          return
        }
        if (e.key === 'End') {
          e.preventDefault()
          const last = Math.max(0, searchResults.length - 1)
          setSelectedIndex(last)
          resultButtonRefs.current[last]?.focus()
          return
        }
        if (e.key === 'Enter') {
          const selected = searchResults[selectedIndex]
          if (selected) {
            e.preventDefault()
            handleResultClick(selected)
            return
          }
        }
      }
      if (!isTypingTarget && e.key === '/') {
        e.preventDefault()
        openCommandPalette()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        openCommandPalette()
      }
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleResultClick, openCommandPalette, searchOpen, searchResults, selectedIndex])

  // Close on outside click
  useEffect(() => {
    if (!searchOpen) return
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [searchOpen])

  // Prevent background scroll while command palette is open.
  useEffect(() => {
    if (!searchOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [searchOpen])

  useEffect(() => {
    if (!searchOpen) return
    resultButtonRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [searchOpen, selectedIndex, searchResults])

  const doSearch = useCallback(async (q: string) => {
    const quickResults = getQuickNavResults(q)
    if (q.length < 2) {
      setSearchResults(quickResults)
      setSelectedIndex(0)
      return
    }
    setSearchLoading(true)
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=12`)
      const data = await res.json()
      const entityResults: SearchResult[] = (data.results || []).map((r: SearchResult) => ({ ...r, source: 'entity' }))
      const merged = [...quickResults, ...entityResults].slice(0, 16)
      setSearchResults(merged)
      setSelectedIndex(0)
    } catch {
      setSearchResults(quickResults)
      setSelectedIndex(0)
    } finally {
      setSearchLoading(false)
    }
  }, [getQuickNavResults])

  const handleSearchInput = (value: string) => {
    setSearchQuery(value)
    setSelectedIndex(0)
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    searchTimeoutRef.current = setTimeout(() => doSearch(value), 250)
  }

  useEffect(() => {
    resultButtonRefs.current = resultButtonRefs.current.slice(0, searchResults.length)
  }, [searchResults.length])

  const typeIcons: Record<string, string> = {
    panel: '>',
    task: 'T', agent: 'A', activity: 'E', audit: 'S',
    message: 'M', notification: 'N', webhook: 'W', pipeline: 'P',
  }
  const typeColors: Record<string, string> = {
    panel: 'bg-primary/20 text-primary',
    task: 'bg-blue-500/20 text-blue-400',
    agent: 'bg-purple-500/20 text-purple-400',
    activity: 'bg-green-500/20 text-green-400',
    audit: 'bg-amber-500/20 text-amber-400',
    message: 'bg-cyan-500/20 text-cyan-400',
    notification: 'bg-red-500/20 text-red-400',
    webhook: 'bg-orange-500/20 text-orange-400',
    pipeline: 'bg-indigo-500/20 text-indigo-400',
  }

  return (
    <header role="banner" aria-label="Application header" className="relative z-50 h-14 bg-card/80 backdrop-blur-sm border-b border-border px-3 md:px-4 shrink-0">
      <div className="h-full flex items-center gap-2 md:gap-3">
        {/* Left: Page title + context */}
        <div className="flex min-w-0 items-center gap-2.5 shrink-0">
          {activeProject ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => navigateToPanel('tasks')}
              onMouseEnter={() => prefetchPanel('tasks')}
              onFocus={() => prefetchPanel('tasks')}
              className="hidden lg:flex items-center gap-1 text-2xs bg-secondary/50 min-w-0 max-w-[320px]"
              title={`Scoped to project: ${activeProject.name}`}
            >
              <span className="text-muted-foreground/60 truncate">{currentUser?.organization?.display_name || activeTenant?.display_name || 'Default'}</span>
              <span className="text-muted-foreground/40">/</span>
              <span className="font-medium text-foreground truncate">{activeProject.name}</span>
            </Button>
          ) : activeTenant || (currentUser?.provider && currentUser.provider !== 'local') ? (
            <div className="hidden lg:flex items-center gap-1 px-2 py-1 rounded-md bg-secondary/40 text-2xs">
              {currentUser?.provider && currentUser.provider !== 'local' ? (
                <>
                  <span className="text-muted-foreground">{th('organization')}</span>
                  <span className="text-muted-foreground/40">/</span>
                  <span className="text-muted-foreground/80 truncate max-w-[120px]">
                    {currentUser.organization?.display_name || activeTenant?.display_name || '—'}
                  </span>
                  <span className="text-muted-foreground/40">/</span>
                  <span className="font-medium text-foreground truncate max-w-[140px]">
                    {(currentUser.display_name || '').trim() || (currentUser.email || '').trim() || currentUser.username}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-muted-foreground">{th('workspace')}</span>
                  <span className="text-muted-foreground/40">/</span>
                  <span className="font-medium text-foreground truncate max-w-[220px]">{activeTenant!.display_name}</span>
                </>
              )}
            </div>
          ) : null}

          <ModeBadge connection={connection} onReconnect={reconnect} />
        </div>

        {/* Center: wide command search (desktop) */}
        <div className="hidden md:flex items-center justify-center flex-1 min-w-0 max-w-[28rem] lg:max-w-[34rem] xl:max-w-[42rem]">
          <Button
            variant="outline"
            size="sm"
            onClick={openCommandPalette}
            className="h-10 w-full justify-between bg-secondary/35 hover:border-primary/40 hover:bg-secondary/50 px-3"
          >
            <span className="flex items-center gap-2 min-w-0">
              <SearchIcon />
              <span className="truncate text-sm text-muted-foreground">{th('jumpToSearch')}</span>
            </span>
            <span className="hidden xl:flex items-center gap-1 ml-2 shrink-0">
              <kbd className="text-2xs px-1.5 py-0.5 rounded bg-muted border border-border font-mono">&#8984;K</kbd>
              <kbd className="text-2xs px-1.5 py-0.5 rounded bg-muted border border-border font-mono">/</kbd>
            </span>
          </Button>
        </div>

        {/* Right: status + actions */}
        <div className="flex items-center justify-end gap-1.5 md:gap-2 min-w-0 shrink-0 ml-auto">
          <div className="hidden xl:flex items-center gap-3">
            <Stat label={th('sessions')} value={`${activeSessions}/${sessions.length}`} />
            <NavigationLatencyStat />
            <SseBadge connected={connection.sseConnected ?? false} />
            <DigitalClock />
          </div>

          {/* Mobile search trigger */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={openCommandPalette}
            className="md:hidden"
            title="Search"
          >
            <SearchIcon />
          </Button>

          <EdgeDownloadHeaderButton />

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => navigateToPanel('notifications')}
            onMouseEnter={() => prefetchPanel('notifications')}
            onFocus={() => prefetchPanel('notifications')}
            className="relative"
          >
            <BellIcon />
            {unreadNotificationCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-primary text-primary-foreground text-2xs flex items-center justify-center font-medium">
                {unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}
              </span>
            )}
          </Button>

          <LanguageSwitcher />
          <ThemeSelector />
        </div>
      </div>

      {/* Search overlay (portal to body to avoid clipping/stacking context bugs) */}
      {searchOpen && isMounted && createPortal(
        <div
          ref={searchRef}
          className="fixed inset-0 z-[9999] isolate"
          role="dialog"
          aria-modal="true"
          aria-label="Command search"
        >
          <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/30 to-black/30" onClick={() => setSearchOpen(false)} />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="command-palette-in w-full max-w-[44rem] max-h-[min(78vh,40rem)] bg-card border border-border rounded-lg shadow-2xl overflow-hidden">
              <div className="p-2 border-b border-border">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={e => handleSearchInput(e.target.value)}
                  placeholder={th('searchPlaceholder')}
                  className="w-full h-9 px-3 rounded-md bg-secondary border-0 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                  autoFocus
                  role="combobox"
                  aria-expanded={searchOpen}
                  aria-controls="mc-command-results"
                  aria-activedescendant={searchResults[selectedIndex] ? `mc-command-result-${selectedIndex}` : undefined}
                />
              </div>
              <div id="mc-command-results" role="listbox" className="bg-card max-h-[calc(min(78vh,40rem)-3.25rem)] overflow-y-auto">
                {searchLoading ? (
                  <div className="p-4 text-center text-xs text-muted-foreground">{th('searching')}</div>
                ) : searchResults.length > 0 ? (
                  searchResults.map((r, i) => (
                    <Button
                      key={`${r.type}-${r.id}-${i}`}
                      ref={(el) => { resultButtonRefs.current[i] = el }}
                      variant="ghost"
                      onClick={() => handleResultClick(r)}
                      onMouseEnter={() => setSelectedIndex(i)}
                      id={`mc-command-result-${i}`}
                      role="option"
                      aria-selected={i === selectedIndex}
                      tabIndex={i === selectedIndex ? 0 : -1}
                      className={`w-full text-left px-3 py-2 h-auto rounded-none justify-start items-start gap-2.5 hover:bg-secondary/80 ${
                        i === selectedIndex ? 'bg-secondary' : 'bg-card'
                      }`}
                    >
                      <span className={`text-2xs font-medium w-5 h-5 rounded flex items-center justify-center shrink-0 mt-0.5 ${typeColors[r.type] || 'bg-muted text-muted-foreground'}`}>
                        {typeIcons[r.type] || '?'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-foreground truncate">{r.title}</div>
                        {r.subtitle && <div className="text-2xs text-muted-foreground truncate">{r.subtitle}</div>}
                        {r.excerpt && <div className="text-2xs text-muted-foreground/70 truncate mt-0.5">{r.excerpt}</div>}
                      </div>
                    </Button>
                  ))
                ) : searchQuery.length >= 2 ? (
                  <div className="p-4 text-center text-xs text-muted-foreground">{th('noResults')}</div>
                ) : (
                  <div className="p-4 text-center text-xs text-muted-foreground">{th('typeToSearch')}</div>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </header>
  )
}

/** Top-left mode + connection badge — visible on all screen sizes. */
function ModeBadge({
  connection,
  onReconnect,
}: {
  connection: ConnectionStatus
  onReconnect: () => void
}) {
  const { dashboardMode, centralMode } = useAgentCenterStore()
  const th = useTranslations('header')
  const isLocal = dashboardMode === 'local'
  const isServiceMode = isLocal && centralMode
  const [showTooltip, setShowTooltip] = useState(false)
  const [serviceStatus, setServiceStatus] = useState<{
    clients: {
      total: number
      connected: number
      disconnected: number
      items: Array<{
        client_id: string
        client_name: string
        status: 'connected' | 'disconnected'
        last_seen: number
        last_sync_source: string | null
        agent_count: number
      }>
    }
  } | null>(null)

  const fetchServiceStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/server-sync/status', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      if (data?.clients) {
        setServiceStatus({ clients: data.clients })
      }
    } catch {
      // ignore tooltip refresh failures
    }
  }, [])

  const formatLastSeen = useCallback((timestamp?: number) => {
    if (!timestamp) return '-'
    const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
    if (diffSec < 60) return `${diffSec}s`
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`
    return `${Math.floor(diffSec / 86400)}d`
  }, [])

  useEffect(() => {
    if (!isServiceMode) return
    fetchServiceStatus()
    const interval = window.setInterval(fetchServiceStatus, 15000)
    return () => window.clearInterval(interval)
  }, [fetchServiceStatus, isServiceMode])

  useEffect(() => {
    if (!isServiceMode || !showTooltip) return
    fetchServiceStatus()
    const interval = window.setInterval(fetchServiceStatus, 5000)
    return () => window.clearInterval(interval)
  }, [fetchServiceStatus, isServiceMode, showTooltip])

  if (isLocal && !isServiceMode) {
    return (
      <div
        className="relative"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-2xs bg-void-cyan/10 border border-void-cyan/25">
          <span className="w-1.5 h-1.5 rounded-full bg-void-cyan" />
          <span className="font-medium text-void-cyan">{th('local')}</span>
        </div>
        {showTooltip && (
          <div className="absolute top-full left-0 mt-1.5 z-50 w-56 rounded-lg border border-border bg-card/95 backdrop-blur-md p-3 shadow-xl text-xs">
            <div className="font-medium text-foreground mb-2">{th('local')}</div>
            <p className="text-muted-foreground text-[11px] leading-relaxed">{th('downloadEdgeClientHint')}</p>
            <EdgeDownloadTooltipLink />
          </div>
        )}
      </div>
    )
  }

  if (isServiceMode) {
    const clientSummary = serviceStatus?.clients
    const connectedClients = clientSummary?.connected ?? 0
    const totalClients = clientSummary?.total ?? 0
    const disconnectedClients = clientSummary?.disconnected ?? 0
    const dotClass = connectedClients > 0 ? 'bg-green-500' : 'bg-void-cyan'
    const borderClass = connectedClients > 0 ? 'border-green-500/25 bg-green-500/10' : 'border-void-cyan/25 bg-void-cyan/10'
    const textClass = connectedClients > 0 ? 'text-green-400' : 'text-void-cyan'
    const statusLabel = totalClients > 0 ? `${connectedClients}/${totalClients}` : th('listening')

    return (
      <div
        className="relative"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-2xs border ${borderClass}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
          <span className={`font-medium ${textClass}`}>{th('service')}</span>
          <span className={`font-mono ${textClass} opacity-80`}>{statusLabel}</span>
        </div>

        {showTooltip && (
          <div className="absolute top-full left-0 mt-1.5 z-50 w-72 rounded-lg border border-border bg-card/95 backdrop-blur-md p-3 shadow-xl text-xs">
            <div className="font-medium text-foreground mb-2">{th('serviceStatus')}</div>
            <div className="space-y-1.5 text-muted-foreground">
              <div className="flex justify-between gap-3">
                <span>{th('status')}</span>
                <span className={connectedClients > 0 ? 'text-green-400' : 'text-void-cyan'}>
                  {connectedClients > 0 ? th('connected') : th('listening')}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span>{th('connectedClients')}</span>
                <span className="text-foreground/80">{connectedClients}/{totalClients}</span>
              </div>
              {disconnectedClients > 0 && (
                <div className="flex justify-between gap-3">
                  <span>{th('disconnected')}</span>
                  <span className="text-foreground/80">{disconnectedClients}</span>
                </div>
              )}
            </div>

            <div className="mt-3 border-t border-border/60 pt-3">
              {clientSummary?.items?.length ? (
                <div className="space-y-2">
                  {clientSummary.items.map((client) => (
                    <div key={client.client_id} className="rounded-md border border-border/60 bg-secondary/20 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-foreground">
                            {client.client_name || client.client_id || th('unknownClient')}
                          </div>
                        </div>
                        <span className={`rounded-full px-1.5 py-0.5 text-2xs border ${
                          client.status === 'connected'
                            ? 'border-green-500/30 bg-green-500/10 text-green-400'
                            : 'border-slate-500/30 bg-slate-500/10 text-slate-300'
                        }`}>
                          {client.status === 'connected' ? th('connected') : th('disconnected')}
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-2xs text-muted-foreground">
                        <div className="flex justify-between gap-2">
                          <span>{th('agents')}</span>
                          <span className="text-foreground/80">{client.agent_count}</span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span>{th('status')}</span>
                          <span className="text-foreground/80">{client.last_sync_source || '-'}</span>
                        </div>
                        <div className="col-span-2 flex justify-between gap-2">
                          <span>{th('lastSeen')}</span>
                          <span className="truncate font-mono text-foreground/80">{formatLastSeen(client.last_seen)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground">{th('noClientsConnected')}</div>
              )}
            </div>
            <EdgeDownloadTooltipLink />
          </div>
        )}
      </div>
    )
  }

  const isConnected = connection.isConnected
  const isReconnecting = !isConnected && connection.reconnectAttempts > 0

  let dotClass: string
  let borderClass: string
  let textClass: string
  let statusLabel: string

  if (isConnected) {
    dotClass = 'bg-green-500'
    borderClass = 'border-green-500/25 bg-green-500/10'
    textClass = 'text-green-400'
    statusLabel = connection.latency != null ? `${connection.latency}ms` : th('connected')
  } else if (isReconnecting) {
    dotClass = 'bg-amber-500 animate-pulse'
    borderClass = 'border-amber-500/25 bg-amber-500/10'
    textClass = 'text-amber-400'
    statusLabel = th('retry', { count: connection.reconnectAttempts })
  } else {
    dotClass = 'bg-red-500 animate-pulse'
    borderClass = 'border-red-500/25 bg-red-500/10'
    textClass = 'text-red-400'
    statusLabel = th('offline')
  }

  const wsHost = extractWsHost(connection.url)

  return (
    <div
      className="relative"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <button
        onClick={!isConnected ? onReconnect : undefined}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-2xs border ${borderClass} ${
          !isConnected ? 'cursor-pointer hover:brightness-125' : 'cursor-default'
        } transition-all`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
        <span className={`font-medium ${textClass}`}>GW</span>
        <span className={`font-mono ${textClass} opacity-80`}>{statusLabel}</span>
      </button>

      {showTooltip && (
        <div className="absolute top-full left-0 mt-1.5 z-50 w-56 rounded-lg border border-border bg-card/95 backdrop-blur-md p-3 shadow-xl text-xs">
          <div className="font-medium text-foreground mb-2">{th('gatewayConnection')}</div>
          <div className="space-y-1.5 text-muted-foreground">
            <div className="flex justify-between">
              <span>{th('status')}</span>
              <span className={isConnected ? 'text-green-400' : isReconnecting ? 'text-amber-400' : 'text-red-400'}>
                {isConnected ? th('connected') : isReconnecting ? th('reconnecting') : th('disconnected')}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{th('host')}</span>
              <span className="font-mono text-foreground/80 truncate ml-2">{wsHost}</span>
            </div>
            {connection.latency != null && (
              <div className="flex justify-between">
                <span>{th('latency')}</span>
                <span className="font-mono text-foreground/80">{connection.latency}ms</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>{th('webSocket')}</span>
              <span className={isConnected ? 'text-green-400' : 'text-red-400'}>
                {isConnected ? th('live') : th('down')}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{th('sse')}</span>
              <span className={connection.sseConnected ? 'text-green-400' : 'text-muted-foreground/50'}>
                {connection.sseConnected ? th('live') : th('off')}
              </span>
            </div>
            {!isConnected && connection.reconnectAttempts > 0 && (
              <div className="flex justify-between">
                <span>{th('retries')}</span>
                <span className="text-amber-400">{connection.reconnectAttempts}</span>
              </div>
            )}
          </div>
          {!isConnected && (
            <div className="mt-2 pt-2 border-t border-border/40 text-muted-foreground/60 text-[10px]">
              {th('clickToReconnect')}
            </div>
          )}
          <EdgeDownloadTooltipLink />
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, status }: { label: string; value: string; status?: 'success' | 'error' | 'warning' }) {
  const statusColor = status === 'success' ? 'text-green-400' : status === 'error' ? 'text-red-400' : status === 'warning' ? 'text-amber-400' : 'text-foreground'

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium font-mono-tight ${statusColor}`}>{value}</span>
    </div>
  )
}

function NavigationLatencyStat() {
  const [latestMs, setLatestMs] = useState<number | null>(null)
  const [avgMs, setAvgMs] = useState<number | null>(null)

  useEffect(() => {
    const initial = getNavigationMetrics()
    setLatestMs(initial.latestMs)
    setAvgMs(initial.avgMs)

    const eventName = navigationMetricEventName()
    const update = () => {
      const metrics = getNavigationMetrics()
      setLatestMs(metrics.latestMs)
      setAvgMs(metrics.avgMs)
    }
    window.addEventListener(eventName, update as EventListener)
    return () => window.removeEventListener(eventName, update as EventListener)
  }, [])

  if (latestMs == null) return null
  const latest = `${Math.round(latestMs)}ms`
  const avg = avgMs == null ? '' : ` (${Math.round(avgMs)} avg)`
  return <Stat label="Nav" value={`${latest}${avg}`} />
}

function SseBadge({ connected }: { connected: boolean }) {
  const th = useTranslations('header')
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{th('events')}</span>
      <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-void-cyan' : 'bg-muted-foreground/30'}`} />
      <span className={`font-medium font-mono-tight ${connected ? 'text-void-cyan' : 'text-muted-foreground'}`}>
        {connected ? th('live') : th('off')}
      </span>
    </div>
  )
}

function SearchIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 13h4M3.5 10c0-1-1-2-1-4a5.5 5.5 0 0111 0c0 2-1 3-1 4H3.5z" />
    </svg>
  )
}
