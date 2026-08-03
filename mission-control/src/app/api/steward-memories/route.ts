import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  createStewardMemory,
  listStewardMemories,
  type StewardMemoryCategory,
  type StewardMemoryScope,
  type StewardMemoryStatus,
} from '@/lib/steward-memories'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const params = request.nextUrl.searchParams
  const result = listStewardMemories({
    workspaceId: auth.user.workspace_id ?? 1,
    tenantId: auth.user.tenant_id ?? undefined,
    status: params.get('status') as StewardMemoryStatus || undefined,
    category: params.get('category') as StewardMemoryCategory || undefined,
    scopeType: params.get('scope_type') as StewardMemoryScope || undefined,
    scopeId: params.get('scope_id') || undefined,
    limit: Number(params.get('limit')) || undefined,
    offset: Number(params.get('offset')) || undefined,
  })
  return NextResponse.json(result)
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck
  try {
    const body = await request.json()
    const memory = createStewardMemory({
      workspaceId: auth.user.workspace_id ?? 1,
      tenantId: auth.user.tenant_id ?? undefined,
      scopeType: body.scope_type,
      scopeId: String(body.scope_id || ''),
      category: body.category,
      content: String(body.content || ''),
      summary: typeof body.summary === 'string' ? body.summary : null,
      sourceRefs: Array.isArray(body.source_refs) ? body.source_refs : [],
      evidence: Array.isArray(body.evidence) ? body.evidence : [],
      confidence: body.confidence == null ? undefined : Number(body.confidence),
      status: body.status,
      supersedesId: typeof body.supersedes_id === 'string' ? body.supersedes_id : null,
      effectiveAt: Number.isFinite(Number(body.effective_at)) ? Number(body.effective_at) : null,
      expiresAt: body.expires_at == null ? null : Number(body.expires_at),
      createdByType: 'human_user',
    })
    return NextResponse.json({ memory }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to create memory' }, { status: 400 })
  }
}
