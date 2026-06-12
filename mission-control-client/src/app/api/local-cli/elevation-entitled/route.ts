import { NextResponse } from 'next/server'
import { resolveLocalCliElevationEntitled } from '@/lib/local-cli-elevation-auth'

export async function GET() {
  return NextResponse.json(await resolveLocalCliElevationEntitled())
}

export const dynamic = 'force-dynamic'
