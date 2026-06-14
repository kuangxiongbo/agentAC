'use client'

import { useEffect, useLayoutEffect, useCallback, useState, useRef, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { useAgentCenterStore, type Conversation, type ChatAttachment } from '@/store'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { createClientLogger } from '@/lib/client-logger'
import {
  SESSION_LIST_UPDATED_EVENT,
  SESSION_TRANSCRIPT_UPDATED_EVENT,
  sessionKindFromSource,
  type SessionRealtimePayload,
} from '@/lib/session-realtime-events'
import { Loader } from '@/components/ui/loader'
import { ConversationList } from './conversation-list'
import { MessageList } from './message-list'
import { ChatInput } from './chat-input'
import { LocalCliElevationButton } from './local-cli-elevation-button'
import { Button } from '@/components/ui/button'
import {
  SessionMessage,
  SessionReplyStatusRow,
  shouldShowTimestamp,
  type SessionTranscriptMessage,
} from './session-message'
import {
  continuingProgressLabel,
  isReplyCycleComplete,
  resolveReplyProgressUi,
  thinkingProgressLabel,
  transcriptsEqual,
} from './session-thinking-progress'
import { getSessionKindLabel, SessionKindAvatar } from './session-kind-brand'
import {
  getAgentLocalSessionKind,
  validateAgentSessionKindBinding,
} from '@/lib/agent-session-binding'

const log = createClientLogger('ChatWorkspace')
const ACTIVE_SESSION_TRANSCRIPT_FALLBACK_POLL_MS = 5000
const IDLE_SESSION_TRANSCRIPT_FALLBACK_POLL_MS = 30000

declare global {
  interface Window {
    __mcWebSocket?: WebSocket
  }
}

interface ChatWorkspaceProps {
  mode?: 'overlay' | 'embedded'
  onClose?: () => void
}

export function ChatWorkspace({ mode = 'embedded', onClose }: ChatWorkspaceProps) {
  const t = useTranslations('chat')
  const {
    activeConversation,
    setActiveConversation,
    setChatMessages,
    setConversations,
    addChatMessage,
    replacePendingMessage,
    updatePendingMessage,
    agents,
    conversations,
    setAgents,
    notifications,
  } = useAgentCenterStore()

  const pendingIdRef = useRef(-1)
  const sessionTranscriptRequestIdRef = useRef(0)
  const sessionTranscriptRef = useRef<SessionTranscriptMessage[]>([])
  const transcriptCacheRef = useRef(new Map<string, SessionTranscriptMessage[]>())

  const [showConversations, setShowConversations] = useState(true)
  const [isMobile, setIsMobile] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [sessionTranscript, setSessionTranscript] = useState<SessionTranscriptMessage[]>([])
  const [sessionTranscriptLoading, setSessionTranscriptLoading] = useState(false)
  const [sessionTranscriptError, setSessionTranscriptError] = useState<string | null>(null)
  const [transcriptHasMoreOlder, setTranscriptHasMoreOlder] = useState(false)
  const [transcriptOlderCursor, setTranscriptOlderCursor] = useState<string | null>(null)
  const [transcriptLoadingOlder, setTranscriptLoadingOlder] = useState(false)
  const transcriptOlderCursorRef = useRef<string | null>(null)
  const transcriptSourceMtimeRef = useRef(0)
  const autoExpandHistoryInFlightRef = useRef(false)
  const isOverlay = mode === 'overlay'
  const selectedConversation = conversations.find((c) => c.id === activeConversation)
  const selectedSession = selectedConversation?.session

  sessionTranscriptRef.current = sessionTranscript

  // Detect mobile
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  useEffect(() => {
    return () => {
      sessionTranscriptRequestIdRef.current += 1
    }
  }, [])

  // Switch session: show cached transcript instantly, then refresh in background
  useEffect(() => {
    if (!activeConversation?.startsWith('session:')) return
    sessionTranscriptRequestIdRef.current += 1
    const cached = transcriptCacheRef.current.get(activeConversation)
    if (cached) {
      setSessionTranscript(cached)
      setSessionTranscriptLoading(false)
    } else {
      setSessionTranscript([])
      setSessionTranscriptLoading(true)
    }
    setSessionTranscriptError(null)
    setTranscriptHasMoreOlder(false)
    setTranscriptOlderCursor(null)
    transcriptOlderCursorRef.current = null
    transcriptSourceMtimeRef.current = 0
  }, [activeConversation])

  useEffect(() => {
    transcriptOlderCursorRef.current = transcriptOlderCursor
  }, [transcriptOlderCursor])

  // On mobile, hide conversations when a conversation is selected
  useEffect(() => {
    if (isMobile && activeConversation) {
      setShowConversations(false)
    }
  }, [isMobile, activeConversation])

  // Load agents list
  useEffect(() => {
    async function loadAgents() {
      try {
        const res = await fetch('/api/agents')
        if (!res.ok) return
        const data = await res.json()
        if (data.agents) setAgents(data.agents)
      } catch (err) {
        log.error('Failed to load agents:', err)
      }
    }

    loadAgents()
  }, [setAgents])

  // Load messages when conversation changes
  const loadMessages = useCallback(async () => {
    if (!activeConversation) return
    if (activeConversation.startsWith('session:')) {
      setChatMessages([])
      return
    }

    try {
      const res = await fetch(`/api/chat/messages?conversation_id=${encodeURIComponent(activeConversation)}&limit=100`)
      if (!res.ok) return
      const data = await res.json()
      if (data.messages) setChatMessages(data.messages)
    } catch (err) {
      log.error('Failed to load messages:', err)
    }
  }, [activeConversation, setChatMessages])

  useEffect(() => {
    loadMessages()
  }, [loadMessages])

  // Poll for new messages (visibility-aware)
  useSmartPoll(loadMessages, 15000, {
    enabled: !!activeConversation && !activeConversation.startsWith('session:'),
    pauseWhenSseConnected: true,
  })

  // Close on Escape (overlay mode)
  useEffect(() => {
    if (!isOverlay || !onClose) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOverlay, onClose])

  // Send message handler with optimistic updates
  const handleSend = async (
    content: string,
    attachments?: ChatAttachment[],
    options?: { localCliElevated?: boolean },
  ) => {
    if (!activeConversation) return

    const mentionMatch = content.match(/^@(\w+)\s/)
    let to = mentionMatch ? mentionMatch[1] : null
    const cleanContent = mentionMatch ? content.slice(mentionMatch[0].length) : content

    if (!to && activeConversation.startsWith('agent_')) {
      to = activeConversation.replace('agent_', '')
    }

    // Create optimistic message with negative temp ID
    pendingIdRef.current -= 1
    const tempId = pendingIdRef.current
    const optimisticMessage = {
      id: tempId,
      conversation_id: activeConversation,
      from_agent: 'human',
      to_agent: to,
      content: cleanContent,
      message_type: 'text' as const,
      attachments,
      created_at: Math.floor(Date.now() / 1000),
      pendingStatus: 'sending' as const,
    }

    addChatMessage(optimisticMessage)
    setIsGenerating(true)

    try {
      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'human',
          to,
          content: cleanContent,
          conversation_id: activeConversation,
          message_type: 'text',
          attachments,
          forward: true,
          ...(options?.localCliElevated ? { local_cli_elevated: true } : {}),
        }),
      })

      if (res.ok) {
        const data = await res.json()
        if (data.message) {
          replacePendingMessage(tempId, data.message)
        }
      } else {
        updatePendingMessage(tempId, { pendingStatus: 'failed' })
      }
    } catch (err) {
      log.error('Failed to send message:', err)
      updatePendingMessage(tempId, { pendingStatus: 'failed' })
    } finally {
      setIsGenerating(false)
    }
  }

  // Abort active generation
  const handleAbort = useCallback(() => {
    if (!activeConversation) return
    // Try to send cancel RPC via websocket if available
    try {
      const ws = window.__mcWebSocket
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'req',
          method: 'chat.cancel',
          id: `mc-cancel-${Date.now()}`,
          params: { sessionId: activeConversation },
        }))
      }
    } catch (err) {
      log.error('Failed to send abort:', err)
    }
    setIsGenerating(false)
  }, [activeConversation])

  const handleNewConversation = (agentName: string) => {
    const convId = `agent_${agentName}`
    setActiveConversation(convId)
    if (isMobile) setShowConversations(false)
  }

  const handleBackToList = () => {
    setShowConversations(true)
    if (isMobile) setActiveConversation(null)
  }

  const canSendMessage =
    !!activeConversation &&
    !activeConversation.startsWith('session:')

  const loadSessionTranscript = useCallback(async (options?: {
    background?: boolean
    older?: boolean
    forceFresh?: boolean
  }) => {
    const sessionMeta = selectedSession
    const cacheKey = activeConversation
    if (!sessionMeta) {
      sessionTranscriptRequestIdRef.current += 1
      setSessionTranscript([])
      setSessionTranscriptError(null)
      setSessionTranscriptLoading(false)
      return
    }

    const isOlder = options?.older === true
    const beforeCursor = isOlder ? transcriptOlderCursorRef.current : null
    if (isOlder && !beforeCursor) return

    const requestId = sessionTranscriptRequestIdRef.current + 1
    sessionTranscriptRequestIdRef.current = requestId
    const hasCache = cacheKey ? transcriptCacheRef.current.has(cacheKey) : false
    const hasVisibleTranscript =
      sessionTranscriptRef.current.length > 0 || (hasCache && cacheKey ? (transcriptCacheRef.current.get(cacheKey)?.length ?? 0) > 0 : false)
    const background = options?.background === true
    if (isOlder) {
      setTranscriptLoadingOlder(true)
    } else if (!background || !hasVisibleTranscript) {
      setSessionTranscriptLoading(true)
    }
    setSessionTranscriptError(null)

    const messageLimit = sessionMeta.sessionKind === 'codex-cli' ? 80 : 40
    const beforeParam = isOlder && beforeCursor ? `&before=${encodeURIComponent(beforeCursor)}` : ''
    const nocacheParam = background && !isOlder && !options?.forceFresh ? '' : '&nocache=1'
    const clientIdParam = sessionMeta.nodeId
      ? `&client_id=${encodeURIComponent(sessionMeta.nodeId)}`
      : ''
    const url = sessionMeta.sessionKind === 'gateway'
      ? `/api/sessions/transcript/gateway?key=${encodeURIComponent(sessionMeta.sessionKey || sessionMeta.sessionId)}&limit=50${nocacheParam}`
      : `/api/sessions/transcript?kind=${encodeURIComponent(sessionMeta.sessionKind)}&id=${encodeURIComponent(sessionMeta.sessionId)}&limit=${messageLimit}${nocacheParam}${beforeParam}${clientIdParam}`

    try {
      const res = await fetch(url)
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload?.error || 'Failed to load transcript')
      }

      const data = await res.json()
      if (sessionTranscriptRequestIdRef.current !== requestId) return
      const nextMessages = Array.isArray(data?.messages) ? data.messages : []
      const hasMore = Boolean(data?.hasMoreOlder)
      const nextCursor = typeof data?.nextOlderCursor === 'string' ? data.nextOlderCursor : null
      const sourceMtime = typeof data?.sourceMtimeMs === 'number' ? data.sourceMtimeMs : 0
      const prevMessages = sessionTranscriptRef.current

      if (
        background
        && !isOlder
        && sourceMtime > 0
        && sourceMtime === transcriptSourceMtimeRef.current
        && transcriptsEqual(prevMessages, nextMessages)
      ) {
        return
      }

      if (isOlder) {
        setSessionTranscript((prev) => [...nextMessages, ...prev])
        const prefKey = sessionMeta.prefKey
        if (prefKey && !sessionMeta.historyExpanded) {
          void fetch('/api/chat/session-prefs', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: prefKey, historyExpanded: true }),
          }).catch(() => {})
          const currentConversations = useAgentCenterStore.getState().conversations
          setConversations(
            currentConversations.map((conv) => {
              if (conv.id !== cacheKey || !conv.session) return conv
              return {
                ...conv,
                session: { ...conv.session, historyExpanded: true },
              }
            }),
          )
        }
      } else if (background && transcriptOlderCursorRef.current) {
        setSessionTranscript((prev) => {
          const merged =
            prev.length <= nextMessages.length
              ? nextMessages
              : [...prev.slice(0, prev.length - nextMessages.length), ...nextMessages]
          if (cacheKey) transcriptCacheRef.current.set(cacheKey, merged)
          return merged
        })
      } else if (background && transcriptsEqual(prevMessages, nextMessages)) {
        if (cacheKey) transcriptCacheRef.current.set(cacheKey, nextMessages)
        if (sourceMtime > 0) transcriptSourceMtimeRef.current = sourceMtime
      } else {
        if (cacheKey) transcriptCacheRef.current.set(cacheKey, nextMessages)
        setSessionTranscript(nextMessages)
      }

      setTranscriptHasMoreOlder(hasMore)
      setTranscriptOlderCursor(nextCursor)
      if (sourceMtime > 0) transcriptSourceMtimeRef.current = sourceMtime
    } catch (err) {
      if (sessionTranscriptRequestIdRef.current !== requestId) return
      if (!background && !isOlder) {
        setSessionTranscript([])
      }
      setSessionTranscriptError(err instanceof Error ? err.message : 'Failed to load transcript')
    } finally {
      if (sessionTranscriptRequestIdRef.current === requestId) {
        if (isOlder) {
          setTranscriptLoadingOlder(false)
        } else {
          setSessionTranscriptLoading(false)
        }
      }
    }
  }, [selectedSession, activeConversation, setConversations])

  useEffect(() => {
    void loadSessionTranscript({ background: false })
  }, [loadSessionTranscript])

  useEffect(() => {
    if (!selectedSession?.historyExpanded) {
      autoExpandHistoryInFlightRef.current = false
      return
    }
    if (sessionTranscriptLoading || transcriptLoadingOlder) return
    if (!transcriptHasMoreOlder || !transcriptOlderCursor) return
    if (autoExpandHistoryInFlightRef.current) return
    autoExpandHistoryInFlightRef.current = true
    void loadSessionTranscript({ background: true, older: true }).finally(() => {
      autoExpandHistoryInFlightRef.current = false
    })
  }, [
    selectedSession?.historyExpanded,
    selectedSession?.prefKey,
    sessionTranscriptLoading,
    transcriptLoadingOlder,
    transcriptHasMoreOlder,
    transcriptOlderCursor,
    loadSessionTranscript,
  ])

  useEffect(() => {
    if (!selectedSession) return

    const handleTranscriptUpdated = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<SessionRealtimePayload | undefined>).detail
      if (!shouldRefreshSelectedSession(selectedSession, detail)) return
      void loadSessionTranscript({ background: true })
    }

    window.addEventListener(SESSION_TRANSCRIPT_UPDATED_EVENT, handleTranscriptUpdated)
    return () => window.removeEventListener(SESSION_TRANSCRIPT_UPDATED_EVENT, handleTranscriptUpdated)
  }, [selectedSession, loadSessionTranscript])

  useSmartPoll(
    () => loadSessionTranscript({ background: true, forceFresh: true }),
    selectedSession?.active ? ACTIVE_SESSION_TRANSCRIPT_FALLBACK_POLL_MS : IDLE_SESSION_TRANSCRIPT_FALLBACK_POLL_MS,
    {
      enabled: !!selectedSession,
      // Remote edge transcripts may not get prompt_completed on the center host.
      pauseWhenSseConnected: !selectedSession?.nodeId,
    }
  )

  const refreshSessionTranscript = useCallback(
    (options?: { background?: boolean; forceFresh?: boolean }) => {
      const background = options?.background ?? false
      if (!background && activeConversation) {
        transcriptCacheRef.current.delete(activeConversation)
        setTranscriptHasMoreOlder(false)
        setTranscriptOlderCursor(null)
        transcriptOlderCursorRef.current = null
      }
      void loadSessionTranscript({
        background,
        forceFresh: options?.forceFresh,
      })
    },
    [activeConversation, loadSessionTranscript]
  )

  const handleSaveSessionPreferences = useCallback(async (payload: {
    prefKey: string
    displayName?: string
    colorTag?: string
    historyExpanded?: boolean
  }) => {
    const body: Record<string, unknown> = { key: payload.prefKey }
    if (payload.displayName !== undefined) body.name = payload.displayName || null
    if (payload.colorTag !== undefined) body.color = payload.colorTag || null
    if (payload.historyExpanded !== undefined) body.historyExpanded = payload.historyExpanded

    const res = await fetch('/api/chat/session-prefs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to save session preferences')
    }

    if (!activeConversation) return
    setConversations(
      conversations.map((conv) => {
        if (conv.id !== activeConversation || !conv.session) return conv
        return {
          ...conv,
          name: payload.displayName || conv.name,
          session: {
            ...conv.session,
            displayName:
              payload.displayName !== undefined
                ? payload.displayName || conv.session.displayName
                : conv.session.displayName,
            colorTag: payload.colorTag !== undefined ? payload.colorTag || undefined : conv.session.colorTag,
            historyExpanded:
              payload.historyExpanded !== undefined
                ? payload.historyExpanded
                : conv.session.historyExpanded,
          },
        }
      })
    )
  }, [activeConversation, conversations, setConversations])

  return (
    <div className={`flex h-full flex-col bg-card ${focusMode ? 'fixed inset-0 z-50' : ''}`}>
      {/* Header */}
      <div className={`glass-strong flex h-12 flex-shrink-0 items-center justify-between border-b border-border px-4 ${focusMode ? 'h-10' : ''}`}>
        <div className="flex items-center gap-3">
          {/* Back button on mobile when in chat view */}
          {isMobile && !showConversations && (
            <Button
              onClick={handleBackToList}
              variant="ghost"
              size="icon-xs"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 12L6 8l4-4" />
              </svg>
            </Button>
          )}
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
              <path d="M14 10c0 .37-.1.7-.28 1-.53.87-2.2 3-5.72 3-4.42 0-6-3-6-4V4a2 2 0 012-2h8a2 2 0 012 2v6z" />
              <path d="M6 7h.01M10 7h.01" />
            </svg>
            <span className="text-sm font-semibold text-foreground">Agent Chat</span>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {agents.filter(a => a.status === 'busy' || a.status === 'idle').length} online
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Focus mode toggle */}
          <Button
            onClick={() => setFocusMode(f => !f)}
            variant="ghost"
            size="icon-xs"
            className="hidden md:flex"
            title={focusMode ? 'Exit focus mode' : 'Focus mode'}
          >
            {focusMode ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 14h8M4 2h8M2 4v8M14 4v8" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M2 2h4M10 2h4M2 14h4M10 14h4M2 2v4M14 2v4M2 14v-4M14 14v-4" />
              </svg>
            )}
          </Button>

          {/* Toggle conversations sidebar (desktop) */}
          <Button
            onClick={() => setShowConversations(!showConversations)}
            variant="ghost"
            size="icon-xs"
            className="hidden md:flex"
            title={showConversations ? 'Hide conversations' : 'Show conversations'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </Button>

          {isOverlay && onClose && (
            <Button
              onClick={onClose}
              variant="ghost"
              size="icon-xs"
              title="Close chat (Esc)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </Button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Conversations sidebar */}
        {showConversations && !focusMode && (
          <div className={`${isMobile ? 'w-full' : 'w-56 border-r border-border'} flex-shrink-0`}>
            <ConversationList onNewConversation={handleNewConversation} />
          </div>
        )}

        {/* Message area */}
        {(!isMobile || !showConversations) && (
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Conversation header */}
            {activeConversation && (
              <div className="bg-surface-1 flex flex-shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2">
                <AgentAvatar
                  name={(selectedConversation?.name || activeConversation).replace('agent_', '')}
                  size="sm"
                />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {(selectedConversation?.name || activeConversation).replace('agent_', '')}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {getConversationStatus(agents, activeConversation, {
                      localClaude: t('conversationStatusLocalClaude'),
                      localCodex: t('conversationStatusLocalCodex'),
                      localHermes: t('conversationStatusLocalHermes'),
                      gateway: t('conversationStatusGateway'),
                      unknown: t('conversationStatusUnknown'),
                      online: t('conversationStatusOnline'),
                      offline: t('conversationStatusOffline'),
                    })}
                  </div>
                </div>
              </div>
            )}

            {selectedConversation?.source === 'session' && selectedConversation.session ? (
              <SessionConversationView
                key={activeConversation}
                session={selectedConversation.session}
                seedUserPrompt={selectedConversation.lastMessage?.content}
                messages={sessionTranscript}
                loading={sessionTranscriptLoading}
                error={sessionTranscriptError}
                hasMoreOlder={transcriptHasMoreOlder}
                loadingOlder={transcriptLoadingOlder}
                onLoadOlder={() => void loadSessionTranscript({ background: true, older: true })}
                onRefreshTranscript={refreshSessionTranscript}
                onSavePreferences={handleSaveSessionPreferences}
              />
            ) : (
              <>
                <MessageList />
                <ChatIndicators notifications={notifications} compactionLabel={t('contextCompaction')} fallbackLabel={t('modelFallback')} />
                <ChatInput
                  onSend={handleSend}
                  onAbort={handleAbort}
                  disabled={!canSendMessage}
                  agents={agents.map(a => ({ name: a.name, role: a.role }))}
                  isGenerating={isGenerating}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ProvisioningSessionView({
  agentId,
  sessionKind,
  displayName,
  agents,
  setActiveConversation,
  updateAgent,
  initialPendingLine,
}: {
  agentId: number
  sessionKind: NonNullable<Conversation['session']>['sessionKind']
  displayName: string
  agents: ReturnType<typeof useAgentCenterStore.getState>['agents']
  setActiveConversation: (id: string | null) => void
  updateAgent: (agentId: number, updates: Partial<(typeof agents)[number]>) => void
  initialPendingLine?: string | null
}) {
  const t = useTranslations('chat')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [pendingLine, setPendingLine] = useState<string | null>(initialPendingLine?.trim() || null)
  const agent = agents.find((row) => row.id === agentId)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const response = await fetch(`/api/agents/${agentId}`)
        if (!response.ok || cancelled) return
        const data = await response.json()
        const row = data?.agent
        const nextKey = String(row?.session_key || '').trim()
        const cfg = row?.config && typeof row.config === 'object' ? row.config as Record<string, unknown> : {}
        const err = String(cfg.last_session_error || cfg.session_bootstrap_error || '').trim()
        if (err) setErrorText(err)
        if (nextKey) {
          updateAgent(agentId, { session_key: nextKey, status: row?.status || 'idle' })
          setActiveConversation(`session:${sessionKind}:${nextKey}`)
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(SESSION_LIST_UPDATED_EVENT))
          }
        }
      } catch {
        // ignore transient poll errors
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [agentId, sessionKind, setActiveConversation, updateAgent])

  useEffect(() => {
    if (initialPendingLine?.trim()) {
      setPendingLine(initialPendingLine.trim())
    }
  }, [initialPendingLine])

  useEffect(() => {
    const handleTranscriptUpdated = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<SessionRealtimePayload | undefined>).detail
      if (detail?.agentId !== agentId) return
      if (detail.pendingPrompt?.trim()) {
        setPendingLine(detail.pendingPrompt.trim())
      }
      if (detail.reason === 'prompt_failed') {
        setErrorText((prev) => prev || t('provisioningSessionFailed', { error: 'background prompt failed' }))
      }
    }
    window.addEventListener(SESSION_TRANSCRIPT_UPDATED_EVENT, handleTranscriptUpdated)
    return () => window.removeEventListener(SESSION_TRANSCRIPT_UPDATED_EVENT, handleTranscriptUpdated)
  }, [agentId, t])

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Loader variant="inline" label={t('provisioningSessionTitle')} />
      <div className="text-sm font-medium text-foreground">{displayName || agent?.name}</div>
      <p className="max-w-md text-xs text-muted-foreground">{t('provisioningSessionHint')}</p>
      {pendingLine && (
        <p className="max-w-lg truncate text-xs text-muted-foreground" title={pendingLine}>
          {pendingLine}
        </p>
      )}
      {errorText && (
        <p className="max-w-md text-xs text-destructive">
          {t('provisioningSessionFailed', { error: errorText })}
        </p>
      )}
    </div>
  )
}

function SessionConversationView({
  session,
  seedUserPrompt,
  messages,
  loading,
  error,
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
  onRefreshTranscript,
  onSavePreferences,
}: {
  session: NonNullable<Conversation['session']>
  seedUserPrompt?: string
  messages: SessionTranscriptMessage[]
  loading: boolean
  error: string | null
  hasMoreOlder: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
  onRefreshTranscript: (options?: { background?: boolean; forceFresh?: boolean }) => void
  onSavePreferences: (payload: { prefKey: string; displayName?: string; colorTag?: string }) => Promise<void>
}) {
  const t = useTranslations('chat')
  const { centralMode, agents: storeAgents, setActiveConversation, updateAgent } = useAgentCenterStore()

  if (session.provisioning && session.boundAgentId != null) {
    return (
      <ProvisioningSessionView
        agentId={session.boundAgentId}
        sessionKind={session.sessionKind}
        displayName={session.displayName || ''}
        agents={storeAgents}
        setActiveConversation={setActiveConversation}
        updateAgent={updateAgent}
        initialPendingLine={seedUserPrompt}
      />
    )
  }
  const [bindAgentName, setBindAgentName] = useState('')
  const isGatewaySession = session.sessionKind === 'gateway'
  const isRemoteEdgeSession = Boolean(session.nodeId)
  const needsEdgeClientForContinue =
    centralMode && !isGatewaySession && !session.nodeId
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null)
  const prevTranscriptCountRef = useRef(0)
  const stickToBottomRef = useRef(true)
  const [showNewTranscript, setShowNewTranscript] = useState(false)
  const [continuePrompt, setContinuePrompt] = useState('')
  const [continueElevated, setContinueElevated] = useState(false)
  const [continueBusy, setContinueBusy] = useState(false)
  const [awaitingReplySeconds, setAwaitingReplySeconds] = useState(0)
  const [continueError, setContinueError] = useState<string | null>(null)
  const continueSendLockRef = useRef(false)
  const [pendingUserMessage, setPendingUserMessage] = useState<SessionTranscriptMessage | null>(null)
  const [backgroundPromptBusy, setBackgroundPromptBusy] = useState(false)
  const awaitingReplyPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const transcriptBaselineRef = useRef(0)
  const [nameDraft, setNameDraft] = useState(session.displayName || '')
  const [colorDraft, setColorDraft] = useState(session.colorTag || '')
  const [prefBusy, setPrefBusy] = useState(false)
  const [prefError, setPrefError] = useState<string | null>(null)
  const [linkedAgents, setLinkedAgents] = useState<Array<{ id: number; name: string; session_key: string | null }>>([])
  const [bindingDraft, setBindingDraft] = useState<Record<number, string>>({})
  const [bindingBusy, setBindingBusy] = useState(false)
  const [bindingMessage, setBindingMessage] = useState<string | null>(null)
  const [copiedSessionId, setCopiedSessionId] = useState(false)
  const hasPrefChanges =
    nameDraft.trim() !== (session.displayName || '').trim() ||
    colorDraft !== (session.colorTag || '')

  const bindableAgents = useMemo(() => {
    if (isGatewaySession) return []
    return storeAgents.filter((agent) => {
      const agentKind = getAgentLocalSessionKind(
        String((agent as { framework?: string }).framework || ''),
      )
      return agentKind === session.sessionKind
    })
  }, [isGatewaySession, storeAgents, session.sessionKind])

  useEffect(() => {
    setNameDraft(session.displayName || '')
    setColorDraft(session.colorTag || '')
    setPrefError(null)
    setContinueError(null)
    setPendingUserMessage(null)
    setBackgroundPromptBusy(false)
    setBindingMessage(null)
  }, [session.prefKey, session.displayName, session.colorTag])

  const sessionMatchesRealtimeEvent = useCallback((detail?: SessionRealtimePayload) => {
    if (shouldRefreshSelectedSession(session, detail)) return true
    if (
      detail?.agentId != null &&
      session.boundAgentId != null &&
      detail.agentId === session.boundAgentId
    ) {
      return true
    }
    if (detail?.agentId != null && linkedAgents.some((agent) => agent.id === detail.agentId)) {
      return true
    }
    return false
  }, [session, linkedAgents])

  const applyPendingPromptFromRealtime = useCallback((detail?: SessionRealtimePayload) => {
    if (!detail) return false
    const text = detail.pendingPrompt?.trim()
    if (!text) return false
    if (detail.reason !== 'prompt_queued' && detail.reason !== 'continue_queued') return false
    if (!sessionMatchesRealtimeEvent(detail)) return false
    setPendingUserMessage({
      role: 'user',
      parts: [{ type: 'text', text }],
      timestamp: new Date().toISOString(),
    })
    setBackgroundPromptBusy(true)
    transcriptBaselineRef.current = messages.length
    stickToBottomRef.current = true
    return true
  }, [session, messages.length, sessionMatchesRealtimeEvent])

  useEffect(() => {
    const handleTranscriptUpdated = (rawEvent: Event) => {
      const detail = (rawEvent as CustomEvent<SessionRealtimePayload | undefined>).detail
      if (!sessionMatchesRealtimeEvent(detail)) return

      if (
        detail?.reason === 'prompt_completed'
        || detail?.reason === 'prompt_failed'
        || detail?.reason === 'bridge_continue'
      ) {
        setBackgroundPromptBusy(false)
      } else {
        applyPendingPromptFromRealtime(detail)
      }
      onRefreshTranscript({ background: true, forceFresh: true })
    }

    window.addEventListener(SESSION_TRANSCRIPT_UPDATED_EVENT, handleTranscriptUpdated)
    return () => window.removeEventListener(SESSION_TRANSCRIPT_UPDATED_EVENT, handleTranscriptUpdated)
  }, [session, onRefreshTranscript, applyPendingPromptFromRealtime, sessionMatchesRealtimeEvent])

  const reloadLinkedAgents = useCallback(async () => {
    if (isGatewaySession) {
      setLinkedAgents([])
      return
    }
    const params = new URLSearchParams({ session_id: session.sessionId })
    if (session.sessionKey) params.set('session_key', session.sessionKey)
    if (session.nodeId) params.set('client_id', session.nodeId)
    try {
      const res = await fetch(`/api/agents/by-session?${params}`)
      const data = res.ok ? await res.json() : { agents: [] }
      const agents = Array.isArray(data.agents) ? data.agents : []
      setLinkedAgents(agents)
      const drafts: Record<number, string> = {}
      for (const agent of agents) {
        drafts[agent.id] = agent.session_key || session.sessionId
      }
      setBindingDraft(drafts)

      if (agents.length === 0) {
        const workingDir = session.workingDir?.trim()
        if (workingDir) {
          const normalizedDir = workingDir.replace(/\\/g, '/').replace(/\/+$/, '')
          const candidates = storeAgents.filter((agent) => {
            if (String(agent.session_key || '').trim()) return false
            const agentKind = getAgentLocalSessionKind(
              String((agent as { framework?: string }).framework || ''),
            )
            if (agentKind !== session.sessionKind) return false
            const agentPath = String((agent as { workspace_path?: string }).workspace_path || '').trim()
            if (!agentPath) return false
            return agentPath.replace(/\\/g, '/').replace(/\/+$/, '') === normalizedDir
          })
          if (candidates.length === 1) {
            const bindRes = await fetch('/api/agents', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: candidates[0].name,
                session_key: session.sessionId,
                session_kind: session.sessionKind,
              }),
            })
            if (bindRes.ok) {
              const rebound = await fetch(`/api/agents/by-session?${params}`)
              const reboundData = rebound.ok ? await rebound.json() : { agents: [] }
              const reboundAgents = Array.isArray(reboundData.agents) ? reboundData.agents : []
              setLinkedAgents(reboundAgents)
              for (const agent of reboundAgents) {
                drafts[agent.id] = agent.session_key || session.sessionId
              }
              setBindingDraft(drafts)
            }
          }
        }
      }
    } catch {
      setLinkedAgents([])
    }
  }, [isGatewaySession, session.sessionId, session.sessionKey, session.workingDir, storeAgents])

  useEffect(() => {
    void reloadLinkedAgents()
  }, [reloadLinkedAgents])

  const awaitingReply = continueBusy || backgroundPromptBusy

  const displayMessages = useMemo(() => {
    const merged = [...messages]
    if (pendingUserMessage) {
      const text = getUserTextFromTranscriptMessage(pendingUserMessage)
      if (!transcriptHasUserPrompt(messages, text)) {
        merged.push(pendingUserMessage)
      }
    }
    return merged
  }, [messages, pendingUserMessage])

  const hasCompletedReplyForCurrentTurn = useMemo(
    () => isReplyCycleComplete(messages, transcriptBaselineRef.current),
    [messages],
  )

  const replyProgressUi = useMemo(
    () =>
      resolveReplyProgressUi(
        awaitingReply,
        messages,
        transcriptBaselineRef.current,
        awaitingReplySeconds,
      ),
    [awaitingReply, messages, awaitingReplySeconds],
  )

  const waitingProgressText = useMemo(() => {
    if (replyProgressUi.mode !== 'waiting' || !replyProgressUi.progress) return ''
    return thinkingProgressLabel(replyProgressUi.progress, {
      thinking: (seconds) => t('assistantThinkingProgress', { seconds }),
      tool: (tool, seconds) => t('assistantToolProgress', { tool, seconds }),
      responding: (seconds) => t('assistantRespondingProgress', { seconds }),
    })
  }, [replyProgressUi, t])

  const continuingProgressText = useMemo(() => {
    if (replyProgressUi.mode !== 'continuing' || !replyProgressUi.progress) return ''
    return continuingProgressLabel(replyProgressUi.progress, {
      continuing: (seconds) => t('assistantNextReplyProgress', { seconds }),
      tool: (tool, seconds) => t('assistantContinuingToolProgress', { tool, seconds }),
    })
  }, [replyProgressUi, t])

  const showReplyProgressBanner =
    replyProgressUi.mode === 'waiting' || replyProgressUi.mode === 'continuing'

  useEffect(() => {
    if (!pendingUserMessage) return
    const text = getUserTextFromTranscriptMessage(pendingUserMessage)
    if (transcriptHasUserPrompt(messages, text)) {
      setPendingUserMessage(null)
    }
  }, [messages, pendingUserMessage])

  useEffect(() => {
    if (!awaitingReply) {
      setAwaitingReplySeconds(0)
      if (awaitingReplyPollRef.current) {
        clearInterval(awaitingReplyPollRef.current)
        awaitingReplyPollRef.current = null
      }
      return
    }
    const started = Date.now()
    const tickSeconds = setInterval(() => {
      setAwaitingReplySeconds(Math.floor((Date.now() - started) / 1000))
    }, 1000)
    onRefreshTranscript({ background: true, forceFresh: true })
    awaitingReplyPollRef.current = setInterval(
      () => onRefreshTranscript({ background: true, forceFresh: true }),
      2000,
    )
    return () => {
      clearInterval(tickSeconds)
      if (awaitingReplyPollRef.current) {
        clearInterval(awaitingReplyPollRef.current)
        awaitingReplyPollRef.current = null
      }
    }
  }, [awaitingReply, onRefreshTranscript])

  // End send lock when transcript shows a complete reply (esp. remote/bridge without prompt_completed).
  useEffect(() => {
    if (!backgroundPromptBusy && !pendingUserMessage) return
    if (!hasCompletedReplyForCurrentTurn) return
    setBackgroundPromptBusy(false)
    setPendingUserMessage(null)
  }, [hasCompletedReplyForCurrentTurn, backgroundPromptBusy, pendingUserMessage])

  const isTranscriptNearBottom = useCallback(() => {
    const container = transcriptScrollRef.current
    if (!container) return true
    return container.scrollHeight - container.scrollTop - container.clientHeight < 120
  }, [])

  const scrollTranscriptToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = transcriptScrollRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
    if (behavior === 'smooth') {
      container.scrollTo({ top: container.scrollHeight, behavior })
    }
  }, [])

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return
    if (!pendingUserMessage && !awaitingReply && !showReplyProgressBanner) return
    scrollTranscriptToBottom('auto')
    requestAnimationFrame(() => {
      if (stickToBottomRef.current) scrollTranscriptToBottom('auto')
    })
  }, [pendingUserMessage, awaitingReply, showReplyProgressBanner, awaitingReplySeconds, scrollTranscriptToBottom])

  // Open / switch session: always land on latest messages at the bottom
  useEffect(() => {
    stickToBottomRef.current = true
    prevTranscriptCountRef.current = 0
    setShowNewTranscript(false)
  }, [session.prefKey])

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return
    if (loading && messages.length === 0) return
    scrollTranscriptToBottom('auto')
    requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return
      scrollTranscriptToBottom('auto')
    })
  }, [session.prefKey, loading, messages, scrollTranscriptToBottom])

  // Background refresh: only follow tail if user is at bottom (or still pinning open)
  useEffect(() => {
    if (loading) return
    const count = messages.length
    if (count > prevTranscriptCountRef.current) {
      if (stickToBottomRef.current || isTranscriptNearBottom()) {
        requestAnimationFrame(() => {
          scrollTranscriptToBottom(count - prevTranscriptCountRef.current > 5 ? 'auto' : 'smooth')
        })
        setShowNewTranscript(false)
      } else if (count > 0) {
        setShowNewTranscript(true)
      }
    }
    prevTranscriptCountRef.current = count
  }, [messages, loading, isTranscriptNearBottom, scrollTranscriptToBottom])

  const handleTranscriptScroll = useCallback(() => {
    if (isTranscriptNearBottom()) {
      stickToBottomRef.current = true
      setShowNewTranscript(false)
    } else {
      stickToBottomRef.current = false
    }
  }, [isTranscriptNearBottom])

  const prevHasMoreOlderForExpandRef = useRef(hasMoreOlder)
  useEffect(() => {
    const finishedHistoryRestore =
      session.historyExpanded && prevHasMoreOlderForExpandRef.current && !hasMoreOlder
    prevHasMoreOlderForExpandRef.current = hasMoreOlder
    if (!finishedHistoryRestore || loadingOlder || loading) return
    stickToBottomRef.current = true
    scrollTranscriptToBottom('auto')
    requestAnimationFrame(() => scrollTranscriptToBottom('auto'))
  }, [session.historyExpanded, hasMoreOlder, loadingOlder, loading, scrollTranscriptToBottom])

  const handleContinueSession = async () => {
    const prompt = continuePrompt.trim()
    if (!prompt || continueBusy || continueSendLockRef.current) return
    if (needsEdgeClientForContinue) {
      setContinueError(t('remoteClientRequired'))
      return
    }
    continueSendLockRef.current = true

    const optimisticUser: SessionTranscriptMessage = {
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
      timestamp: new Date().toISOString(),
    }
    setPendingUserMessage(optimisticUser)
    transcriptBaselineRef.current = messages.length
    setContinuePrompt('')
    const elevatedForTurn = continueElevated
    setContinueElevated(false)
    stickToBottomRef.current = true
    setContinueBusy(true)
    setContinueError(null)
    requestAnimationFrame(() => scrollTranscriptToBottom('auto'))
    try {
      if (isGatewaySession) {
        // Gateway sessions: forward message to the agent via chat messages API
        const agentName = session.agent || session.sessionId.split(':')[1] || 'unknown'
        const res = await fetch('/api/chat/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'human',
            to: agentName,
            content: prompt,
            conversation_id: `agent_${agentName}`,
            message_type: 'text',
            forward: true,
            sessionKey: session.sessionKey || undefined,
            ...(elevatedForTurn ? { local_cli_elevated: true } : {}),
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(data?.error || t('failedToSendMessage'))
        }
        const fwd = data?.forward || data?.message?.metadata?.forwardInfo
        if (fwd?.attempted && !fwd?.delivered) {
          setContinueError(t('messageSavedNotDelivered', { reason: fwd.reason || t('reasonUnknown') }))
        }
        stickToBottomRef.current = true
        setBackgroundPromptBusy(true)
        setTimeout(() => onRefreshTranscript({ background: true }), 2000)
      } else {
        if (isRemoteEdgeSession && !session.nodeId) {
          throw new Error(t('remoteClientRequired'))
        }

        const res = await fetch('/api/sessions/continue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: session.sessionKind,
            id: session.sessionId,
            prompt,
            ...(session.nodeId ? { client_id: session.nodeId } : {}),
            ...(session.workingDir ? { working_dir: session.workingDir } : {}),
            ...(elevatedForTurn ? { local_cli_elevated: true } : {}),
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          const code = typeof data?.code === 'string' ? data.code : ''
          if (code === 'bridge_offline') {
            throw new Error(data?.error || t('bridgeOfflineContinue'))
          }
          if (code === 'client_id_required') {
            throw new Error(data?.error || t('remoteClientRequired'))
          }
          throw new Error(data?.error || t('failedToContinueSession'))
        }
        stickToBottomRef.current = true
        setBackgroundPromptBusy(true)
        onRefreshTranscript({ background: true, forceFresh: true })
        window.setTimeout(() => onRefreshTranscript({ background: true, forceFresh: true }), 1200)
        window.setTimeout(() => onRefreshTranscript({ background: true, forceFresh: true }), 3500)
        await tryAutoBindAgentToSession()
      }
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : t('failedToContinueSession'))
      setPendingUserMessage(null)
      setBackgroundPromptBusy(false)
    } finally {
      continueSendLockRef.current = false
      setContinueBusy(false)
    }
  }

  const handleCopySessionId = async () => {
    try {
      await navigator.clipboard.writeText(session.sessionId)
      setCopiedSessionId(true)
      setTimeout(() => setCopiedSessionId(false), 2000)
    } catch {
      setCopiedSessionId(false)
    }
  }

  const updateAgentSessionKey = async (agentName: string, sessionKey: string, options?: { silent?: boolean }) => {
    setBindingBusy(true)
    if (!options?.silent) setBindingMessage(null)
    try {
      const trimmedKey = sessionKey.trim()
      if (trimmedKey) {
        const targetAgent = storeAgents.find((agent) => agent.name === agentName)
        const kindCheck = validateAgentSessionKindBinding(
          String((targetAgent as { framework?: string } | undefined)?.framework || ''),
          session.sessionKind,
        )
        if (!kindCheck.ok) {
          throw new Error(kindCheck.message)
        }
      }

      const res = await fetch('/api/agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: agentName,
          session_key: sessionKey,
          ...(trimmedKey ? { session_kind: session.sessionKind } : {}),
          ...(session.nodeId ? { client_id: session.nodeId } : {}),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || t('sessionBindingFailed'))
      if (!options?.silent) setBindingMessage(t('sessionBindingSaved'))
    } catch (err) {
      if (!options?.silent) {
        setBindingMessage(err instanceof Error ? err.message : t('sessionBindingFailed'))
      }
    } finally {
      setBindingBusy(false)
    }
  }

  const tryAutoBindAgentToSession = useCallback(async () => {
    if (isGatewaySession) return
    const sessionId = session.sessionId
    const unboundLinked = linkedAgents.filter((agent) => !agent.session_key)
    if (unboundLinked.length === 1) {
      await updateAgentSessionKey(unboundLinked[0].name, sessionId, { silent: true })
      await reloadLinkedAgents()
      return
    }
    if (linkedAgents.length > 0) return
    const workingDir = session.workingDir?.trim()
    if (!workingDir) return
    const normalizedDir = workingDir.replace(/\\/g, '/').replace(/\/+$/, '')
    const candidates = storeAgents.filter((agent) => {
      if (agent.session_key) return false
      const agentPath = String((agent as { workspace_path?: string }).workspace_path || '').trim()
      if (!agentPath) return false
      return agentPath.replace(/\\/g, '/').replace(/\/+$/, '') === normalizedDir
    })
    if (candidates.length === 1) {
      await updateAgentSessionKey(candidates[0].name, sessionId, { silent: true })
      await reloadLinkedAgents()
    }
  }, [isGatewaySession, linkedAgents, session.sessionId, session.workingDir, storeAgents, reloadLinkedAgents])

  const handleSavePrefs = async () => {
    if (!session.prefKey || prefBusy) return
    setPrefBusy(true)
    setPrefError(null)
    try {
      await onSavePreferences({
        prefKey: session.prefKey,
        displayName: nameDraft.trim() || undefined,
        colorTag: colorDraft || undefined,
      })
    } catch (err) {
      setPrefError(err instanceof Error ? err.message : t('failedToSavePreferences'))
    } finally {
      setPrefBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Compact session info bar */}
      <div className="border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          {!isGatewaySession && (
            <SessionKindAvatar
              kind={session.sessionKind}
              fallback={getSessionKindLabel(session.sessionKind).slice(0, 1)}
              sizeClassName="w-5 h-5"
            />
          )}
          <span className={`rounded-full px-2 py-0.5 text-[10px] ${session.active ? 'bg-green-500/20 text-green-300' : 'bg-muted text-muted-foreground'}`}>
            {session.active ? t('sessionActive') : t('sessionIdle')}
          </span>
          <span className="font-mono-tight">{getSessionKindLabel(session.sessionKind)}</span>
          {session.model && session.model.toLowerCase() !== 'unknown' && (
            <span className="text-muted-foreground/60">{session.model}</span>
          )}
          {session.tokens && <span className="text-muted-foreground/60">{session.tokens}</span>}
          {session.workingDir && <span className="hidden truncate text-muted-foreground/50 sm:inline max-w-[200px]">{session.workingDir}</span>}
          {session.age && <span className="text-muted-foreground/40">{t('ageAgo', { age: session.age })}</span>}
        </div>

        {/* Collapsible settings */}
        {!isGatewaySession && (
          <details className="mt-2">
            <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-muted-foreground/60 hover:text-muted-foreground/80">
              {t('sessionSettings')}
            </summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_120px_auto]">
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder={t('renameSession')}
                maxLength={80}
                className="h-7 rounded border border-border/60 bg-surface-1 px-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
              <select
                value={colorDraft}
                onChange={(e) => setColorDraft(e.target.value)}
                className="h-7 rounded border border-border/60 bg-surface-1 px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
              >
                <option value="">{t('noColor')}</option>
                <option value="slate">{t('colorSlate')}</option>
                <option value="blue">{t('colorBlue')}</option>
                <option value="green">{t('colorGreen')}</option>
                <option value="amber">{t('colorAmber')}</option>
                <option value="red">{t('colorRed')}</option>
                <option value="purple">{t('colorPurple')}</option>
                <option value="pink">{t('colorPink')}</option>
                <option value="teal">{t('colorTeal')}</option>
              </select>
              <Button
                onClick={handleSavePrefs}
                size="sm"
                variant="outline"
                disabled={prefBusy || !session.prefKey || !hasPrefChanges}
                className="h-7 px-3 text-xs"
              >
                {prefBusy ? t('saving') : t('save')}
              </Button>
            </div>
            {prefError && <div className="mt-2 text-xs text-red-400">{prefError}</div>}
          </details>
        )}

        {!isGatewaySession && (
          <details className="mt-2">
            <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-muted-foreground/60 hover:text-muted-foreground/80">
              {t('sessionBindingTitle')}
            </summary>
            <div className="mt-2 space-y-2 rounded-md border border-border/40 bg-surface-1/40 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">{t('sessionIdLabel')}</span>
                <code className="min-w-0 flex-1 truncate rounded bg-surface-0 px-2 py-1 text-[11px] text-foreground">{session.sessionId}</code>
                <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => void handleCopySessionId()}>
                  {copiedSessionId ? t('copied') : t('copySessionId')}
                </Button>
              </div>
              {session.sessionKey && session.sessionKey !== session.sessionId && (
                <div className="text-[11px] text-muted-foreground">
                  <span className="text-muted-foreground/60">{t('sessionKeyLabel')}: </span>
                  <span className="font-mono text-foreground/80">{session.sessionKey}</span>
                </div>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">{t('sessionKeyHintChat')}</p>
              {linkedAgents.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/60">{t('noLinkedAgents')}</p>
                  {bindableAgents.length > 0 ? (
                    <div className="flex flex-wrap items-end gap-1.5">
                      <label className="flex flex-col gap-1 text-[10px] text-muted-foreground/60">
                        {t('bindAgentLabel')}
                        <select
                          value={bindAgentName}
                          onChange={(e) => setBindAgentName(e.target.value)}
                          className="h-7 min-w-[140px] rounded border border-border/60 bg-background px-2 text-[11px] text-foreground"
                        >
                          <option value="">{t('bindAgentPlaceholder')}</option>
                          {bindableAgents.map((a) => (
                            <option key={a.id} value={a.name}>{a.name}</option>
                          ))}
                        </select>
                      </label>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        disabled={bindingBusy || !bindAgentName}
                        onClick={() => void updateAgentSessionKey(bindAgentName, session.sessionId)}
                      >
                        {t('bindAgentAction')}
                      </Button>
                    </div>
                  ) : storeAgents.length > 0 ? (
                    <p className="text-[11px] text-amber-200/80">{t('noCompatibleAgentsForSession', { kind: getSessionKindLabel(session.sessionKind) })}</p>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground/50">{t('linkedAgents')}</p>
                  {linkedAgents.map((agent) => (
                    <div key={agent.id} className="space-y-1.5 rounded border border-border/30 bg-surface-0/50 p-2">
                      <div className="text-xs font-medium text-foreground">{agent.name}</div>
                      <div className="flex flex-wrap gap-1.5">
                        <input
                          value={bindingDraft[agent.id] ?? ''}
                          onChange={(e) => setBindingDraft((prev) => ({ ...prev, [agent.id]: e.target.value }))}
                          className="h-7 min-w-0 flex-1 rounded border border-border/60 bg-background px-2 text-[11px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[11px]"
                          disabled={bindingBusy}
                          onClick={() => setBindingDraft((prev) => ({ ...prev, [agent.id]: session.sessionId }))}
                        >
                          {t('useCurrentSessionId')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-[11px]"
                          disabled={bindingBusy}
                          onClick={() => void updateAgentSessionKey(agent.name, '')}
                        >
                          {t('clearAgentSessionBinding')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          disabled={bindingBusy}
                          onClick={() => void updateAgentSessionKey(agent.name, (bindingDraft[agent.id] ?? '').trim())}
                        >
                          {bindingBusy ? t('saving') : t('saveAgentSessionBinding')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {bindingMessage && <p className="text-[11px] text-primary/80">{bindingMessage}</p>}
            </div>
          </details>
        )}
      </div>

      {/* Transcript */}
      <div
        ref={transcriptScrollRef}
        onScroll={handleTranscriptScroll}
        className="relative flex-1 overflow-y-auto font-mono-tight py-2"
      >
        {loading && messages.length === 0 && (
          <div className="space-y-2 px-4">
            <div className="h-4 w-3/4 animate-pulse rounded bg-surface-1/60" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-surface-1/60" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface-1/60" />
            <div className="text-xs text-muted-foreground/50">{t('loadingTranscript')}</div>
          </div>
        )}
        {!loading && error && (
          <div className="px-4 text-xs text-red-400">{error}</div>
        )}
        {!loading && !error && displayMessages.length === 0 && (
          <div className="px-4 text-xs text-muted-foreground">
            {isGatewaySession ? t('noGatewayMessages') : t('noTranscriptSnippets')}
          </div>
        )}
        {!error && displayMessages.length > 0 && (
          <div className="space-y-0">
            {hasMoreOlder && (
              <div className="flex justify-center px-4 py-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 px-3 text-xs"
                  disabled={loadingOlder}
                  onClick={onLoadOlder}
                >
                  {loadingOlder ? t('loadingOlderMessages') : t('loadOlderMessages')}
                </Button>
              </div>
            )}
            {session.sessionKind === 'codex-cli' && (
              <p className="px-4 pb-2 text-[10px] leading-relaxed text-muted-foreground/70">
                {t('transcriptSyncHint')}
              </p>
            )}
            {displayMessages.map((msg, idx) => (
              <SessionMessage
                key={`${msg.timestamp || 'no-ts'}-${idx}`}
                message={msg}
                showTimestamp={shouldShowTimestamp(msg, displayMessages[idx - 1])}
                pending={
                  Boolean(pendingUserMessage)
                  && idx === displayMessages.length - 1
                  && msg.role === 'user'
                }
              />
            ))}
            {replyProgressUi.mode !== 'hidden' && replyProgressUi.progress && (
              <SessionReplyStatusRow
                label={
                  replyProgressUi.mode === 'waiting'
                    ? waitingProgressText
                    : continuingProgressText
                }
                phase={replyProgressUi.progress.phase}
                variant={replyProgressUi.mode === 'waiting' ? 'waiting' : 'continuing'}
                showTimestamp={false}
              />
            )}
            <div ref={transcriptBottomRef} className="h-px" />
          </div>
        )}
        {showNewTranscript && (
          <div className="pointer-events-none sticky bottom-2 flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="pointer-events-auto h-7 px-3 text-xs shadow-md"
              onClick={() => {
                scrollTranscriptToBottom('smooth')
                setShowNewTranscript(false)
              }}
            >
              {t('newMessages')}
            </Button>
          </div>
        )}
      </div>

      {/* Continue session input */}
      <div className="border-t border-border/50 px-4 py-2">
        {needsEdgeClientForContinue && (
          <p className="mb-1.5 text-[10px] leading-relaxed text-amber-400/90">
            {t('remoteClientRequired')}
          </p>
        )}
        {isRemoteEdgeSession && session.workingDir && !needsEdgeClientForContinue && (
          <p className="mb-1.5 text-[10px] leading-relaxed text-amber-400/90">
            {t('remoteContinueHint', { dir: session.workingDir })}
          </p>
        )}
        <div className="flex items-center gap-2">
          <span className={`font-mono-tight text-xs ${isGatewaySession ? 'text-cyan-400/60' : 'text-green-400/60'}`}>{isGatewaySession ? '>' : '$'}</span>
          <input
            value={continuePrompt}
            onChange={(e) => setContinuePrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !continueBusy) {
                e.preventDefault()
                void handleContinueSession()
              }
            }}
            placeholder={
              needsEdgeClientForContinue
                ? t('remoteClientRequired')
                : continueBusy
                  ? t('continueSending')
                : isGatewaySession
                  ? t('sendMessageToSession')
                  : t('sendPromptToLocalSession')
            }
            disabled={needsEdgeClientForContinue || continueBusy}
            className="h-7 flex-1 rounded border border-border/40 bg-surface-1 px-2 font-mono-tight text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {!isGatewaySession && (
            <LocalCliElevationButton
              elevated={continueElevated}
              onElevatedChange={setContinueElevated}
              disabled={needsEdgeClientForContinue || continueBusy}
              size="sm"
            />
          )}
          <Button
            onClick={handleContinueSession}
            size="sm"
            variant="ghost"
            disabled={continueBusy || !continuePrompt.trim() || needsEdgeClientForContinue}
            className="h-7 px-3 text-xs"
          >
            {continueBusy
              ? `${t('continueSending')}${awaitingReplySeconds > 0 ? ` (${awaitingReplySeconds}s)` : ''}`
              : t('send')}
          </Button>
        </div>
        {continueError && <div className="mt-1 text-xs text-red-400">{continueError}</div>}
      </div>
    </div>
  )
}

/** Inline toast indicators for compaction and model fallback events */
function ChatIndicators({ notifications, compactionLabel, fallbackLabel }: { notifications: Array<{ id: number; type: string; title: string; message: string; created_at: number }>; compactionLabel: string; fallbackLabel: string }) {
  const TOAST_DURATION_MS = 8000
  const now = Math.floor(Date.now() / 1000)

  // Show recent compaction/fallback notifications as inline toasts
  const recentToasts = notifications.filter(n => {
    const age = now - n.created_at
    if (age > TOAST_DURATION_MS / 1000) return false
    return n.title === 'Context Compaction' || n.title === 'Model Fallback'
  }).slice(0, 3)

  if (recentToasts.length === 0) return null

  return (
    <div className="flex flex-col gap-1 px-4 py-1 flex-shrink-0">
      {recentToasts.map(toast => {
        const isCompaction = toast.title === 'Context Compaction'
        const isFallback = toast.title === 'Model Fallback'
        return (
          <div
            key={toast.id}
            className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-[11px] animate-in fade-in slide-in-from-bottom-1 ${
              isCompaction
                ? 'bg-blue-500/10 text-blue-300 border border-blue-500/20'
                : isFallback
                ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                : 'bg-surface-1 text-muted-foreground border border-border/30'
            }`}
          >
            <span className="font-medium">{isCompaction ? compactionLabel : isFallback ? fallbackLabel : toast.title}</span>
            <span className="text-current/70 truncate">{toast.message}</span>
          </div>
        )
      })}
    </div>
  )
}

function AgentAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const colors: Record<string, string> = {
    coordinator: 'bg-purple-500/20 text-purple-400',
    aegis: 'bg-red-500/20 text-red-400',
    research: 'bg-green-500/20 text-green-400',
    ops: 'bg-orange-500/20 text-orange-400',
    reviewer: 'bg-teal-500/20 text-teal-400',
    content: 'bg-indigo-500/20 text-indigo-400',
    human: 'bg-primary/20 text-primary',
  }

  const colorClass = colors[name.toLowerCase()] || 'bg-muted text-muted-foreground'
  const sizeClass = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-8 h-8 text-xs'

  return (
    <div className={`${sizeClass} ${colorClass} flex flex-shrink-0 items-center justify-center rounded-full font-bold`}>
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

function getConversationStatus(agents: Array<{ name: string; status: string }>, conversationId: string, labels: {
  localClaude: string
  localCodex: string
  localHermes: string
  gateway: string
  unknown: string
  online: string
  offline: string
}): string {
  if (conversationId.startsWith('session:')) {
    if (conversationId.includes('claude-code')) return labels.localClaude
    if (conversationId.includes('codex-cli')) return labels.localCodex
    if (conversationId.includes('hermes')) return labels.localHermes
    return labels.gateway
  }
  const name = conversationId.replace('agent_', '')
  const agent = agents.find(a => a.name.toLowerCase() === name.toLowerCase())
  if (!agent) return labels.unknown
  return agent.status === 'idle' || agent.status === 'busy' ? labels.online : labels.offline
}

function getUserTextFromTranscriptMessage(message: SessionTranscriptMessage): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function promptMatchVariants(prompt: string): string[] {
  const target = prompt.trim()
  if (!target) return []
  const variants = new Set<string>([target])
  const stripped = target.match(/^Message from .+?:\s*([\s\S]+)$/i)?.[1]?.trim()
  if (stripped) variants.add(stripped)
  return [...variants]
}

function transcriptHasUserPrompt(messages: SessionTranscriptMessage[], prompt: string): boolean {
  const variants = promptMatchVariants(prompt)
  if (variants.length === 0) return false
  const start = Math.max(0, messages.length - 6)
  for (let i = messages.length - 1; i >= start; i--) {
    const msg = messages[i]
    if (msg.role !== 'user') continue
    const text = getUserTextFromTranscriptMessage(msg)
    if (variants.some((variant) => text === variant || text.includes(variant))) return true
  }
  return false
}

function shouldRefreshSelectedSession(
  session: NonNullable<Conversation['session']>,
  detail?: SessionRealtimePayload
): boolean {
  if (!detail) return true

  if (detail.sessionKind && detail.sessionKind !== session.sessionKind) return false

  const inferredKind = sessionKindFromSource(detail.source)
  if (!detail.sessionKind && inferredKind && inferredKind !== session.sessionKind) return false

  if (detail.sessionKey && session.sessionKey && detail.sessionKey !== session.sessionKey) return false

  // Gateway and Codex session IDs are stable enough to filter precisely.
  if (
    (detail.source === 'gateway' || detail.source === 'codex' || detail.source === 'claude')
    && detail.sessionId
    && detail.sessionId !== session.sessionId
  ) {
    return false
  }

  return true
}
