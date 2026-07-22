import { describe, expect, it } from 'vitest'
import { MAX_REGISTRY_SKILL_BYTES, validateDownloadedSkillContent } from '../skill-registry'

describe('downloaded skill limits', () => {
  it('accepts bounded text and rejects empty or non-text content', () => {
    const content = '# safe-skill\n\nA bounded skill document.\n'
    expect(validateDownloadedSkillContent(content)).toBe(content)
    expect(() => validateDownloadedSkillContent(' \n')).toThrow('empty content')
    expect(() => validateDownloadedSkillContent({ content })).toThrow('non-text content')
  })

  it('measures UTF-8 bytes and rejects oversized content', () => {
    const oversized = 'é'.repeat(Math.floor(MAX_REGISTRY_SKILL_BYTES / 2) + 1)
    expect(() => validateDownloadedSkillContent(oversized)).toThrow(`${MAX_REGISTRY_SKILL_BYTES} bytes`)
  })
})
