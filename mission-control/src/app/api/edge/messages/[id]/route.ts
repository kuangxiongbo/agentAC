import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getEdgeMessage, listEdgeMessageEvents } from '@/lib/edge-messages'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(_request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id } = await params
  const message = getEdgeMessage(id)
  if (!message || message.workspace_id !== (auth.user.workspace_id ?? 1)) {
    return NextResponse.json({ error: 'Edge message not found' }, { status: 404 })
  }
  return NextResponse.json({ message, events: listEdgeMessageEvents(id) })
}

