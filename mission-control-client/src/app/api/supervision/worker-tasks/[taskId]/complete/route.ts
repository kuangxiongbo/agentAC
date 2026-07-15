import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import { proxySupervisionWorkerRequest } from '@/lib/supervision-worker-proxy'

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck
  const { taskId } = await params
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const result = await proxySupervisionWorkerRequest(
    `/api/supervision/worker-tasks/${encodeURIComponent(taskId)}/complete`,
    { method: 'POST', body: JSON.stringify(body) },
  )
  return NextResponse.json(result.body, { status: result.status })
}
