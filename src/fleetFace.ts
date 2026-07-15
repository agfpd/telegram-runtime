// fleetFace — telegram-runtime's live subscriber to the daemon's owner-facing fleet
// surfaces. ONE SSE connection (docs/15 `GET /fleet/v1/events`, which tail-follows the
// daemon's durable logs) feeds BOTH surfaces, dispatched by the event's `src`:
//
//   • src="approvals" (docs/17, U2) — the in-daemon approval queue. `approval-request` →
//     render a card (U3 handler); `approval-resolved` (from ANY face — Telegram button,
//     CLI, tray, timeout) → edit that card to its outcome.
//   • src="notices" (docs/19) — the notice board. `notice-raised` → tell the owner a peer
//     went mute. ONE-WAY: rendered and done. There is no resolve, no card edit, no
//     lifecycle; a notice simply expires out of the board on its TTL, and the message the
//     owner already has stays true (it says what happened, not what is).
//
// The surfaces are INDEPENDENTLY gated (`approval` / `notice` handler sets, either may be
// absent) but deliberately share this connection and its reconnect/backoff loop: they are
// the same stream, the same bearer and the same at-least-once contract, and forking a
// second near-copy of the loop for notices is how a divergent copy starts.
//
// Contract obligations honoured for both: unknown `ev` and unknown `src` ignored; events
// are AT-LEAST-ONCE (dedup by id); the SNAPSHOT is the state and events are only hints —
// so on every (re)connect we reconcile against the list endpoints, and a periodic
// safety-net re-reconcile closes any gap between a reconcile and the live stream. Each
// SSE event carries only a compact summary, so the full item is fetched per-id (approval
// `content` for criterion #7; notice `content` + `count`, neither of which rides the
// event); an item gone before that GET is a 404 = "already over, skip".
//
// This module owns the EVENT PLUMBING + DEDUP/RECONCILE state machine (unit-tested here);
// the actual Telegram rendering is injected as handlers. It never makes an approval
// DECISION and never fails safe to deny — that invariant lives in the broker/hook; a face
// that misses an event simply doesn't show a card, and the request still times out to a
// safe deny in the daemon. Likewise it never judges a notice: it renders what the board
// says and never fills a blank in.

import {
  getApproval,
  getNotice,
  listApprovals,
  listNotices,
  type FleetClientDeps,
  type FleetNotice,
  type PendingApproval,
} from './fleetClient.ts'

/** One parsed SSE frame (`event:` / `id:` / `data:` lines up to a blank line). */
export interface SseEvent {
  event?: string
  id?: string
  data?: string
}

/** The daemon log line shape carried in an SSE event's `data`. The daemon flattens each
 *  logfmt line into `{src, ev, ...fields}` (fleet.ts writeEvent), so every field here is a
 *  STRING regardless of its type on the REST item — which is one more reason both surfaces
 *  fetch the real item by id rather than trusting the event's own fields. */
export interface FleetEventData {
  src?: string
  ev?: string
  id?: string
  personality?: string
  runtime?: string
  kind?: string
  tool?: string
  summary?: string
  decision?: string
  reason?: string
  by?: string
  via?: string
  [k: string]: unknown
}

/** What the face tells the Telegram layer for the APPROVAL surface (U3). Both are
 *  best-effort and async. */
export interface ApprovalFaceHandlers {
  /** A fresh pending request with its FULL content — render a card. Idempotent: the face
   *  guarantees at-most-once per id (dedup), so the handler need not guard re-renders. */
  onRequest: (item: PendingApproval) => void | Promise<void>
  /** A request resolved (any channel) — edit its card to the outcome. May arrive for an id
   *  this face never carded (resolved before we saw it) — the handler no-ops then. */
  onResolved: (info: ApprovalResolvedInfo) => void | Promise<void>
}

/** What the face tells the Telegram layer for the NOTICE surface (docs/19). There is only
 *  a raise: no resolve handler exists because a notice has no resolution. */
export interface NoticeFaceHandlers {
  /** A notice with its full `content` + `count` — tell the owner. At-most-once per id
   *  within a board lifetime, so the handler need not guard re-sends. */
  onNotice: (item: FleetNotice) => void | Promise<void>
}

export interface ApprovalResolvedInfo {
  id: string
  decision?: string
  reason?: string
  by?: string
  via?: string
}

/**
 * Parse a UTF-8 SSE buffer into complete events, returning the unconsumed tail (a partial
 * final frame). Frames are separated by a blank line; `:`-comment lines (`: connected`,
 * `: hb`) are skipped. Mirrors extractIapEnvelopes' buffer/rest discipline so the streaming
 * reader can feed arbitrary chunk boundaries safely. Exported for tests.
 */
export function parseSseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  // Normalize CRLF → LF so the frame split is newline-agnostic.
  const norm = buffer.replace(/\r\n/g, '\n')
  let idx: number
  let start = 0
  // A frame ends at a blank line (\n\n). Scan for each boundary.
  while ((idx = norm.indexOf('\n\n', start)) !== -1) {
    const frame = norm.slice(start, idx)
    start = idx + 2
    const ev: SseEvent = {}
    let sawField = false
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue // comment or blank
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') {
        ev.event = value
        sawField = true
      } else if (field === 'id') {
        ev.id = value
        sawField = true
      } else if (field === 'data') {
        ev.data = ev.data === undefined ? value : `${ev.data}\n${value}`
        sawField = true
      }
    }
    if (sawField) events.push(ev)
  }
  return { events, rest: norm.slice(start) }
}

export interface FleetFaceOptions {
  base: string
  /** APPROVAL surface handlers. Omit to leave the surface off (TELEGRAM_APPROVAL=0 /
   *  pre-approval daemon) — the stream still runs for whatever else is enabled. */
  approval?: ApprovalFaceHandlers
  /** NOTICE surface handlers. Omit to leave the surface off (TELEGRAM_NOTICES=0 /
   *  pre-notice daemon). Independent of `approval` ON PURPOSE: silencing approval cards
   *  must never silence the "your peer went mute" channel, and vice versa. */
  notice?: NoticeFaceHandlers
  deps?: FleetClientDeps
  /** Structured logger (evt, fields). Default: no-op. */
  log?: (evt: string, fields?: Record<string, unknown>) => void
  /** Reconnect backoff schedule (ms) by attempt; last value repeats. */
  backoffMs?: number[]
  /** Safety-net re-reconcile interval (ms). Default 60 s. 0 disables. */
  reconcileIntervalMs?: number
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>
  /** This face's start time — the watershed between history and news for notices
   *  (docs/19 obligation 6). Defaults to now; injected by tests. */
  startedMs?: number
}

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10_000, 15_000]

/**
 * The live fleet face. `start()` runs the connect→reconcile→stream→reconnect loop until
 * `stop()`. Its dedup/reconcile logic (ingest/reconcile) is unit-tested directly; the
 * streaming reader is thin over fetch and proven live.
 */
export class FleetFace {
  private readonly base: string
  private readonly approval?: ApprovalFaceHandlers
  private readonly notice?: NoticeFaceHandlers
  private readonly deps: FleetClientDeps
  private readonly log: (evt: string, fields?: Record<string, unknown>) => void
  private readonly backoff: number[]
  private readonly reconcileIntervalMs: number
  private readonly sleep: (ms: number) => Promise<void>
  /** Request ids for which a card is (being) shown — at-most-once render guard. */
  private readonly carded = new Set<string>()
  /** Resolved-event ids already dispatched — at-least-once dedup guard. */
  private readonly resolved = new Set<string>()
  /** Notice ids already sent — at-least-once dedup guard. Released by reconcile once the
   *  id leaves the board, which is what keeps docs/19 obligation 5 (ids are NOT stable
   *  across a daemon restart) from silently swallowing a re-issued `n1`. */
  private readonly noticed = new Set<string>()
  /** This face's own start, the history/news watershed for docs/19 obligation 6. */
  private readonly startedMs: number
  private controller: AbortController | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(opts: FleetFaceOptions) {
    this.base = opts.base
    this.approval = opts.approval
    this.notice = opts.notice
    this.deps = opts.deps ?? {}
    this.log = opts.log ?? (() => {})
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF
    this.reconcileIntervalMs = opts.reconcileIntervalMs ?? 60_000
    this.sleep = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
    this.startedMs = opts.startedMs ?? Date.now()
  }

  /** docs/19 obligation 6: a notice raised at or before this face came up is HISTORY —
   *  the instance we replaced already told the owner about it, and re-announcing it makes
   *  OUR restart into HIS notification. Anything raised after our start is news.
   *
   *  Keyed on the notice's own `createdMs` against our start — the mechanism the contract
   *  prescribes — NOT on "whatever was on the board when I first managed to read it". The
   *  two agree only when that first read is instant. They diverge exactly where it hurts:
   *  if the daemon is not up yet at boot, the face backs off for seconds or minutes, and a
   *  mute raised inside that window IS news the owner must get, yet a first-read seed would
   *  bury it as history. Comparing timestamps is also stateless — no seed flag, no "don't
   *  burn the seed on a failed read" subtlety, and correct across a daemon restart (a
   *  restarted board re-detects and stamps a NEWER createdMs, so live conditions are
   *  delivered rather than suppressed). */
  private isHistory(item: FleetNotice): boolean {
    return item.createdMs <= this.startedMs
  }

  /** Route ONE parsed event `data` object to the right surface's handlers, with dedup.
   *  Pure enough to unit-test: feed it decoded event data, assert the handler calls.
   *  Unknown `src` (lifecycle/delivery/exits/whatever ships next) and unknown `ev` are
   *  ignored (docs/15 obligation 1); a surface with no handlers is inert. */
  async ingest(data: FleetEventData): Promise<void> {
    if (!data.id) return
    if (data.src === 'approvals') await this.ingestApproval(data)
    else if (data.src === 'notices') await this.ingestNotice(data)
    // any other src → ignored (forward-compat)
  }

  private async ingestApproval(data: FleetEventData): Promise<void> {
    if (!this.approval || !data.id) return
    if (data.ev === 'approval-request') {
      await this.showRequest(data.id)
    } else if (data.ev === 'approval-resolved') {
      if (this.resolved.has(data.id)) return
      this.resolved.add(data.id)
      this.carded.delete(data.id)
      await Promise.resolve(
        this.approval.onResolved({
          id: data.id,
          decision: data.decision,
          reason: data.reason,
          by: data.by,
          via: data.via,
        }),
      ).catch(err => this.log('approval.face.onResolved.error', { id: data.id, err: String(err) }))
    }
    // any other ev under src=approvals → ignored (forward-compat)
  }

  /** `notice-raised` is the only event the board emits: a repeat detection of a live
   *  notice bumps count/lastMs in the daemon WITHOUT a new event (docs/19 §5), so there is
   *  nothing here to de-spam — the dedup already happened upstream and re-implementing it
   *  would only risk double-counting. */
  private async ingestNotice(data: FleetEventData): Promise<void> {
    if (!this.notice || !data.id) return
    if (data.ev === 'notice-raised') await this.showNotice(data.id)
    // any other ev under src=notices → ignored (forward-compat)
  }

  /** Fetch the full item and render a card, once per id. Shared by the live stream and
   *  reconcile. A 404 (resolved between hint and GET) is a benign skip. */
  private async showRequest(id: string): Promise<void> {
    if (!this.approval) return
    if (this.carded.has(id) || this.resolved.has(id)) return
    this.carded.add(id) // claim BEFORE the await so a concurrent reconcile can't double-render
    let item: PendingApproval | null
    try {
      item = await getApproval(this.base, id, this.deps)
    } catch (err) {
      this.carded.delete(id) // transient fetch error — allow a later retry (reconcile)
      this.log('approval.face.getApproval.error', { id, err: String(err) })
      return
    }
    if (!item) {
      this.log('approval.face.request.gone', { id }) // 404 — already resolved
      return
    }
    await Promise.resolve(this.approval.onRequest(item)).catch(err => {
      this.log('approval.face.onRequest.error', { id, err: String(err) })
    })
  }

  /** Fetch the full notice and tell the owner, once per id. Shared by the live stream and
   *  reconcile. A 404 (TTL passed between hint and GET) is a benign skip. */
  private async showNotice(id: string): Promise<void> {
    if (!this.notice) return
    if (this.noticed.has(id)) return
    this.noticed.add(id) // claim BEFORE the await so a concurrent reconcile can't double-send
    let item: FleetNotice | null
    try {
      item = await getNotice(this.base, id, this.deps)
    } catch (err) {
      this.noticed.delete(id) // transient fetch error — allow a later retry (reconcile)
      this.log('notice.face.getNotice.error', { id, err: String(err) })
      return
    }
    if (!item) {
      this.log('notice.face.notice.gone', { id }) // 404 — TTL passed
      return
    }
    // The same history watershed as reconcile. A live event (replay=0) is news by
    // construction, so this should never fire here — it is applied anyway so ONE rule
    // decides delivery on BOTH paths and no future replay/backfill can sneak history in.
    if (this.isHistory(item)) {
      this.log('notice.face.seeded', { count: 1, ids: item.id })
      return
    }
    await Promise.resolve(this.notice.onNotice(item)).catch(err => {
      this.log('notice.face.onNotice.error', { id, err: String(err) })
    })
  }

  /** Reconcile every ENABLED surface against its authoritative snapshot (docs/15
   *  obligation 4). Each surface is independent: one failing to read must not skip the
   *  other, so they are awaited separately and each swallows its own transport error. */
  async reconcile(): Promise<void> {
    if (this.approval) await this.reconcileApprovals()
    if (this.notice) await this.reconcileNotices()
  }

  /** Reconcile against the authoritative pending snapshot (docs/15 obligation 4). Renders a
   *  card for any pending id not yet carded; recovers requests that arrived while
   *  disconnected or were missed by an at-least-once gap. */
  private async reconcileApprovals(): Promise<void> {
    if (!this.approval) return
    let pending: PendingApproval[]
    try {
      pending = await listApprovals(this.base, this.deps)
    } catch (err) {
      this.log('approval.face.reconcile.error', { err: String(err) })
      return
    }
    const live = new Set(pending.map(p => p.id))
    for (const item of pending) {
      if (this.carded.has(item.id) || this.resolved.has(item.id)) continue
      this.carded.add(item.id)
      await Promise.resolve(this.approval.onRequest(item)).catch(err =>
        this.log('approval.face.onRequest.error', { id: item.id, err: String(err) }),
      )
    }
    // A carded id no longer pending resolved out-of-band with no event seen — drop the
    // render guard so a future re-use of the id (daemon restart resets its counter) re-cards.
    for (const id of [...this.carded]) if (!live.has(id)) this.carded.delete(id)
  }

  /** Reconcile against the authoritative notice board. Sends any live notice not yet sent
   *  (recovering a raise that landed while we were disconnected mid-life — the owner is
   *  told late rather than never), then RELEASES the guard for every id that has left the
   *  board.
   *
   *  That release is load-bearing, not tidiness: notice ids are in-memory counters and a
   *  daemon restart re-issues `n1` for a DIFFERENT notice (docs/19 obligation 5). Holding
   *  `n1` forever would silently swallow that real one. Within a single board lifetime the
   *  counter only moves forward, so releasing an expired id can never cause a re-send of
   *  the same notice.
   *
   *  Anything raised at or before our own start is SEEDED silently (isHistory, docs/19
   *  obligation 6): the instance we replaced already told the owner, so re-announcing it
   *  turns OUR restart into HIS notification (observed live — the 0.27.0 deploy re-sent all
   *  five live cards). Seeding only pre-fills the dedup guard; the send loop then skips
   *  those of its own accord, so there is no special case on the delivery path.
   *
   *  Approvals are seeded NEVER — deliberately asymmetric. Per docs/19 the discriminator is
   *  not which surface you are but WHETHER ANYTHING IS BLOCKED WAITING ON A HUMAN: a notice
   *  blocks nothing, while an approval holds a peer's tool call against a ≤300 s
   *  default-deny, so a face that starts up and stays quiet about it lets the request time
   *  out into a denial. */
  private async reconcileNotices(): Promise<void> {
    if (!this.notice) return
    let live: FleetNotice[]
    try {
      live = await listNotices(this.base, this.deps)
    } catch (err) {
      this.log('notice.face.reconcile.error', { err: String(err) })
      return
    }
    const ids = new Set(live.map(n => n.id))
    const seeded: string[] = []
    for (const item of live) {
      if (this.noticed.has(item.id)) continue
      this.noticed.add(item.id)
      if (this.isHistory(item)) {
        seeded.push(item.id)
        continue // predates us — the owner already knows; guard it and stay quiet
      }
      await Promise.resolve(this.notice.onNotice(item)).catch(err =>
        this.log('notice.face.onNotice.error', { id: item.id, err: String(err) }),
      )
    }
    if (seeded.length) this.log('notice.face.seeded', { count: seeded.length, ids: seeded.join(',') })
    for (const id of [...this.noticed]) if (!ids.has(id)) this.noticed.delete(id)
  }

  /** Start the loop (idempotent — a second call is a no-op while running). */
  start(): void {
    if (this.running) return
    this.running = true
    this.log('fleet.face.start', { base: this.base, approval: Boolean(this.approval), notice: Boolean(this.notice) })
    if (this.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => void this.reconcile(), this.reconcileIntervalMs)
      this.reconcileTimer.unref?.()
    }
    void this.loop()
  }

  /** Stop the loop and abort the live connection. */
  stop(): void {
    this.running = false
    if (this.reconcileTimer) clearInterval(this.reconcileTimer)
    this.reconcileTimer = null
    this.controller?.abort()
    this.controller = null
    this.log('fleet.face.stop')
  }

  private async loop(): Promise<void> {
    let attempt = 0
    while (this.running) {
      try {
        await this.connectOnce()
        attempt = 0 // a clean stream end (server closed) → reconnect promptly
      } catch (err) {
        this.log('fleet.face.stream.error', { err: String(err), attempt })
      }
      if (!this.running) break
      const delay = this.backoff[Math.min(attempt, this.backoff.length - 1)]!
      attempt++
      await this.sleep(delay)
    }
  }

  /** Open ONE SSE connection: reconcile the snapshot, then read frames until it ends. */
  private async connectOnce(): Promise<void> {
    const doFetch = this.deps.fetch ?? fetch
    const controller = new AbortController()
    this.controller = controller
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    const bearer = (this.deps.env ?? process.env).IAPEER_BEARER_TOKEN?.trim()
    if (bearer) headers.authorization = `Bearer ${bearer}`
    // replay=0: we do NOT want historical lifecycle events replayed at us — a replayed
    // notice-raised from hours ago would re-notify the owner about a wall that has since
    // lifted. The snapshots below are the correct recovery for anything that predates this
    // connection: they carry what is STILL live, which is the only thing worth saying.
    const resp = await doFetch(`${this.base}/fleet/v1/events?replay=0`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    if (!resp.ok || !resp.body) throw new Error(`GET /fleet/v1/events → ${resp.status}`)
    this.log('fleet.face.connected', { base: this.base })
    // Reconcile as soon as the stream is open so nothing pending is missed.
    await this.reconcile()
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { events, rest } = parseSseEvents(buffer)
        buffer = rest
        for (const ev of events) {
          if (ev.data === undefined) continue
          let data: FleetEventData
          try {
            data = JSON.parse(ev.data) as FleetEventData
          } catch {
            continue // non-JSON keep-alive / malformed — ignore
          }
          await this.ingest(data)
        }
      }
    } finally {
      reader.releaseLock?.()
    }
  }
}
