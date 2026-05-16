import { NextRequest, NextResponse } from 'next/server'
import { config } from '@/lib/config'

export const dynamic = 'force-dynamic'

function inferOrigin(request: NextRequest): string {
  const forwardedProto = request.headers.get('x-forwarded-proto')
  const forwardedHost = request.headers.get('x-forwarded-host')
  const host = forwardedHost || request.headers.get('host') || 'localhost:5000'
  const proto = forwardedProto || (host.includes('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
  return `${proto}://${host}`
}

function toBridgeWsUrl(origin: string, port: number): string {
  try {
    const url = new URL(origin)
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${url.hostname}:${port}`
  } catch {
    return `ws://127.0.0.1:${port}`
  }
}

export async function GET(request: NextRequest) {
  const origin = inferOrigin(request)
  const bridgePort = 5002

  return NextResponse.json({
    service: {
      origin,
      http_base_url: origin,
      api_index_url: `${origin}/api/index`,
    },
    bridge: {
      enabled: true,
      port: bridgePort,
      ws_url: toBridgeWsUrl(origin, bridgePort),
      protocol: 'websocket',
      note: 'Bridge WebSocket for edge/local E-Agent-Center nodes. This is distinct from the OpenClaw gateway websocket.',
    },
    gateway: {
      host: config.gatewayHost,
      port: config.gatewayPort,
      http_base_url: `http://${config.gatewayHost}:${config.gatewayPort}`,
      note: 'OpenClaw gateway endpoint used by E-Agent-Center for orchestration and session control.',
    },
    sync_endpoints: {
      agents_register: `${origin}/api/agents/register`,
      tasks_queue: `${origin}/api/tasks/queue`,
      chat_sync: `${origin}/api/chat/sync`,
      settings_sync: `${origin}/api/settings/sync`,
    },
  })
}
