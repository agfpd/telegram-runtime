import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  fleetAvailable,
  getApproval,
  getNotice,
  listApprovals,
  listNotices,
  probeApprovals,
  probeNotices,
  probeSurface,
  resolveApproval,
  resolveFleetBase,
  routerJsonPath,
} from '../src/fleetClient.ts'

/** Write a router.json under an isolated IAPEER_ROOT and return the env pointing at it. */
function withRouter(router: unknown | null): { IAPEER_ROOT: string } {
  const root = mkdtempSync(join(tmpdir(), 'tgr-fleet-'))
  if (router !== null) {
    const dir = join(root, 'state', 'iapeer')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'router.json'), JSON.stringify(router))
  }
  return { IAPEER_ROOT: root }
}

/** A fetch double: records the last call and returns a canned Response. */
function fakeFetch(status: number, body: unknown): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetch: fn, calls }
}

describe('routerJsonPath', () => {
  test('is <root>/state/iapeer/router.json', () => {
    expect(routerJsonPath({ IAPEER_ROOT: '/sbx/root' })).toBe('/sbx/root/state/iapeer/router.json')
  })
})

describe('resolveFleetBase', () => {
  test('strips the /mcp suffix from router.json tcp', () => {
    const env = withRouter({ tcp: 'http://127.0.0.1:8765/mcp', fleet: 1 })
    expect(resolveFleetBase(env)).toBe('http://127.0.0.1:8765')
  })
  test('strips a bare /mcp/ trailing slash too', () => {
    const env = withRouter({ tcp: 'http://127.0.0.1:9000/mcp/', fleet: 1 })
    expect(resolveFleetBase(env)).toBe('http://127.0.0.1:9000')
  })
  test('falls back to loopback default when router.json absent', () => {
    const env = withRouter(null)
    expect(resolveFleetBase(env)).toBe('http://127.0.0.1:8765')
  })
  test('honours IAPEER_PORT in the fallback', () => {
    const env = { ...withRouter(null), IAPEER_PORT: '7000' }
    expect(resolveFleetBase(env)).toBe('http://127.0.0.1:7000')
  })
})

describe('fleetAvailable (static feature-detect)', () => {
  test('true only when router.json advertises fleet:1', () => {
    expect(fleetAvailable(withRouter({ tcp: 'http://127.0.0.1:8765/mcp', fleet: 1 }))).toBe(true)
  })
  test('false when fleet key absent (pre-fleet daemon)', () => {
    expect(fleetAvailable(withRouter({ tcp: 'http://127.0.0.1:8765/mcp' }))).toBe(false)
  })
  test('false when router.json missing (daemon down)', () => {
    expect(fleetAvailable(withRouter(null))).toBe(false)
  })
})

describe('probeApprovals (runtime feature-detect)', () => {
  test('true on 200', async () => {
    const { fetch } = fakeFetch(200, { approvals: [] })
    expect(await probeApprovals('http://x', { fetch, env: {} })).toBe(true)
  })
  test('false on 404 (pre-approval daemon)', async () => {
    const { fetch } = fakeFetch(404, { error: 'nope' })
    expect(await probeApprovals('http://x', { fetch, env: {} })).toBe(false)
  })
  test('false on transport throw', async () => {
    const throwingFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await probeApprovals('http://x', { fetch: throwingFetch, env: {} })).toBe(false)
  })
})

describe('listApprovals', () => {
  test('unwraps the approvals array', async () => {
    const item = { id: 'a1', personality: 'boris', runtime: 'claude', kind: 'tool', tool: 'Bash', content: 'rm -rf /tmp/x', summary: 'rm -rf /tmp/x', title: 'boris · Bash', approvers: [], createdMs: 1, expiresMs: 2 }
    const { fetch, calls } = fakeFetch(200, { api: 1, approvals: [item] })
    const out = await listApprovals('http://x', { fetch, env: {} })
    expect(out).toEqual([item])
    expect(calls[0]!.url).toBe('http://x/fleet/v1/approvals')
    expect((calls[0]!.init!.method)).toBe('GET')
  })
  test('empty when approvals missing', async () => {
    const { fetch } = fakeFetch(200, { api: 1 })
    expect(await listApprovals('http://x', { fetch, env: {} })).toEqual([])
  })
  test('throws on non-200', async () => {
    const { fetch } = fakeFetch(500, { error: 'boom' })
    await expect(listApprovals('http://x', { fetch, env: {} })).rejects.toThrow('500')
  })
  test('carries the bearer when configured', async () => {
    const { fetch, calls } = fakeFetch(200, { approvals: [] })
    await listApprovals('http://x', { fetch, env: { IAPEER_BEARER_TOKEN: 'sekret' } })
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer sekret')
  })
})

describe('getApproval', () => {
  test('unwraps the approval object', async () => {
    const item = { id: 'a7', personality: 'iapeer', runtime: 'codex', kind: 'tool', tool: 'Write', content: 'FULL BODY', summary: 'Write', title: 'iapeer · Write', approvers: [], createdMs: 1, expiresMs: 2 }
    const { fetch, calls } = fakeFetch(200, { approval: item })
    expect(await getApproval('http://x', 'a7', { fetch, env: {} })).toEqual(item)
    expect(calls[0]!.url).toBe('http://x/fleet/v1/approvals/a7')
  })
  test('returns null on 404 (resolved before the GET — the race)', async () => {
    const { fetch } = fakeFetch(404, { error: 'gone' })
    expect(await getApproval('http://x', 'a7', { fetch, env: {} })).toBeNull()
  })
  test('throws on other non-200', async () => {
    const { fetch } = fakeFetch(500, { error: 'boom' })
    await expect(getApproval('http://x', 'a7', { fetch, env: {} })).rejects.toThrow('500')
  })
})

describe('resolveApproval', () => {
  test('POSTs approve with via=telegram default + body fields', async () => {
    const { fetch, calls } = fakeFetch(200, { id: 'a1', action: 'approve', ok: true })
    const out = await resolveApproval('http://x', 'a1', 'approve', { approver: 'arthur' }, { fetch, env: {} })
    expect(out).toBe('ok')
    expect(calls[0]!.url).toBe('http://x/fleet/v1/approvals/a1/approve')
    expect(calls[0]!.init!.method).toBe('POST')
    const sent = JSON.parse(calls[0]!.init!.body as string)
    expect(sent).toEqual({ approver: 'arthur', via: 'telegram' })
  })
  test('deny carries the reason', async () => {
    const { fetch, calls } = fakeFetch(200, { ok: true })
    await resolveApproval('http://x', 'a1', 'deny', { approver: 'arthur', reason: 'nope' }, { fetch, env: {} })
    const sent = JSON.parse(calls[0]!.init!.body as string)
    expect(sent).toEqual({ approver: 'arthur', reason: 'nope', via: 'telegram' })
  })
  test('an explicit via overrides the default', async () => {
    const { fetch, calls } = fakeFetch(200, { ok: true })
    await resolveApproval('http://x', 'a1', 'approve', { via: 'tray' }, { fetch, env: {} })
    expect(JSON.parse(calls[0]!.init!.body as string).via).toBe('tray')
  })
  test("returns 'gone' on 404 (already resolved elsewhere)", async () => {
    const { fetch } = fakeFetch(404, { error: 'already resolved' })
    expect(await resolveApproval('http://x', 'a1', 'approve', {}, { fetch, env: {} })).toBe('gone')
  })
  test('throws on other non-200', async () => {
    const { fetch } = fakeFetch(502, { error: 'boom' })
    await expect(resolveApproval('http://x', 'a1', 'approve', {}, { fetch, env: {} })).rejects.toThrow('502')
  })
})

// ── Notices (docs/19) — read-only surface ───────────────────────────────────

/** The REAL notice object served by iapeer 0.4.94 at 18:22 on 15.07.2026 during the live
 *  fable exhaustion. `resetsAtMs` is absent because claude never stated one. */
const LIVE_NOTICE = {
  personality: 'iapeer',
  runtime: 'claude',
  kind: 'peer-mute',
  errorType: 'rate_limit',
  model: 'Fable 5',
  content: "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
  sessionId: '89655ffc-32ea-44bb-9fee-5652694c2ef4',
  summary: 'iapeer · claude — rate_limit (Fable 5)',
  id: 'n1',
  createdMs: 1784139401263,
  lastMs: 1784139441259,
  expiresMs: 1784143001263,
  count: 3,
}

// The three-valued probe exists to keep a BOOT RACE from permanently killing a surface:
// router.json is only removed on a graceful daemon close, so after a reboot/SIGKILL a
// stale `fleet:1` outlives the daemon and a runtime that boots first gets ECONNREFUSED.
// Collapsing that to "not served" would disable approvals AND notices for the whole
// process lifetime; only a definitive HTTP answer may disable a surface.
describe('probeSurface (three-valued)', () => {
  test('200 → live', async () => {
    const { fetch } = fakeFetch(200, { notices: [] })
    expect(await probeSurface('http://x', '/fleet/v1/notices', { fetch, env: {} })).toBe('live')
  })
  test('404 → absent (the daemon ANSWERED: it does not serve this surface)', async () => {
    const { fetch } = fakeFetch(404, { error: 'not found' })
    expect(await probeSurface('http://x', '/fleet/v1/notices', { fetch, env: {} })).toBe('absent')
  })
  test('a refused connection → unreachable, NOT absent (the daemon is not up YET)', async () => {
    const throwingFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await probeSurface('http://x', '/fleet/v1/notices', { fetch: throwingFetch, env: {} })).toBe('unreachable')
  })
  test('carries the bearer', async () => {
    const { fetch, calls } = fakeFetch(200, {})
    await probeSurface('http://x', '/fleet/v1/notices', { fetch, env: { IAPEER_BEARER_TOKEN: 'sekret' } })
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer sekret')
  })
})

describe('probeNotices', () => {
  test('200 → true', async () => {
    const { fetch } = fakeFetch(200, { notices: [] })
    expect(await probeNotices('http://x', { fetch, env: {} })).toBe(true)
  })
  test('404 (daemon older than the notice board) → false, not a throw', async () => {
    const { fetch } = fakeFetch(404, { error: 'not found' })
    expect(await probeNotices('http://x', { fetch, env: {} })).toBe(false)
  })
  test('a transport failure → false', async () => {
    const throwingFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await probeNotices('http://x', { fetch: throwingFetch, env: {} })).toBe(false)
  })
})

describe('listNotices', () => {
  test('parses the live board and preserves the ABSENT reset', async () => {
    const { fetch, calls } = fakeFetch(200, { api: 1, version: '0.4.94', notices: [LIVE_NOTICE] })
    const notices = await listNotices('http://x', { fetch, env: {} })
    expect(calls[0]!.url).toBe('http://x/fleet/v1/notices')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.errorType).toBe('rate_limit')
    expect(notices[0]!.count).toBe(3)
    // The client must not invent the field the daemon omitted.
    expect(notices[0]!.resetsAtMs).toBeUndefined()
    expect('resetsAtMs' in notices[0]!).toBe(false)
  })
  // docs/19 obligation 3 — the daemon OMITS the field when the board is empty.
  test('an omitted `notices` field is an empty board, not an error', async () => {
    const { fetch } = fakeFetch(200, { api: 1, version: '0.4.94' })
    expect(await listNotices('http://x', { fetch, env: {} })).toEqual([])
  })
  test('carries the bearer when set', async () => {
    const { fetch, calls } = fakeFetch(200, { notices: [] })
    await listNotices('http://x', { fetch, env: { IAPEER_BEARER_TOKEN: 'sekret' } })
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer sekret')
  })
  test('throws on non-200', async () => {
    const { fetch } = fakeFetch(500, { error: 'boom' })
    await expect(listNotices('http://x', { fetch, env: {} })).rejects.toThrow('500')
  })
})

describe('getNotice', () => {
  test('returns the full item (content + count ride only here, not the SSE event)', async () => {
    const { fetch, calls } = fakeFetch(200, { notice: LIVE_NOTICE })
    const n = await getNotice('http://x', 'n1', { fetch, env: {} })
    expect(calls[0]!.url).toBe('http://x/fleet/v1/notices/n1')
    expect(n!.content).toContain('Fable 5 limit')
    expect(n!.count).toBe(3)
  })
  test('404 (TTL passed) → null', async () => {
    const { fetch } = fakeFetch(404, { error: 'unknown id' })
    expect(await getNotice('http://x', 'n1', { fetch, env: {} })).toBeNull()
  })
  test('throws on other non-200', async () => {
    const { fetch } = fakeFetch(502, { error: 'boom' })
    await expect(getNotice('http://x', 'n1', { fetch, env: {} })).rejects.toThrow('502')
  })
  test('url-encodes the id', async () => {
    const { fetch, calls } = fakeFetch(200, { notice: LIVE_NOTICE })
    await getNotice('http://x', 'n 1/../x', { fetch, env: {} })
    expect(calls[0]!.url).toBe('http://x/fleet/v1/notices/n%201%2F..%2Fx')
  })
})
