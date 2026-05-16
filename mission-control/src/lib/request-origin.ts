import type { NextRequest } from 'next/server'

/** 以浏览器实际访问的 Host 为准构造 origin，避免 Next 内部把 `request.url` 规范成 localhost 而 127.0.0.1 回调写 Cookie 后跳转到另一主机。 */
export function resolveRequestOrigin(request: NextRequest): string {
  const host = (
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    request.nextUrl.host
  )
    .split(',')[0]
    ?.trim()
  if (!host) return request.nextUrl.origin

  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const proto =
    forwardedProto || (request.nextUrl.protocol === 'https:' ? 'https' : 'http')
  return `${proto}://${host}`
}

export function loopbackPeerOrigin(origin: string): string | null {
  try {
    const u = new URL(origin)
    const port = u.port || (u.protocol === 'https:' ? '443' : '80')
    if (u.hostname === '127.0.0.1') {
      return `${u.protocol}//localhost:${port}`
    }
    if (u.hostname === 'localhost') {
      return `${u.protocol}//127.0.0.1:${port}`
    }
  } catch {
    // ignore
  }
  return null
}

/** 为 CSP `connect-src` 补充当前请求 origin 及其 loopback 对端（localhost ↔ 127.0.0.1）。 */
export function connectSrcOriginsForRequest(request: NextRequest): string[] {
  const origin = resolveRequestOrigin(request)
  const peer = loopbackPeerOrigin(origin)
  return peer ? [origin, peer] : [origin]
}
