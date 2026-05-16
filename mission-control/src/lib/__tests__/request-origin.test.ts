import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { connectSrcOriginsForRequest, loopbackPeerOrigin, resolveRequestOrigin } from '@/lib/request-origin'

describe('request-origin', () => {
  it('resolveRequestOrigin prefers Host header over request.url', () => {
    const req = new NextRequest('http://localhost:5000/api/auth/callback?code=x', {
      headers: { host: '127.0.0.1:5000' },
    })
    expect(resolveRequestOrigin(req)).toBe('http://127.0.0.1:5000')
  })

  it('loopbackPeerOrigin maps 127.0.0.1 to localhost', () => {
    expect(loopbackPeerOrigin('http://127.0.0.1:5000')).toBe('http://localhost:5000')
    expect(loopbackPeerOrigin('http://localhost:5000')).toBe('http://127.0.0.1:5000')
  })

  it('connectSrcOriginsForRequest includes peer loopback', () => {
    const req = new NextRequest('http://localhost:5000/login', {
      headers: { host: '127.0.0.1:5000' },
    })
    expect(connectSrcOriginsForRequest(req)).toEqual([
      'http://127.0.0.1:5000',
      'http://localhost:5000',
    ])
  })
})
