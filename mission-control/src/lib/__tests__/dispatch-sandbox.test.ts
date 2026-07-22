import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clampCliMaxBudgetUsd,
  filterCliAllowedTools,
  resolveCliDispatchCwd,
  resolveCliDispatchSandboxOptions,
} from '../dispatch-sandbox'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('dispatch sandbox', () => {
  it('drops unknown tools and clamps budgets', () => {
    expect(filterCliAllowedTools(['Read', 'Bash(git:*)', 'Read', 'Write']))
      .toEqual(['Read', 'Write'])
    expect(clampCliMaxBudgetUsd(250)).toBe(100)
    expect(clampCliMaxBudgetUsd(-1)).toBeNull()
  })

  it('rejects traversal and symlink escapes from the workspace root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mc-sandbox-root-'))
    const outside = mkdtempSync(path.join(tmpdir(), 'mc-sandbox-outside-'))
    roots.push(root, outside)
    mkdirSync(path.join(root, 'repo'))
    symlinkSync(outside, path.join(root, 'escape'))
    expect(resolveCliDispatchCwd('repo', root)).toBe(realpathSync(path.join(root, 'repo')))
    expect(resolveCliDispatchCwd('../', root)).toBeNull()
    expect(resolveCliDispatchCwd('escape', root)).toBeNull()
  })

  it('allows task or goal overrides to tighten but not broaden agent policy', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mc-sandbox-merge-'))
    roots.push(root)
    mkdirSync(path.join(root, 'repo'))
    const result = resolveCliDispatchSandboxOptions({
      dispatchAllowedTools: ['Read', 'Write'],
      dispatchMaxBudgetUsd: 10,
      dispatchCwd: '.',
    }, {
      dispatch_allowed_tools: ['Read', 'Bash'],
      dispatch_max_budget_usd: 3,
      dispatch_cwd: 'repo',
    }, root)
    expect(result).toEqual({
      allowedTools: ['Read'],
      maxBudgetUsd: 3,
      cwd: realpathSync(path.join(root, 'repo')),
    })
  })

  it('rejects an empty agent and task tool-policy intersection', () => {
    expect(() => resolveCliDispatchSandboxOptions(
      { dispatchAllowedTools: ['Read'] },
      { dispatchAllowedTools: ['Write'] },
      realpathSync('/tmp'),
    )).toThrow('no tools allowed')
  })
})
