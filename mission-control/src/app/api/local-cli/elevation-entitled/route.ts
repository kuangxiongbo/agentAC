import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { resolveLocalCliElevationEntitled } from '@/lib/local-cli-elevation-auth'

export async function GET(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const result = await resolveLocalCliElevationEntitled({ user: auth.user })
  return NextResponse.json(result)
}

export const dynamic = 'force-dynamic'
