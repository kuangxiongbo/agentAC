import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { listSyncedSkillsByClient, replaceSyncedSkills, type SyncedSkillRecord } from '@/lib/sync-skills'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  return NextResponse.json({ clients: listSyncedSkillsByClient() })
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const clientId = typeof body?.client_id === 'string' ? body.client_id.trim() : ''
  const clientName = typeof body?.client_name === 'string' ? body.client_name.trim() : ''
  const skills = Array.isArray(body?.skills) ? body.skills as SyncedSkillRecord[] : null

  if (!clientId || !clientName || !skills) {
    return NextResponse.json({ error: 'client_id, client_name, and skills are required' }, { status: 400 })
  }

  replaceSyncedSkills(clientId, clientName, skills)
  return NextResponse.json({ ok: true, synced: skills.length })
}
