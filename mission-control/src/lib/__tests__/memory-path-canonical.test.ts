import { describe, expect, it } from 'vitest'
import { canonicalizeMemoryRelativePath } from '../memory-path'

describe('canonical memory paths', () => {
  it('accepts canonical relative paths', () => {
    expect(canonicalizeMemoryRelativePath('memory/project/note.md')).toBe('memory/project/note.md')
  })

  it.each(['../secret', '/etc/passwd', 'a//b', 'a/./b', 'C:\\secret', `a\0b`])(
    'rejects non-canonical path %s',
    (value) => expect(() => canonicalizeMemoryRelativePath(value)).toThrow(),
  )
})
