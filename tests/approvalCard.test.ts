import { describe, expect, test } from 'bun:test'
import {
  buildCallbackData,
  buildCardText,
  buildKeyboard,
  buildResolvedText,
  CARD_CONTENT_MAX,
  parseCallbackData,
  truncateContent,
} from '../src/approvalCard.ts'
import type { PendingApproval } from '../src/fleetClient.ts'

function item(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id: 'a1',
    personality: 'boris',
    runtime: 'claude',
    kind: 'tool',
    tool: 'Bash',
    content: 'rm -rf /tmp/x',
    summary: 'rm -rf /tmp/x',
    title: 'boris · Bash',
    approvers: [],
    createdMs: 1,
    expiresMs: 2,
    ...over,
  }
}

describe('callback_data', () => {
  test('round-trips approve / deny', () => {
    expect(parseCallbackData(buildCallbackData('a7', 'approve'))).toEqual({ id: 'a7', action: 'approve' })
    expect(parseCallbackData(buildCallbackData('a7', 'deny'))).toEqual({ id: 'a7', action: 'deny' })
  })
  test('stays well within the 64-byte Telegram limit', () => {
    expect(buildCallbackData('a999999', 'deny').length).toBeLessThan(64)
  })
  test('rejects foreign / malformed data (other buttons share the channel)', () => {
    expect(parseCallbackData(undefined)).toBeNull()
    expect(parseCallbackData('')).toBeNull()
    expect(parseCallbackData('other:a1:a')).toBeNull()
    expect(parseCallbackData('apv:a1')).toBeNull()
    expect(parseCallbackData('apv:a1:x')).toBeNull()
    expect(parseCallbackData('apv::a')).toBeNull()
  })
})

describe('truncateContent', () => {
  test('passes short content through', () => {
    expect(truncateContent('hi')).toBe('hi')
  })
  test('truncates long content with a CLI pointer', () => {
    const out = truncateContent('x'.repeat(CARD_CONTENT_MAX + 100))
    expect(out.length).toBeLessThan(CARD_CONTENT_MAX + 60)
    expect(out).toContain('iapeer approvals')
  })
})

describe('buildCardText', () => {
  test('shows the full command verbatim (criterion #7)', () => {
    expect(buildCardText(item({ content: 'echo LIVE && cat secret' }))).toContain('echo LIVE &amp;&amp; cat secret')
  })
  test('escapes HTML metacharacters in content (no injection / no parse break)', () => {
    const t = buildCardText(item({ content: 'grep "<a>" & tail' }))
    expect(t).toContain('&lt;a&gt;')
    expect(t).toContain('&amp;')
    expect(t).not.toContain('<a>')
  })
  test('carries the title header and runtime·kind subline', () => {
    const t = buildCardText(item({ title: 'iapeer · Edit', runtime: 'codex', kind: 'tool' }))
    expect(t).toContain('<b>iapeer · Edit</b>')
    expect(t).toContain('codex · tool')
  })
})

describe('buildResolvedText', () => {
  test('allow → ✅ Разрешено', () => {
    const t = buildResolvedText(item(), { decision: 'allow', by: 'arthur', via: 'telegram' })
    expect(t).toContain('✅')
    expect(t).toContain('Разрешено')
    expect(t).toContain('by arthur')
    expect(t).toContain('via telegram')
  })
  test('deny → ⛔ Отклонено + reason', () => {
    const t = buildResolvedText(item(), { decision: 'deny', reason: 'nope', by: 'arthur', via: 'cli' })
    expect(t).toContain('⛔')
    expect(t).toContain('Отклонено')
    expect(t).toContain('nope')
  })
  test('timeout → ⏳ Истекло', () => {
    const t = buildResolvedText(item(), { decision: 'deny', via: 'timeout' })
    expect(t).toContain('⏳')
    expect(t).toContain('Истекло')
  })
})

describe('buildKeyboard', () => {
  test('two buttons with our callback_data', () => {
    const kb = buildKeyboard('a3')
    expect(kb.inline_keyboard[0]!.map(b => b.callback_data)).toEqual(['apv:a3:a', 'apv:a3:d'])
    expect(kb.inline_keyboard[0]!.map(b => b.text)).toEqual(['✅ Разрешить', '⛔ Отклонить'])
  })
})
