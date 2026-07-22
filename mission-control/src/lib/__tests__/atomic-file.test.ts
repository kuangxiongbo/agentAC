import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireFileLockSync, atomicReplaceFileSync } from '../atomic-file'

describe('atomic file updates', () => {
  let root = ''
  let target = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-atomic-file-'))
    target = join(root, 'config.json')
    writeFileSync(target, '{"value":1}\n', 'utf8')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('replaces a file and removes temporary artifacts', () => {
    const release = acquireFileLockSync(target)
    try { atomicReplaceFileSync(target, '{"value":2}\n') } finally { release() }
    expect(readFileSync(target, 'utf8')).toBe('{"value":2}\n')
    expect(readdirSync(root)).toEqual(['config.json'])
  })

  it('rejects a concurrent live lock', () => {
    const release = acquireFileLockSync(target)
    try { expect(() => acquireFileLockSync(target)).toThrow(/busy/i) } finally { release() }
  })

  it('recovers a lock owned by a dead process', () => {
    mkdirSync(`${target}.mc-lock`, { mode: 0o700 })
    writeFileSync(`${target}.mc-lock/owner`, '99999999\n', { flag: 'wx', mode: 0o600 })
    acquireFileLockSync(target)()
    expect(existsSync(`${target}.mc-lock`)).toBe(false)
  })
})
