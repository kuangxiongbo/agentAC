import { NextRequest, NextResponse } from 'next/server'
import { triggerTask } from '@/lib/scheduler'
import { requireRole } from '@/lib/auth'

/**
 * POST /api/scheduler/trigger
 * Body: { taskId: string }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'admin')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const { taskId } = await request.json()
    if (!taskId) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
    }

    const result = await triggerTask(taskId)
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json({ error: 'Failed to trigger task' }, { status: 500 })
  }
}
