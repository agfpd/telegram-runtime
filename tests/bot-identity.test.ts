import { describe, expect, test } from 'bun:test'
import { peerBotKey, probeBotIdentity } from '../src/cli.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// ── peerBotKey: resolves a peer's bot catalog key from bot_username ──────────
describe('peerBotKey', () => {
  const base = { personality: 'x', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial' as const }

  test('resolves the bot_username key', () => {
    expect(peerBotKey({ ...base, interfaces: { telegram: { bot_username: 'maria_bot' } } })).toBe('maria_bot')
  })

  test('normalizes @-prefix and case', () => {
    expect(peerBotKey({ ...base, interfaces: { telegram: { bot_username: '@Maria_Bot' } } })).toBe('maria_bot')
  })

  test('undefined for a peer with no telegram bot (e.g. the human owner)', () => {
    expect(peerBotKey({ ...base, interfaces: { telegram: { user_id: '1' } } })).toBeUndefined()
    expect(peerBotKey(base)).toBeUndefined()
  })
})

describe('probeBotIdentity — getMe validation for `bot add`', () => {
  test('valid token → ok with the REAL username from getMe', async () => {
    const probe = await probeBotIdentity('1:GOOD', async url => {
      expect(url).toBe('https://api.telegram.org/bot1:GOOD/getMe')
      return jsonResponse({ ok: true, result: { id: 1, is_bot: true, username: 'maria_bot' } })
    })
    expect(probe).toEqual({ ok: true, username: 'maria_bot' })
  })

  test('rejected token (401 Unauthorized) → invalid-token with Telegram description', async () => {
    const probe = await probeBotIdentity('1:BAD', async () =>
      jsonResponse({ ok: false, error_code: 401, description: 'Unauthorized' }, 401),
    )
    expect(probe).toEqual({ ok: false, reason: 'invalid-token', detail: 'Unauthorized' })
  })

  test('non-JSON / unexpected body → invalid-token with HTTP status detail', async () => {
    const probe = await probeBotIdentity('1:WEIRD', async () => new Response('<html>oops</html>', { status: 502 }))
    expect(probe).toEqual({ ok: false, reason: 'invalid-token', detail: 'HTTP 502' })
  })

  test('getMe ok but result lacks username → invalid-token (defensive)', async () => {
    const probe = await probeBotIdentity('1:NOUSER', async () => jsonResponse({ ok: true, result: { id: 1 } }))
    expect(probe).toEqual({ ok: false, reason: 'invalid-token', detail: 'getMe result has no username' })
  })

  test('network failure (fetch throws) → network reason, NOT invalid-token', async () => {
    const probe = await probeBotIdentity('1:OFFLINE', async () => {
      throw new Error('connect ECONNREFUSED')
    })
    expect(probe).toEqual({ ok: false, reason: 'network', detail: 'connect ECONNREFUSED' })
  })
})
