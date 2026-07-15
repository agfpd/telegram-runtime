import { describe, expect, test } from 'bun:test'
import { FleetFace, parseSseEvents, type FleetEventData } from '../src/fleetFace.ts'
import type { FleetNotice, PendingApproval } from '../src/fleetClient.ts'

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

function notice(id: string, over: Partial<FleetNotice> = {}): FleetNotice {
  return {
    id,
    personality: 'boris',
    runtime: 'claude',
    kind: 'peer-mute',
    errorType: 'rate_limit',
    model: 'Fable 5',
    summary: `boris · claude — rate_limit (Fable 5)`,
    content: `mute-${id}`,
    createdMs: 1,
    lastMs: 1,
    expiresMs: 2,
    count: 1,
    ...over,
  }
}

/** A face with BOTH surfaces wired (the production shape). */
function makeFace(routes: Record<string, { status: number; body: unknown }>): {
  face: FleetFace
  requests: PendingApproval[]
  resolves: Array<{ id: string; decision?: string }>
  notices: FleetNotice[]
  calls: string[]
} {
  const { fetch, calls } = routedFetch(routes)
  const requests: PendingApproval[] = []
  const resolves: Array<{ id: string; decision?: string }> = []
  const notices: FleetNotice[] = []
  const face = new FleetFace({
    base: 'http://x',
    deps: { fetch, env: {} },
    reconcileIntervalMs: 0,
    approval: {
      onRequest: it => {
        requests.push(it)
      },
      onResolved: info => {
        resolves.push({ id: info.id, decision: info.decision })
      },
    },
    notice: {
      onNotice: it => {
        notices.push(it)
      },
    },
  })
  return { face, requests, resolves, notices, calls }
}

/** A face with ONLY the surfaces named — proves the per-surface kill switches are real. */
function makeGatedFace(
  routes: Record<string, { status: number; body: unknown }>,
  surfaces: { approval?: boolean; notice?: boolean },
): { face: FleetFace; requests: PendingApproval[]; notices: FleetNotice[]; calls: string[] } {
  const { fetch, calls } = routedFetch(routes)
  const requests: PendingApproval[] = []
  const notices: FleetNotice[] = []
  const face = new FleetFace({
    base: 'http://x',
    deps: { fetch, env: {} },
    reconcileIntervalMs: 0,
    approval: surfaces.approval
      ? {
          onRequest: it => {
            requests.push(it)
          },
          onResolved: () => {},
        }
      : undefined,
    notice: surfaces.notice
      ? {
          onNotice: it => {
            notices.push(it)
          },
        }
      : undefined,
  })
  return { face, requests, notices, calls }
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

describe('FleetFace.ingest — routing + dedup', () => {
  test('ignores non-approval src', async () => {
    const { face, requests, resolves } = makeFace({})
    await face.ingest({ src: 'lifecycle', ev: 'wake', id: '1' } as FleetEventData)
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

describe('FleetFace.reconcile — snapshot recovery', () => {
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

// ── Notices (docs/19) ───────────────────────────────────────────────────────

describe('FleetFace.ingest — notices', () => {
  test('notice-raised fetches the full notice and sends once', async () => {
    const { face, notices, calls } = makeFace({
      'GET /fleet/v1/notices/n1': { status: 200, body: { notice: notice('n1') } },
    })
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n1' })
    expect(notices.map(n => n.id)).toEqual(['n1'])
    // content + count ride ONLY the REST item, never the SSE event — hence the GET.
    expect(notices[0]!.content).toBe('mute-n1')
    expect(calls).toEqual(['GET /fleet/v1/notices/n1'])
  })

  test('duplicate notice-raised (at-least-once) sends once', async () => {
    const { face, notices, calls } = makeFace({
      'GET /fleet/v1/notices/n1': { status: 200, body: { notice: notice('n1') } },
    })
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n1' })
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n1' })
    expect(notices.length).toBe(1)
    expect(calls.length).toBe(1)
  })

  test('a 404 (TTL passed between hint and GET) sends nothing', async () => {
    const { face, notices } = makeFace({
      'GET /fleet/v1/notices/n1': { status: 404, body: { error: 'gone' } },
    })
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n1' })
    expect(notices).toEqual([])
  })

  test('a TRANSPORT error releases the guard for a reconcile retry', async () => {
    const { face, notices } = makeFace({
      'GET /fleet/v1/notices/n1': { status: 500, body: { error: 'boom' } },
    })
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n1' })
    expect(notices).toEqual([])
    const f = face as unknown as { noticed: Set<string> }
    expect(f.noticed.has('n1')).toBe(false) // transient — the owner still gets told, late
  })

  test('unknown ev under src=notices is ignored (forward-compat)', async () => {
    const { face, notices } = makeFace({})
    await face.ingest({ src: 'notices', ev: 'notice-future-thing', id: 'n1' })
    expect(notices).toEqual([])
  })

  // docs/19 obligation 4: kind is a growth seam. A face that only understood `peer-mute`
  // would silently drop the next kind — the exact failure mode notices exist to end.
  test('an UNKNOWN kind is still delivered', async () => {
    const { face, notices } = makeFace({
      'GET /fleet/v1/notices/n9': { status: 200, body: { notice: notice('n9', { kind: 'peer-possessed' }) } },
    })
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n9' })
    expect(notices.map(n => n.kind)).toEqual(['peer-possessed'])
  })

  test('an UNKNOWN errorType is still delivered', async () => {
    const { face, notices } = makeFace({
      'GET /fleet/v1/notices/n9': { status: 200, body: { notice: notice('n9', { errorType: 'brand_new_wall' }) } },
    })
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n9' })
    expect(notices.map(n => n.errorType)).toEqual(['brand_new_wall'])
  })
})

describe('FleetFace — per-surface gating', () => {
  test('notices OFF: a notice-raised is inert and never even fetched', async () => {
    const { face, notices, calls } = makeGatedFace(
      { 'GET /fleet/v1/notices/n1': { status: 200, body: { notice: notice('n1') } } },
      { approval: true, notice: false },
    )
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n1' })
    expect(notices).toEqual([])
    expect(calls).toEqual([])
  })

  // The load-bearing half: TELEGRAM_APPROVAL=0 must NOT silence mute-reporting. Notices
  // are a diagnostic channel of last resort — the peer that would report itself is the
  // one that cannot speak.
  test('approvals OFF: notices still flow, and approvals are not fetched', async () => {
    const { face, requests, notices, calls } = makeGatedFace(
      {
        'GET /fleet/v1/notices/n1': { status: 200, body: { notice: notice('n1') } },
        'GET /fleet/v1/approvals/a1': { status: 200, body: { approval: item('a1') } },
      },
      { approval: false, notice: true },
    )
    await face.ingest({ src: 'approvals', ev: 'approval-request', id: 'a1' })
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n1' })
    expect(requests).toEqual([])
    expect(notices.map(n => n.id)).toEqual(['n1'])
    expect(calls).toEqual(['GET /fleet/v1/notices/n1'])
  })

  test('reconcile only touches the ENABLED surfaces', async () => {
    const { face, calls } = makeGatedFace(
      {
        'GET /fleet/v1/notices': { status: 200, body: { notices: [] } },
        'GET /fleet/v1/approvals': { status: 200, body: { approvals: [] } },
      },
      { approval: false, notice: true },
    )
    await face.reconcile()
    expect(calls).toEqual(['GET /fleet/v1/notices'])
  })
})

describe('FleetFace.reconcile — notice board seeding (a restart must not re-notify)', () => {
  // The defect this pins was observed LIVE: deploying 0.27.0 restarted the runtime, whose
  // connect-time reconcile re-sent all five live cards to the owner. His deploy became his
  // notification, about mutes he had read 15 minutes earlier.
  test('the FIRST successful board read is adopted SILENTLY', async () => {
    const { face, notices } = makeFace({
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [] } },
      'GET /fleet/v1/notices': { status: 200, body: { notices: [notice('n1'), notice('n2')] } },
    })
    await face.reconcile()
    expect(notices).toEqual([]) // predates us — the owner already knows
    const f = face as unknown as { noticed: Set<string> }
    expect([...f.noticed].sort()).toEqual(['n1', 'n2']) // …but guarded, so no later re-send
  })

  test('a notice born AFTER the seed is delivered', async () => {
    const routes: Record<string, { status: number; body: unknown }> = {
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [] } },
      'GET /fleet/v1/notices': { status: 200, body: { notices: [notice('n1')] } },
    }
    const { face, notices } = makeFace(routes)
    await face.reconcile() // seeds n1 silently
    expect(notices).toEqual([])
    routes['GET /fleet/v1/notices'] = { status: 200, body: { notices: [notice('n1'), notice('n2')] } }
    await face.reconcile()
    expect(notices.map(n => n.id)).toEqual(['n2']) // only the new one
  })

  test('a live SSE raise right after the seed is delivered (the seed guards only what it saw)', async () => {
    const { face, notices } = makeFace({
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [] } },
      'GET /fleet/v1/notices': { status: 200, body: { notices: [notice('n1')] } },
      'GET /fleet/v1/notices/n2': { status: 200, body: { notice: notice('n2') } },
    })
    await face.reconcile()
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n2' })
    expect(notices.map(n => n.id)).toEqual(['n2'])
  })

  // The seed must not be burned by a read that never happened, or the retry would mistake
  // a pre-existing board for fresh news and re-notify exactly as before the fix.
  test('a FAILED first read does not burn the seed', async () => {
    const routes: Record<string, { status: number; body: unknown }> = {
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [] } },
      'GET /fleet/v1/notices': { status: 500, body: { error: 'boom' } },
    }
    const { face, notices } = makeFace(routes)
    await face.reconcile()
    expect(notices).toEqual([])
    routes['GET /fleet/v1/notices'] = { status: 200, body: { notices: [notice('n1')] } }
    await face.reconcile() // THIS is the first successful read → seeds, stays silent
    expect(notices).toEqual([])
  })

  // The asymmetry boris and web-runtime settled on: an approval has a 300 s deadline and a
  // blocked human, so a restart MUST re-render its card. Only notices are seeded.
  test('approvals are NOT seeded — a restart re-cards the pending queue', async () => {
    const { face, requests, notices } = makeFace({
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [item('a1')] } },
      'GET /fleet/v1/notices': { status: 200, body: { notices: [notice('n1')] } },
    })
    await face.reconcile()
    expect(requests.map(r => r.id)).toEqual(['a1']) // re-rendered: someone is waiting
    expect(notices).toEqual([]) // seeded: nobody is waiting
  })
})

describe('FleetFace.reconcile — notice board', () => {
  test('sends a notice missed while disconnected MID-LIFE (after the seed)', async () => {
    const routes: Record<string, { status: number; body: unknown }> = {
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [] } },
      'GET /fleet/v1/notices': { status: 200, body: { notices: [] } },
    }
    const { face, notices } = makeFace(routes)
    await face.reconcile() // seed against an EMPTY board
    routes['GET /fleet/v1/notices'] = { status: 200, body: { notices: [notice('n1'), notice('n2')] } }
    await face.reconcile()
    expect(notices.map(n => n.id).sort()).toEqual(['n1', 'n2'])
  })

  test('does not re-send an already-sent notice (event then reconcile)', async () => {
    const { face, notices } = makeFace({
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [] } },
      'GET /fleet/v1/notices/n1': { status: 200, body: { notice: notice('n1') } },
      'GET /fleet/v1/notices': { status: 200, body: { notices: [notice('n1'), notice('n2')] } },
    })
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n1' })
    await face.reconcile() // first board read → seeds n2, n1 already sent
    expect(notices.map(n => n.id)).toEqual(['n1'])
  })

  // docs/19 obligation 3: the daemon OMITS `notices` entirely when the board is empty.
  // Absence must read as "empty", never as a parse failure.
  test('an omitted `notices` field means an empty board', async () => {
    const { face, notices } = makeFace({
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [] } },
      'GET /fleet/v1/notices': { status: 200, body: { api: 1, version: '0.4.94' } },
    })
    await face.reconcile()
    expect(notices).toEqual([])
  })

  // docs/19 obligation 5: ids are in-memory counters, NOT stable across a daemon restart.
  // Holding `n1` forever would swallow the re-issued one — a real mute reported to nobody.
  test('releases the guard once an id leaves the board, so a re-issued id is delivered again', async () => {
    const { face, notices } = makeFace({
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [] } },
      'GET /fleet/v1/notices/n1': { status: 200, body: { notice: notice('n1') } },
      'GET /fleet/v1/notices': { status: 200, body: { notices: [] } }, // TTL passed / daemon restarted
    })
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n1' })
    expect(notices.length).toBe(1)
    await face.reconcile()
    const f = face as unknown as { noticed: Set<string> }
    expect(f.noticed.has('n1')).toBe(false)
    // …and a NEW notice that reuses the id after a restart reaches the owner.
    await face.ingest({ src: 'notices', ev: 'notice-raised', id: 'n1' })
    expect(notices.length).toBe(2)
  })

  test('a notice reconcile failure does not skip the approval reconcile', async () => {
    const { face, requests } = makeFace({
      'GET /fleet/v1/approvals': { status: 200, body: { approvals: [item('a1')] } },
      'GET /fleet/v1/notices': { status: 500, body: { error: 'boom' } },
    })
    await face.reconcile()
    expect(requests.map(r => r.id)).toEqual(['a1'])
  })
})
