import { describe, expect, test } from 'bun:test'
import { ApprovalFace, parseSseEvents, type ApprovalEventData } from '../src/approvalFace.ts'
import type { PendingApproval } from '../src/approvalFleet.ts'

function item(id: string, over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    id,
    personality: 'boris',
    runtime: 'claude',
    kind: 'tool',
    tool: 'Bash',
    content: `cmd-${id}`,
    summary: `cmd-${id}`,
    title: 'boris · Bash',
    approvers: [],
    createdMs: 1,
    expiresMs: 2,
    ...over,
  }
}

/** A URL+method-routed fetch double. `routes` maps `"GET /path"` → {status, body}. */
function routedFetch(routes: Record<string, { status: number; body: unknown }>): {
  fetch: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const fn = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const key = `${method} ${path}`
    calls.push(key)
    const r = routes[key] ?? { status: 404, body: { error: 'no route' } }
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetch: fn, calls }
}

function makeFace(
  routes: Record<string, { status: number; body: unknown }>,
): {
  face: ApprovalFace
  requests: PendingApproval[]
  resolves: Array<{ id: string; decision?: string }>
  calls: string[]
} {
  const { fetch, calls } = routedFetch(routes)
  const requests: PendingApproval[] = []
  const resolves: Array<{ id: string; decision?: string }> = []
  const face = new ApprovalFace({
    base: 'http://x',
    deps: { fetch, env: {} },
    reconcileIntervalMs: 0,
    handlers: {
      onRequest: it => {
        requests.push(it)
      },
      onResolved: info => {
        resolves.push({ id: info.id, decision: info.decision })
      },
    },
  })
  return { face, requests, resolves, calls }
}

describe('parseSseEvents', () => {
  test('parses one complete frame (event/id/data)', () => {
    const { events, rest } = parseSseEvents('event: wake\nid: 123\ndata: {"a":1}\n\n')
    expect(events).toEqual([{ event: 'wake', id: '123', data: '{"a":1}' }])
    expect(rest).toBe('')
  })
  test('skips : comment lines (connected / hb)', () => {
    const { events } = parseSseEvents(': connected\n\nevent: x\ndata: 1\n\n: hb\n\n')
    expect(events).toEqual([{ event: 'x', data: '1' }])
  })
  test('concatenates multiline data with \\n', () => {
    const { events } = parseSseEvents('data: line1\ndata: line2\n\n')
    expect(events[0]!.data).toBe('line1\nline2')
  })
  test('normalizes CRLF', () => {
    const { events } = parseSseEvents('event: x\r\ndata: y\r\n\r\n')
    expect(events).toEqual([{ event: 'x', data: 'y' }])
  })
  test('holds a partial final frame in rest, completes on next chunk', () => {
    const a = parseSseEvents('event: x\ndata: par')
    expect(a.events).toEqual([])
    const b = parseSseEvents(a.rest + 'tial\n\n')
    expect(b.events).toEqual([{ event: 'x', data: 'partial' }])
  })
  test('parses multiple frames in one buffer', () => {
    const { events } = parseSseEvents('data: 1\n\ndata: 2\n\n')
    expect(events.map(e => e.data)).toEqual(['1', '2'])
  })
  test('value without a leading space is preserved', () => {
    const { events } = parseSseEvents('data:noSpace\n\n')
    expect(events[0]!.data).toBe('noSpace')
  })
})

describe('ApprovalFace.ingest — routing + dedup', () => {
  test('ignores non-approval src', async () => {
    const { face, requests, resolves } = makeFace({})
    await face.ingest({ src: 'lifecycle', ev: 'wake', id: '1' } as ApprovalEventData)
    expect(requests).toEqual([])
    expect(resolves).toEqual([])
  })

  test('approval-request fetches full item and renders once', async () => {
    const { face, requests, calls } = makeFace({
      'GET /fleet/v1/approvals/a1': { status: 200, body: { approval: item('a1') } },
    })
    await face.ingest({ src: 'approvals', ev: 'approval-request', id: 'a1' })
    expect(requests.map(r => r.id)).toEqual(['a1'])
    expect(requests[0]!.content).toBe('cmd-a1') // full content (criterion #7)
    expect(calls).toEqual(['GET /fleet/v1/approvals/a1'])
  })

  test('duplicate approval-request (at-least-once) renders once', async () => {
    const { face, requests, calls } = makeFace({
      'GET /fleet/v1/approvals/a1': { status: 200, body: { approval: item('a1') } },
    })
    await face.ingest({ src: 'approvals', ev: 'approval-request', id: 'a1' })
    await face.ingest({ src: 'approvals', ev: 'approval-request', id: 'a1' })
    expect(requests.length).toBe(1)
    expect(calls.length).toBe(1) // second ingest short-circuits before the fetch
  })

  test('a 404 on the item (resolved before GET) renders nothing; id stays carded to dedup retries', async () => {
    const { face, requests, calls } = makeFace({
      'GET /fleet/v1/approvals/a1': { status: 404, body: { error: 'gone' } },
    })
    await face.ingest({ src: 'approvals', ev: 'approval-request', id: 'a1' })
    // an immediate at-least-once duplicate must NOT re-fetch a known-gone id
    await face.ingest({ src: 'approvals', ev: 'approval-request', id: 'a1' })
    expect(requests).toEqual([])
    expect(calls).toEqual(['GET /fleet/v1/approvals/a1']) // fetched once, dup short-circuited
    const f = face as unknown as { carded: Set<string> }
    expect(f.carded.has('a1')).toBe(true) // reconcile releases it once it's not in the snapshot (id-reuse safety)
  })

  test('a TRANSPORT error (not 404) releases the guard for a reconcile retry', async () => {
    const { face, requests } = makeFace({
      'GET /fleet/v1/approvals/a1': { status: 500, body: { error: 'boom' } },
    })
    await face.ingest({ src: 'approvals', ev: 'approval-request', id: 'a1' })
    expect(requests).toEqual([])
    const f = face as unknown as { carded: Set<string> }
    expect(f.carded.has('a1')).toBe(false) // transient — allow retry
  })

  test('approval-resolved dispatches once and clears the card guard', async () => {
    const { face, resolves } = makeFace({
      'GET /fleet/v1/approvals/a1': { status: 200, body: { approval: item('a1') } },
    })
    await face.ingest({ src: 'approvals', ev: 'approval-request', id: 'a1' })
    await face.ingest({ src: 'approvals', ev: 'approval-resolved', id: 'a1', decision: 'allow', via: 'cli' })
    await face.ingest({ src: 'approvals', ev: 'approval-resolved', id: 'a1', decision: 'allow' }) // dup
    expect(resolves).toEqual([{ id: 'a1', decision: 'allow' }])
  })

  test('resolved for an unseen id still dispatches (edit is a no-op downstream)', async () => {
    const { face, resolves } = makeFace({})
    await face.ingest({ src: 'approvals', ev: 'approval-resolved', id: 'zz', decision: 'deny' })
    expect(resolves).toEqual([{ id: 'zz', decision: 'deny' }])
  })

  test('unknown ev under src=approvals is ignored (forward-compat)', async () => {
    const { face, requests, resolves } = makeFace({})
    await face.ingest({ src: 'approvals', ev: 'approval-future-thing', id: 'a1' })
    expect(requests).toEqual([])
    expect(resolves).toEqual([])
  })
})

describe('ApprovalFace.reconcile — snapshot recovery', () => {
  test('renders a card for each pending id not yet carded', async () => {
    const { face, requests } = makeFace({
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [item('a1'), item('a2')] } },
    })
    await face.reconcile()
    expect(requests.map(r => r.id).sort()).toEqual(['a1', 'a2'])
  })

  test('does not re-render an already-carded id (event then reconcile)', async () => {
    const { face, requests } = makeFace({
      'GET /fleet/v1/approvals/a1': { status: 200, body: { approval: item('a1') } },
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [item('a1'), item('a2')] } },
    })
    await face.ingest({ src: 'approvals', ev: 'approval-request', id: 'a1' })
    await face.reconcile()
    expect(requests.map(r => r.id)).toEqual(['a1', 'a2']) // a1 once, a2 new
  })

  test('drops the card guard for an id no longer pending (resolved out-of-band)', async () => {
    const { face } = makeFace({
      'GET /fleet/v1/approvals/a1': { status: 200, body: { approval: item('a1') } },
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [] } },
    })
    await face.ingest({ src: 'approvals', ev: 'approval-request', id: 'a1' })
    await face.reconcile()
    const f = face as unknown as { carded: Set<string> }
    expect(f.carded.has('a1')).toBe(false)
  })

  test('reconcile survives a transport error (logs, no throw)', async () => {
    const { face, requests } = makeFace({ 'GET /fleet/v1/approvals': { status: 500, body: { error: 'boom' } } })
    await face.reconcile()
    expect(requests).toEqual([])
  })
})
