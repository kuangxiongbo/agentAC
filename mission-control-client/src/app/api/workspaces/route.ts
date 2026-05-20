import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { mutationLimiter } from '@/lib/rate-limit'
import {
  createAgentWorkspace,
  deleteAgentWorkspace,
  listAgentWorkspaces,
  updateAgentWorkspace,
  countAgentsByWorkspacePath,
} from '@/lib/agent-workspaces'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const agentCounts = countAgentsByWorkspacePath()
    const workspaces = listAgentWorkspaces().map((ws) => ({
      ...ws,
      agentCount: agentCounts[ws.path] ?? 0,
    }))
    return NextResponse.json({ workspaces })
  } catch (error) {
    return NextResponse.json({ error: 'Failed to list workspaces' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const body = await request.json()
    const { workspace, directoryCreated } = createAgentWorkspace({
      name: body.name,
      path: body.path,
      description: body.description,
      isDefault: body.isDefault,
      createIfMissing: body.createIfMissing,
    })
    return NextResponse.json({ workspace, directoryCreated }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message || 'Failed to create workspace' }, { status: 400 })
  }
}

export async function PUT(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const body = await request.json()
    const id = String(body.id || '').trim()
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const { workspace, directoryCreated } = updateAgentWorkspace(id, {
      name: body.name,
      path: body.path,
      description: body.description,
      isDefault: body.isDefault,
      createIfMissing: body.createIfMissing,
    })
    return NextResponse.json({ workspace, directoryCreated })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message || 'Failed to update workspace' }, { status: 400 })
  }
}

export async function DELETE(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  const id = request.nextUrl.searchParams.get('id')?.trim()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  try {
    deleteAgentWorkspace(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message || 'Failed to delete workspace' }, { status: 400 })
  }
}
