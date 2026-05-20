import { describe, expect, it } from 'vitest'
import type { SessionTranscriptMessage } from '@/components/chat/session-message'
import {
  hasVisibleAssistantReplyAfterBaseline,
  isReplyCycleComplete,
  resolveReplyProgressUi,
} from '@/components/chat/session-thinking-progress'

function msg(
  role: SessionTranscriptMessage['role'],
  parts: SessionTranscriptMessage['parts'],
): SessionTranscriptMessage {
  return { role, parts }
}

describe('session-thinking-progress reply UI', () => {
  it('detects visible assistant text after baseline, not only on last message', () => {
    const messages: SessionTranscriptMessage[] = [
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [{ type: 'text', text: 'partial answer' }]),
      msg('assistant', [{ type: 'tool_use', id: 't1', name: 'bash', input: '{}' }]),
    ]
    expect(hasVisibleAssistantReplyAfterBaseline(messages, 0)).toBe(true)
    expect(isReplyCycleComplete(messages, 0)).toBe(false)
  })

  it('uses waiting mode before first visible reply', () => {
    const messages: SessionTranscriptMessage[] = [
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [{ type: 'tool_use', id: 't1', name: 'read', input: '{}' }]),
    ]
    const ui = resolveReplyProgressUi(true, messages, 0, 3)
    expect(ui.mode).toBe('waiting')
    expect(ui.progress?.phase).toBe('tool')
  })

  it('hides status after first visible reply while still awaiting', () => {
    const messages: SessionTranscriptMessage[] = [
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [{ type: 'text', text: 'here is part 1' }]),
      msg('assistant', [{ type: 'tool_use', id: 't1', name: 'bash', input: '{}' }]),
    ]
    const ui = resolveReplyProgressUi(true, messages, 0, 12)
    expect(ui.mode).toBe('hidden')
  })

  it('hides when not awaiting reply', () => {
    const messages: SessionTranscriptMessage[] = [
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [{ type: 'text', text: 'done' }]),
    ]
    expect(resolveReplyProgressUi(false, messages, 0, 0).mode).toBe('hidden')
    expect(isReplyCycleComplete(messages, 0)).toBe(true)
  })
})
