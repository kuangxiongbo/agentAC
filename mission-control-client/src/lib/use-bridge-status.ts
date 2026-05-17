'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

export type BridgeStatus = {
  enabled: boolean
  connected: boolean
  url: string
  configuredUrl: string
  discoverySource: string | null
  reconnectAttempts: number
  lastPong: number
}

export type BridgeConnectionState = 'unconfigured' | 'connected' | 'reconnecting' | 'disconnected' | 'loading'

const DEFAULT_POLL_MS = 4000

export function extractBridgeHost(url: string): string {
  if (!url) return '—'
  try {
    const parsed = new URL(url.replace(/^ws/i, 'http'))
    return parsed.host
  } catch {
    return url.replace(/^wss?:\/\//, '').split('/')[0] || url
  }
}

export function resolveBridgeState(bridge: BridgeStatus | null, loading: boolean): BridgeConnectionState {
  if (loading && !bridge) return 'loading'
  if (!bridge?.enabled) return 'unconfigured'
  if (bridge.connected) return 'connected'
  if (bridge.reconnectAttempts > 0) return 'reconnecting'
  return 'disconnected'
}

export function useBridgeStatus(pollMs = DEFAULT_POLL_MS, enabled = true) {
  const [bridge, setBridge] = useState<BridgeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [reconnecting, setReconnecting] = useState(false)

  const fetchBridge = useCallback(async () => {
    try {
      const res = await fetch('/api/server-bridge', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      if (data?.bridge) setBridge(data.bridge as BridgeStatus)
    } catch {
      // keep last known state
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    void fetchBridge()
    const id = setInterval(() => void fetchBridge(), pollMs)
    return () => clearInterval(id)
  }, [fetchBridge, pollMs, enabled])

  const reconnect = useCallback(async () => {
    setReconnecting(true)
    try {
      await fetch('/api/server-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reconnect' }),
      })
      await fetchBridge()
    } finally {
      setReconnecting(false)
    }
  }, [fetchBridge])

  const state = useMemo(() => resolveBridgeState(bridge, loading), [bridge, loading])
  const host = extractBridgeHost(bridge?.url || bridge?.configuredUrl || '')

  return { bridge, loading, reconnecting, state, host, refresh: fetchBridge, reconnect }
}
