import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getPermissionRequest, waitForPermissionRequestDecision } from '@/lib/permission-requests'

export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id } = await context.params
  const requestId = String(id || '').trim()
  if (!requestId) return NextResponse.json({ error: 'request id is required' }, { status: 400 })

  const workspaceId = auth.user.workspace_id ?? 1
  const wait = request.nextUrl.searchParams.get('wait') === '1'
  const timeoutRaw = request.nextUrl.searchParams.get('timeout_ms')
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined
  if (timeoutRaw && (!Number.isFinite(timeoutMs) || timeoutMs! < 1000)) {
    return NextResponse.json({ error: 'Invalid timeout_ms' }, { status: 400 })
  }

  try {
    const result = wait
      ? await waitForPermissionRequestDecision({ requestId, workspaceId, timeoutMs })
      : getPermissionRequest(requestId, workspaceId)
    if (!result) return NextResponse.json({ error: 'Permission request not found' }, { status: 404 })
    return NextResponse.json({ request: result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read permission request'
    const status = message.includes('not found') ? 404 : message.includes('Timed out') ? 504 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
