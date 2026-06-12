'use client'

import { useMemo } from 'react'
import { useAgentCenterStore } from '@/store'
import { useBridgeStatus } from '@/lib/use-bridge-status'
import { EDGE_DOWNLOAD_PATH } from '@/components/edge/edge-download-link'

function httpOriginFromBridgeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const normalized = trimmed.replace(/^ws/i, 'http').replace(/^wss/i, 'https')
    const url = new URL(normalized)
    return url.origin
  } catch {
    return null
  }
}

/** Center-hosted download page; local client mode opens the upstream center URL. */
export function useEdgeDownloadHref(): string {
  const { dashboardMode } = useAgentCenterStore()
  const isLocal = dashboardMode === 'local'
  const { bridge } = useBridgeStatus(0, isLocal)

  return useMemo(() => {
    if (!isLocal) return EDGE_DOWNLOAD_PATH
    const origin =
      httpOriginFromBridgeUrl(bridge?.configuredUrl || '') ||
      httpOriginFromBridgeUrl(bridge?.url || '')
    if (origin) return `${origin}${EDGE_DOWNLOAD_PATH}`
    return EDGE_DOWNLOAD_PATH
  }, [bridge?.configuredUrl, bridge?.url, isLocal])
}
