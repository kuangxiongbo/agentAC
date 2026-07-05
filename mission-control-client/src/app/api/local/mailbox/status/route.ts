import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getLocalMailboxStatus } from '@/lib/local-mailbox'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  return NextResponse.json(getLocalMailboxStatus())
}

