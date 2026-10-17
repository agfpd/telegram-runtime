import { describe, expect, test } from 'bun:test'
import { activeTranscriptPath, anchorTurnRuntime, parseIapSendDeliveredRuntime } from '../src/cli'

// docs/20 «Endpoint selection» (iapeer + PM, 17.10.2026): one Telegram dialogue →
// one endpoint. The send is routed to default_runtime; delivered_to.runtime is
// authoritative for activity; the live/freshest runtime is never a selector.
describe('parseIapSendDeliveredRuntime', () => {
  test('reads the CLI text forms of a successful send', () => {
    expect(parseIapSendDeliveredRuntime('delivered to boris (codex)\n')).toBe('codex')
    expect(parseIapSendDeliveredRuntime('queued for boris (opencode), depth 2 — the daemon tick drains it\n')).toBe('opencode')
  })
  test('reads the JSON result form', () => {
    expect(
      parseIapSendDeliveredRuntime('{"ok":true,"delivered_to":{"personality":"boris","runtime":"claude"},"woke":false}'),
    ).toBe('claude')
  })
  test('undefined when no delivery line is present', () => {
    expect(parseIapSendDeliveredRuntime('')).toBeUndefined()
    expect(parseIapSendDeliveredRuntime('ok=true woke=false')).toBeUndefined()
    expect(parseIapSendDeliveredRuntime('{"ok":true}')).toBeUndefined()
  })
})

describe('anchorTurnRuntime — two live runtimes of one personality', () => {
  test('before the delivery answer: the default the send was routed to', () => {
    expect(anchorTurnRuntime('claude', 'claude', undefined)).toBe('claude')
  })
  test('the delivery answer wins over the start default', () => {
    expect(anchorTurnRuntime('claude', 'claude', 'codex')).toBe('codex')
  })
  test('an explicit default switch mid-turn wins (switch / alias self-fresh)', () => {
    expect(anchorTurnRuntime('claude', 'codex', 'claude')).toBe('codex')
  })
  test('an unreadable profile keeps the anchor', () => {
    expect(anchorTurnRuntime('claude', undefined, undefined)).toBe('claude')
    expect(anchorTurnRuntime('claude', undefined, 'codex')).toBe('codex')
  })
})

describe('activeTranscriptPath — runtime-specific observation contracts only', () => {
  test('an unknown runtime never borrows the Claude transcript of a shared cwd', () => {
    const target = { personality: 'p', runtime: 'opencode', runtimes: ['claude', 'opencode'], cwd: '/tmp' } as never
    expect(activeTranscriptPath(target, 'opencode')).toBeNull()
  })
})
