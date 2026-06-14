import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getBridgeServerStatus } from '@/lib/bridge-server'
import { getRemoteBridgeStatus } from '@/lib/remote-server-bridge'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type HealthLevel = 'ok' | 'degraded' | 'down'

function computeHealth(downstream: ReturnType<typeof getBridgeServerStatus>, upstream: ReturnType<typeof getRemoteBridgeStatus>): HealthLevel {
  // Upstream is optional (edge clients don't connect up)
  const upstreamIssue = upstream.enabled && !upstream.connected

  const staleClients = downstream.health.filter(
    (c) => c.status === 'connected' && c.pongSilenceMs > 90_000,
  ).length

  if (!downstream.running) return 'down'
  if (upstreamIssue && upstream.reconnectAttempts > 3) return 'degraded'
  if (staleClients > 0 || downstream.pendingRequests > 20) return 'degraded'
  return 'ok'
}

/**
 * GET /api/bridge/health
 *
 * Returns a combined health snapshot of:
 *   upstream  — this node's outbound WebSocket connection to a parent server
 *   downstream — inbound WebSocket connections from edge clients
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const downstream = getBridgeServerStatus()
  const upstream = getRemoteBridgeStatus()
  const health = computeHealth(downstream, upstream)

  return NextResponse.json({
    health,
    timestamp: Date.now(),

    upstream: {
      enabled: upstream.enabled,
      connected: upstream.connected,
      url: upstream.url,
      configuredUrl: upstream.configuredUrl,
      discoverySource: upstream.discoverySource,
      reconnectAttempts: upstream.reconnectAttempts,
      connectedAt: upstream.connectedAt,
      connectedDurationMs: upstream.connectedDurationMs,
      pongSilenceMs: upstream.pongSilenceMs,
      lastPong: upstream.lastPong,
      totalReconnects: upstream.totalReconnects,
      lastError: upstream.lastError,
      lastErrorAt: upstream.lastErrorAt,
      metrics: {
        sent: upstream.totalMessagesSent,
        received: upstream.totalMessagesReceived,
      },
    },

    downstream: {
      running: downstream.running,
      port: downstream.port,
      startedAt: downstream.startedAt,
      uptimeMs: downstream.uptimeMs,
      connectedClients: downstream.connectedClients,
      pendingRequests: downstream.pendingRequests,
      metrics: downstream.metrics,
      clients: downstream.health.map((c) => ({
        clientId: c.clientId,
        clientLabel: c.clientLabel,
        kind: c.kind,
        status: c.status,
        connectedAt: c.connectedAt,
        lastSeenAt: c.lastSeenAt,
        lastPongAt: c.lastPongAt,
        pongSilenceMs: c.pongSilenceMs,
        pongHealth: c.pongSilenceMs < 45_000 ? 'ok' : c.pongSilenceMs < 90_000 ? 'warn' : 'stale',
        agentCount: c.agentCount,
        capabilities: c.capabilities,
        remoteAddress: c.remoteAddress,
      })),
    },
  })
}
