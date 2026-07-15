import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { proxySupervisionWorkerRequest } from '@/lib/supervision-worker-proxy'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { id } = await params
  const result = await proxySupervisionWorkerRequest(`/api/supervision/worker-goals/${encodeURIComponent(id)}`)
  return NextResponse.json(result.body, { status: result.status })
}
