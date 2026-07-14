import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { searchStewardMemories } from '@/lib/steward-memory-search'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  try {
    const body = await request.json()
    return NextResponse.json(searchStewardMemories({
      workspaceId: auth.user.workspace_id ?? 1,
      tenantId: auth.user.tenant_id ?? undefined,
      query: String(body.query || ''),
      goalId: typeof body.goal_id === 'string' ? body.goal_id : null,
      projectIds: Array.isArray(body.project_ids) ? body.project_ids.map(Number).filter(Number.isFinite) : [],
      userId: typeof body.user_id === 'string' ? body.user_id : String(auth.user.id),
      stewardId: Number.isFinite(Number(body.steward_id)) ? Number(body.steward_id) : null,
      clientId: typeof body.client_id === 'string' ? body.client_id : null,
      categories: Array.isArray(body.categories) ? body.categories : undefined,
      limit: Number(body.limit) || undefined,
      maxChars: Number(body.max_chars) || undefined,
    }))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Memory search failed' }, { status: 400 })
  }
}
