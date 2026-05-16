import { NextRequest, NextResponse } from 'next/server'
import { getBridgeServerStatus } from '@/lib/bridge-server'
import { requireRole } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/bridge/clients - List all connected bridge clients
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const status = getBridgeServerStatus()
  
  // Deduplicate clients by clientId (keeping the most recent connection)
  const uniqueClients = new Map<string, any>()
  for (const client of status.clients) {
    if (!uniqueClients.has(client.clientId)) {
      uniqueClients.set(client.clientId, {
        id: client.clientId,
        name: client.clientLabel || client.clientId,
        status: client.status,
        connectedAt: client.connectedAt,
        agentCount: client.agentCount,
      })
    }
  }

  return NextResponse.json({ 
    clients: Array.from(uniqueClients.values())
  })
}
