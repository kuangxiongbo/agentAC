import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function isUpstreamTlsError(err: unknown): boolean {
  const parts: string[] = []
  let cur: unknown = err
  for (let i = 0; i < 6 && cur; i++) {
    if (cur instanceof Error) {
      parts.push(cur.message)
      if (cur.cause) {
        cur = cur.cause
        continue
      }
    } else {
      parts.push(String(cur))
    }
    break
  }
  const combined = parts.join(' ')
  return /self[- ]signed certificate|unable to verify|certificate.*chain|UNABLE_TO_VERIFY|certificate problem/i.test(
    combined,
  )
}

function isLikelyTlsFetchError(err: unknown): boolean {
  if (isUpstreamTlsError(err)) return true
  const msg = err instanceof Error ? err.message : String(err)
  return msg === 'fetch failed' || /fetch failed/i.test(msg)
}

/** Tray ~/.e-agent-edge/config.json — same flag the edge tray uses for HTTPS. */
function readTrayTlsInsecure(): boolean {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (!home) return false
    const raw = readFileSync(path.join(home, '.e-agent-edge', 'config.json'), 'utf8')
    const parsed = JSON.parse(raw) as { tls_insecure?: boolean | string }
    return parsed.tls_insecure === true || parsed.tls_insecure === 'true'
  } catch {
    return false
  }
}

/** Whether edge/center HTTPS and WSS should skip TLS verification. */
export function isEdgeTlsInsecure(): boolean {
  return (
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    process.env.MC_EDGE_TLS_INSECURE === '1' ||
    readTrayTlsInsecure()
  )
}

async function fetchWithTlsBypass(url: string, init?: RequestInit): Promise<Response> {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  try {
    return await fetch(url, init)
  } finally {
    if (prev === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev
    }
  }
}

/** Fetch center upstream; honors env, tray config tls_insecure, or TLS error retry. */
export async function edgeUpstreamFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isEdgeTlsInsecure()) {
    return fetchWithTlsBypass(url, init)
  }
  try {
    return await fetch(url, init)
  } catch (e) {
    if (isLikelyTlsFetchError(e)) {
      return fetchWithTlsBypass(url, init)
    }
    throw e
  }
}

export function formatUpstreamFetchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (isUpstreamTlsError(err) || isLikelyTlsFetchError(err)) {
    return `${message}（上游 HTTPS 证书校验失败：托盘 config 设 tls_insecure:true，或在 .env.local 设 NODE_TLS_REJECT_UNAUTHORIZED=0 / MC_EDGE_TLS_INSECURE=1 后重启 5101）`
  }
  return message
}
