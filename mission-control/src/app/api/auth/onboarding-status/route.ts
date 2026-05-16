import { NextRequest, NextResponse } from 'next/server'
import { fetchUsercenterOnboardingStatus } from '@/lib/usercenter-tenant-gateway'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const subject = String(request.nextUrl.searchParams.get('subject') || '').trim()
  if (!subject) {
    return NextResponse.json({ error: 'subject 必填' }, { status: 400 })
  }
  try {
    const status = await fetchUsercenterOnboardingStatus(subject)
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}
