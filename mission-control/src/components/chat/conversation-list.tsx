'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useAgentCenterStore, Conversation } from '@/store'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { createClientLogger } from '@/lib/client-logger'
import { Button } from '@/components/ui/button'
import { SESSION_LIST_UPDATED_EVENT } from '@/lib/session-realtime-events'
import { SessionKindAvatar, SessionKindPill } from './session-kind-brand'
import {
  getMainAgentRuntimeFromSessionKind,
  getMainAgentRuntimeMeta,
  MAIN_AGENT_RUNTIME_ORDER,
} from '@/lib/runtime-agents'

const log = createClientLogger('ConversationList')

type SessionKind = 'claude-code' | 'codex-cli' | 'hermes' | 'gateway'
type RuntimeGroup = 'claude' | 'codex' | 'openclaw' | 'cursor' | 'opencode' | 'hermes' | 'other'

type SessionRecord = {
  id: string
  key?: string
  agent?: string
  kind?: string
  source?: string
  model?: string
  tokens?: string
  age?: string
  active?: boolean
  startTime?: number
  lastActivity?: number
  workingDir?: string | null
  lastUserPrompt?: string | null
  sessionId?: string
  nodeId?: string
  nodeLabel?: string
  runtimeGroup?: string
}

type SessionPrefs = Record<string, { name?: string; color?: string }>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function readSessionPrefs(payload: unknown): SessionPrefs {
  const record = asRecord(payload)
  const prefsRecord = asRecord(record?.prefs)
  if (!prefsRecord) return {}

  return Object.fromEntries(
    Object.entries(prefsRecord).map(([key, value]) => {
      const pref = asRecord(value)
      return [key, {
        name: readString(pref?.name),
        color: readString(pref?.color),
      }]
    })
  )
}

function readSessions(payload: unknown): SessionRecord[] {
  const record = asRecord(payload)
  const sessions = Array.isArray(record?.sessions) ? record.sessions : []

  return sessions.flatMap((value) => {
    const session = asRecord(value)
    const id = readString(session?.id)
    if (!id) return []

    return [{
      id,
      key: readString(session?.key),
      agent: readString(session?.agent),
      kind: readString(session?.kind),
      source: readString(session?.source),
      model: readString(session?.model),
      tokens: readString(session?.tokens),
      age: readString(session?.age),
      active: typeof session?.active === 'boolean' ? session.active : undefined,
      startTime: readNumber(session?.startTime),
      lastActivity: readNumber(session?.lastActivity),
      workingDir: typeof session?.workingDir === 'string' || session?.workingDir === null ? session.workingDir : undefined,
      lastUserPrompt: typeof session?.lastUserPrompt === 'string' || session?.lastUserPrompt === null ? session.lastUserPrompt : undefined,
      sessionId: readString(session?.sessionId),
      nodeId: readString(session?.nodeId),
      nodeLabel: readString(session?.nodeLabel),
    }]
  })
}

const COLOR_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'slate', label: 'Slate' },
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'amber', label: 'Amber' },
  { value: 'red', label: 'Red' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'teal', label: 'Teal' },
] as const

function timeAgo(timestamp: number, nowLabel: string): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp
  if (diff <= 0) return nowLabel
  if (diff < 60) return nowLabel
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

const STATUS_COLORS: Record<string, string> = {
  busy: 'bg-green-500',
  idle: 'bg-yellow-500',
  error: 'bg-red-500',
  offline: 'bg-muted-foreground/30',
}
const TAG_COLORS: Record<string, string> = {
  slate: 'bg-slate-500',
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  purple: 'bg-purple-500',
  pink: 'bg-pink-500',
  teal: 'bg-teal-500',
}
const SESSION_LIST_FALLBACK_POLL_MS = 60000

interface ConversationListProps {
  onNewConversation: (agentName: string) => void
}

export function ConversationList({ onNewConversation: _onNewConversation }: ConversationListProps) {
  const t = useTranslations('chat')
  const {
    conversations,
    setConversations,
    activeConversation,
    setActiveConversation,
    markConversationRead,
  } = useAgentCenterStore()
  const [search, setSearch] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ convId: string; x: number; y: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const ctxMenuRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const colorOptions = [
    { value: '', label: t('colorNone') },
    { value: 'slate', label: t('colorSlate') },
    { value: 'blue', label: t('colorBlue') },
    { value: 'green', label: t('colorGreen') },
    { value: 'amber', label: t('colorAmber') },
    { value: 'red', label: t('colorRed') },
    { value: 'purple', label: t('colorPurple') },
    { value: 'pink', label: t('colorPink') },
    { value: 'teal', label: t('colorTeal') },
  ] as const

  // Close context menu on outside click / Escape
  useEffect(() => {
    if (!ctxMenu) return
    const handleClick = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [ctxMenu])

  // Focus rename input when entering edit mode
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  const saveSessionPref = useCallback(async (conv: Conversation, name?: string, color?: string) => {
    const prefKey = conv.session?.prefKey
    if (!prefKey) return

    // Optimistic update immediately
    setConversations(
      conversations.map((c) => {
        if (c.id !== conv.id || !c.session) return c
        const newName = name !== undefined ? name : c.name
        return {
          ...c,
          name: newName,
          session: {
            ...c.session,
            displayName: newName,
            colorTag: color !== undefined ? (color || undefined) : c.session.colorTag,
          },
        }
      })
    )

    try {
      const body: Record<string, string | null> = { key: prefKey }
      if (name !== undefined) body.name = name || null
      if (color !== undefined) body.color = color || null

      const res = await fetch('/api/chat/session-prefs', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        log.error('Failed to save session pref, server returned', res.status)
      }
    } catch (err) {
      log.error('Failed to save session pref:', err)
    }
  }, [conversations, setConversations])

  const handleContextMenu = (e: React.MouseEvent, conv: Conversation) => {
    if (!conv.session?.prefKey) return
    e.preventDefault()
    // Clamp to viewport so menu doesn't overflow
    const x = Math.min(e.clientX, window.innerWidth - 200)
    const y = Math.min(e.clientY, window.innerHeight - 160)
    setCtxMenu({ convId: conv.id, x, y })
  }

  const startRename = (conv: Conversation) => {
    setEditingId(conv.id)
    setEditName(conv.session?.displayName || conv.name || '')
    setCtxMenu(null)
  }

  const commitRenameRef = useRef(false)
  const commitRename = (conv: Conversation) => {
    if (commitRenameRef.current) return
    commitRenameRef.current = true
    const trimmed = editName.trim()
    setEditingId(null)
    // Always save if non-empty — let the API dedupe unchanged names
    if (trimmed) {
      void saveSessionPref(conv, trimmed)
    }
    // Reset guard after microtask so onBlur after Enter doesn't double-fire
    queueMicrotask(() => { commitRenameRef.current = false })
  }

  const setColor = (conv: Conversation, color: string) => {
    setCtxMenu(null)
    void saveSessionPref(conv, undefined, color)
  }

  const loadConversations = useCallback(async () => {
    try {
      const sessionsUrl = '/api/sessions'
      const requests: Promise<Response>[] = [
        fetch(sessionsUrl),
        fetch('/api/chat/session-prefs'),
      ]

      const [sessionsRes, prefsRes] = await Promise.all(requests)
      const sessionsData = sessionsRes.ok ? readSessions(await sessionsRes.json()) : []
      const prefs = prefsRes.ok ? readSessionPrefs(await prefsRes.json().catch(() => null)) : {}

      const providerSessions = sessionsData
        .map((s, idx: number) => {
          const lastActivityMs = Number(s.lastActivity || s.startTime || 0)
          const updatedAt = lastActivityMs > 1_000_000_000_000
            ? Math.floor(lastActivityMs / 1000)
            : lastActivityMs
          const sessionKind: SessionKind = s.kind === 'claude-code' || s.kind === 'codex-cli' || s.kind === 'hermes'
            ? s.kind
            : 'gateway'
          const runtimeGroup = (s.runtimeGroup as RuntimeGroup | undefined) || getMainAgentRuntimeFromSessionKind(sessionKind)
          const runtimeMeta = runtimeGroup === 'other' ? null : getMainAgentRuntimeMeta(runtimeGroup)
          const kindLabel = runtimeMeta?.label || (sessionKind === 'gateway' ? 'Gateway' : 'Other')
          const prefKey = `${sessionKind}:${s.id}`
          const pref = prefs[prefKey] || {}
          const nodeLabel = s.nodeLabel || (s.source === 'client' ? s.agent : undefined)
          const defaultName = s.source === 'local'
            ? `${kindLabel} • ${s.key || s.id}`
            : `${s.agent || kindLabel} • ${s.key || s.id}`
          const sessionName = pref.name || defaultName

          return {
            id: `session:${sessionKind}:${s.id}`,
            name: sessionName,
            kind: sessionKind,
            source: 'session' as const,
            session: {
              prefKey,
              sessionId: s.sessionId || String(s.id),
              sessionKey: s.key || undefined,
              sessionKind,
              runtimeGroup,
              agent: s.agent || undefined,
              nodeId: s.nodeId || undefined,
              nodeLabel: nodeLabel || undefined,
              displayName: sessionName,
              colorTag: typeof pref.color === 'string' ? pref.color : undefined,
              model: s.model,
              tokens: s.tokens,
              workingDir: s.workingDir || null,
              lastUserPrompt: s.lastUserPrompt || null,
              active: !!s.active,
              age: s.age,
            },
            participants: [],
            lastMessage: {
              id: Date.now() + idx,
              conversation_id: `session:${sessionKind}:${s.id}`,
              from_agent: 'system',
              to_agent: null,
              content: `${s.model || kindLabel} • ${s.tokens || ''}`.trim(),
              message_type: 'system' as const,
              created_at: updatedAt || Math.floor(Date.now() / 1000),
            },
            unreadCount: 0,
            updatedAt,
          }
        })

      setConversations(
        providerSessions.sort((a: Conversation, b: Conversation) => b.updatedAt - a.updatedAt)
      )
    } catch (err) {
      log.error('Failed to load conversations:', err)
    }
  }, [setConversations])

  useEffect(() => {
    const handleSessionListUpdated = () => {
      void loadConversations()
    }

    window.addEventListener(SESSION_LIST_UPDATED_EVENT, handleSessionListUpdated)
    return () => window.removeEventListener(SESSION_LIST_UPDATED_EVENT, handleSessionListUpdated)
  }, [loadConversations])

  // Low-frequency fallback in case the OS drops a file notification.
  useSmartPoll(loadConversations, SESSION_LIST_FALLBACK_POLL_MS)

  const handleSelect = (convId: string) => {
    setActiveConversation(convId)
    markConversationRead(convId)
  }

  const filteredConversations = conversations.filter((c) => {
    if (!search) return true
    const s = search.toLowerCase()
    return (
      c.id.toLowerCase().includes(s) ||
      (c.name || '').toLowerCase().includes(s) ||
      c.lastMessage?.from_agent.toLowerCase().includes(s) ||
      c.lastMessage?.content.toLowerCase().includes(s)
    )
  })
  const nodeGroups = Array.from(new Map(
    filteredConversations
      .filter((conversation) => conversation.source === 'session')
      .map((conversation) => {
        const nodeKey = conversation.session?.nodeId || 'default'
        const nodeLabel = conversation.session?.nodeLabel || t('sessions')
        return [nodeKey, nodeLabel] as const
      })
  ).entries()).map(([nodeKey, nodeLabel]) => {
    const rows = filteredConversations.filter((conversation) => {
      if (conversation.source !== 'session') return false
      return (conversation.session?.nodeId || 'default') === nodeKey
    })
    const runtimeGroups = MAIN_AGENT_RUNTIME_ORDER
      .map((groupKey: typeof MAIN_AGENT_RUNTIME_ORDER[number]) => {
        const groupRows = rows.filter((conversation) => {
          const runtimeGroup = conversation.session?.runtimeGroup || getMainAgentRuntimeFromSessionKind(conversation.session?.sessionKind || '')
          return runtimeGroup === groupKey
        })
        if (groupRows.length === 0) return null
        return {
          key: groupKey as RuntimeGroup,
          meta: getMainAgentRuntimeMeta(groupKey),
          active: groupRows.filter((conversation) => conversation.session?.active),
          recent: groupRows.filter((conversation) => !conversation.session?.active),
        }
      })
      .filter((group: {
        key: RuntimeGroup
        meta: ReturnType<typeof getMainAgentRuntimeMeta>
        active: Conversation[]
        recent: Conversation[]
      } | null): group is {
        key: RuntimeGroup
        meta: NonNullable<ReturnType<typeof getMainAgentRuntimeMeta>>
        active: Conversation[]
        recent: Conversation[]
      } => Boolean(group?.meta))

    return { nodeKey, nodeLabel, runtimeGroups }
  })

  useEffect(() => {
    if (nodeGroups.length === 0) return
    setCollapsedGroups((prev) => {
      let changed = false
      const next = { ...prev }
      for (const nodeGroup of nodeGroups) {
        for (const group of nodeGroup.runtimeGroups) {
          const key = `${nodeGroup.nodeKey}:${group.key}`
          if (!(key in next)) {
            next[key] = true
            changed = true
          }
        }
      }
      return changed ? next : prev
    })
  }, [nodeGroups])

  const toggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupKey]: !(prev[groupKey] ?? true) }))
  }, [])

  function renderConversationItem(conv: Conversation) {
    const displayName = conv.name || conv.id.replace('agent_', '')
    const isSessionRow = conv.id.startsWith('session:')
    const isSelected = activeConversation === conv.id
    const isEditing = editingId === conv.id

    return (
      <Button
        key={conv.id}
        onClick={() => handleSelect(conv.id)}
        onDoubleClick={() => { if (conv.session?.prefKey) startRename(conv) }}
        onContextMenu={(e) => handleContextMenu(e, conv)}
        variant="ghost"
        className={`w-full justify-start h-auto px-3 py-2.5 rounded-none ${
          isSelected
            ? 'bg-accent/60 border-l-2 border-primary'
            : 'border-l-2 border-transparent'
        }`}
      >
        <div className="flex items-center gap-2 w-full">
          {/* Mini avatar */}
          <div className="relative flex-shrink-0">
            <SessionKindAvatar
              kind={conv.session?.sessionKind || 'gateway'}
              fallback={displayName.charAt(0).toUpperCase()}
            />
            {isSessionRow && conv.session?.active && (
              <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card ${STATUS_COLORS.busy}`} />
            )}
            {!isSessionRow && (
              <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-card ${STATUS_COLORS.offline}`} />
            )}
          </div>

          <div className="flex-1 min-w-0 text-left">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 min-w-0">
                {conv.session?.colorTag && TAG_COLORS[conv.session.colorTag] && (
                  <span className={`h-2 w-2 rounded-full ${TAG_COLORS[conv.session.colorTag]}`} />
                )}
                {isSessionRow && conv.session?.sessionKind && conv.session.sessionKind !== 'gateway' && (
                  <SessionKindPill kind={conv.session.sessionKind} />
                )}
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => commitRename(conv)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitRename(conv) }
                      if (e.key === 'Escape') { setEditingId(null) }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    maxLength={80}
                    className="w-full bg-surface-1 rounded px-1 py-0.5 text-xs font-medium text-foreground outline-none ring-1 ring-primary/40"
                  />
                ) : (
                  <span className="text-xs font-medium text-foreground truncate">
                    {displayName}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0 ml-1">
                {conv.unreadCount > 0 && (
                  <span className="bg-primary text-primary-foreground text-[9px] rounded-full w-4 h-4 flex items-center justify-center font-medium">
                    {conv.unreadCount}
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground/40">
                  {conv.updatedAt ? timeAgo(conv.updatedAt, t('timeNow')) : ''}
                </span>
              </div>
            </div>
            {conv.lastMessage && !isEditing && (
              <p className="text-[11px] text-muted-foreground/60 truncate mt-0.5">
                {conv.lastMessage.from_agent === 'human'
                  ? `${t('youPrefix')}: ${conv.lastMessage.content}`
                  : conv.lastMessage.content}
              </p>
            )}
          </div>
        </div>
      </Button>
    )
  }

  return (
    <div className="flex flex-col h-full bg-card">
      {/* Header */}
      <div className="p-3 border-b border-border flex-shrink-0">
        <div className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {t('sessionsTitle')}
        </div>
        <div className="relative">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50">
            <circle cx="7" cy="7" r="4" />
            <path d="M14 14l-3-3" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full bg-surface-1 rounded-md pl-7 pr-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {filteredConversations.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground/50">
            {t('noConversations')}
          </div>
        ) : (
          <>
            {nodeGroups.map((nodeGroup) => (
              <div key={nodeGroup.nodeKey}>
                <div className="px-3 pt-2 py-1 text-[10px] uppercase tracking-wider text-blue-300/70">
                  {nodeGroup.nodeLabel}
                </div>
                {nodeGroup.runtimeGroups.map((group: {
                  key: RuntimeGroup
                  meta: NonNullable<ReturnType<typeof getMainAgentRuntimeMeta>>
                  active: Conversation[]
                  recent: Conversation[]
                }) => {
                  const groupKey = `${nodeGroup.nodeKey}:${group.key}`
                  const isCollapsed = collapsedGroups[groupKey] ?? true
                  return (
                    <div key={groupKey}>
                      <button
                        type="button"
                        onClick={() => toggleGroup(groupKey)}
                        className="w-full px-3 pt-2 py-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground/50 hover:text-foreground transition-colors"
                      >
                        <span className="flex items-center gap-2">
                          <span>{isCollapsed ? '▸' : '▾'}</span>
                          <span>{group.meta.label}</span>
                        </span>
                        <span className="text-[10px] font-mono text-muted-foreground/60">
                          ({group.active.length}/{group.active.length + group.recent.length})
                        </span>
                      </button>
                      {!isCollapsed && (
                        <>
                          {group.active.length > 0 && (
                            <div>
                              <div className="px-3 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-green-400/70">
                                <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                                {t('activeLabel')}
                              </div>
                              {group.active.map(renderConversationItem)}
                            </div>
                          )}
                          {group.recent.length > 0 && (
                            <div>
                              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/40">
                                {t('recentLabel')}
                              </div>
                              {group.recent.map(renderConversationItem)}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </>
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (() => {
        const conv = conversations.find((c) => c.id === ctxMenu.convId)
        if (!conv?.session?.prefKey) return null
        return (
          <div
            ref={ctxMenuRef}
            className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-card p-1 shadow-xl"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
          >
            <button
              onClick={() => startRename(conv)}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-xs text-foreground hover:bg-accent/60"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z" />
              </svg>
              {t('rename')}
            </button>
            <div className="my-1 border-t border-border/50" />
            <div className="px-2.5 py-1.5">
              <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">{t('color')}</div>
              <div className="flex flex-wrap gap-1.5">
                {colorOptions.map((opt) => {
                  const isCurrentColor = (conv.session?.colorTag || '') === opt.value
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setColor(conv, opt.value)}
                      title={opt.label}
                      className={`h-5 w-5 rounded-full border-2 transition-transform hover:scale-110 ${
                        isCurrentColor ? 'border-foreground scale-110' : 'border-transparent'
                      } ${opt.value ? TAG_COLORS[opt.value] || 'bg-muted' : 'bg-muted/50'}`}
                    >
                      {!opt.value && (
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="m-auto text-muted-foreground/60">
                          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                        </svg>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
