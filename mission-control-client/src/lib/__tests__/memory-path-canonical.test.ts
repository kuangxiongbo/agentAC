import { describe, expect, it } from 'vitest'
import { canonicalizeMemoryRelativePath, memoryPathForMode } from '../memory-path'

describe('canonical memory paths', () => {
  it('accepts canonical relative paths', () => {
    expect(canonicalizeMemoryRelativePath('memory/project/note.md')).toBe('memory/project/note.md')
  })

  it.each(['../secret', '/etc/passwd', 'a//b', 'a/./b', 'C:\\secret', `a\0b`])(
    'rejects non-canonical path %s',
    (value) => expect(() => canonicalizeMemoryRelativePath(value)).toThrow(),
  )

  it('does not expose a local memory path in central mode', () => {
    expect(memoryPathForMode('/nonexistent/.openclaw/memory', true)).toBe('')
    expect(memoryPathForMode('/home/user/.openclaw/memory', false)).toBe('/home/user/.openclaw/memory')
  })
})
