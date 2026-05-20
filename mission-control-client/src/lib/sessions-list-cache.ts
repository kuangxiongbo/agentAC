let mergedSessionsCache: { at: number; sessions: Array<Record<string, unknown>> } | null = null

export const MERGED_SESSIONS_CACHE_MS = 8_000

export function getMergedSessionsCache() {
  return mergedSessionsCache
}

export function setMergedSessionsCache(sessions: Array<Record<string, unknown>>) {
  mergedSessionsCache = { at: Date.now(), sessions }
}

export function invalidateMergedSessionsCache() {
  mergedSessionsCache = null
}
