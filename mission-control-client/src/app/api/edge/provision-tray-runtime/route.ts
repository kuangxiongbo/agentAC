import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { APP_VERSION } from '@/lib/version'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function isLoopback(request: NextRequest): boolean {
  const forwarded = (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim()
  const host = forwarded || request.headers.get('x-real-ip') || ''
  if (!host) return true
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await readFile(path.join(p, 'server.js'))
    return true
  } catch {
    return false
  }
}

async function resolveStandaloneDir(): Promise<string | null> {
  const cwd = process.cwd()
  if (await pathExists(cwd)) return cwd

  const fromEnv = (process.env.MC_STANDALONE_DIR || process.env.MISSION_CONTROL_STANDALONE_DIR || '').trim()
  if (fromEnv && (await pathExists(fromEnv))) return fromEnv

  const nested = path.join(cwd, '.next', 'standalone')
  if (await pathExists(nested)) return nested

  return null
}

async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true, force: true })
}

/**
 * POST /api/edge/provision-tray-runtime — Copy this client's standalone bundle to ~/.e-agent-edge/runtime
 * (loopback only). Bypasses center runtime zip download when 5101 is already running.
 */
export async function POST(request: NextRequest) {
  if (!isLoopback(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const standalone = await resolveStandaloneDir()
  if (!standalone) {
    return NextResponse.json(
      { error: 'Cannot find standalone server.js (cwd or .next/standalone)' },
      { status: 503 },
    )
  }

  const home = process.env.HOME || process.env.USERPROFILE || ''
  const trayRuntime = path.join(home, '.e-agent-edge', 'runtime')
  const version = APP_VERSION || '2.0.2'

  try {
    await mkdir(path.dirname(trayRuntime), { recursive: true })
    await copyTree(standalone, trayRuntime)

    const projectRoot = standalone.includes(`${path.sep}.next${path.sep}standalone`)
      ? path.resolve(standalone, '..', '..')
      : path.resolve(standalone, '..')
    const staticSrc = path.join(projectRoot, '.next', 'static')
    const publicSrc = path.join(projectRoot, 'public')
    const staticDest = path.join(trayRuntime, '.next', 'static')
    const publicDest = path.join(trayRuntime, 'public')

    try {
      await mkdir(path.join(trayRuntime, '.next'), { recursive: true })
      await copyTree(staticSrc, staticDest)
    } catch {
      // optional
    }
    try {
      await copyTree(publicSrc, publicDest)
    } catch {
      // optional
    }

    await writeFile(path.join(trayRuntime, 'VERSION'), `${version}\n`, 'utf8')

    return NextResponse.json({
      ok: true,
      version,
      source: standalone,
      dest: trayRuntime,
      via: 'web-client-standalone-copy',
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
