// fleetClient — telegram-runtime's HTTP client to the daemon's Fleet API (docs/15).
// It serves the two owner-facing surfaces the daemon exposes to a FACE:
//
//   • APPROVALS (docs/17) — the single in-daemon approval queue. We OBSERVE pending
//     requests (fleet SSE / snapshot, U2) and ANSWER them (approve/deny) when the owner
//     taps a Telegram button (U3). We NEVER long-poll — the blocking ASK side is the gated
//     peer's `iapeer approval-hook`; a face only reads the queue and posts a resolution.
//   • NOTICES (docs/19) — the notice board: a peer that an API error left ALIVE but unable
//     to speak (exhausted model limit, overload, stale auth). READ-ONLY by contract: a
//     notice is one-way information, there is no POST and nothing to resolve. We render it
//     to the owner and stop.
//
// The two share this transport ON PURPOSE — same listeners, same H8 bearer, same base
// resolution. (Approvals were merely the FIRST surface, which is why this module and
// fleetFace.ts were once named for them.) The transport mirrors iapeer's own reference
// client (src/approval/brokerClient.ts): resolve the base from router.json's `tcp`, carry
// the optional bearer, fail by throwing (the caller decides what a transport failure
// means — for a FACE a failed read is a no-op, never a fail-safe deny; that invariant
// lives in the broker).
//
// Dependency-light on purpose (fetch + a router.json read): the run-loop imports it, but
// it pulls no grammy. Feature-detect is explicit and two-layer — `fleetAvailable()`
// (router.json `fleet:1`) then a live probe per surface (`probeApprovals` /
// `probeNotices`), so against a daemon that predates either surface telegram-runtime
// behaves byte-identically to before it existed.

import { readFileSync } from 'fs'
import { join } from 'path'
import { resolveIapeerRoot } from './manifest.ts'

/** One pending approval as the broker serves it (GET /fleet/v1/approvals[/<id>]).
 *  Mirrors iapeer's `PendingApproval` (src/daemon/approvals.ts). `content` is the FULL
 *  human-readable action (command / diff / plan / breaker prompt) — criterion #7. */
export interface PendingApproval {
  id: string
  personality: string
  runtime: string
  /** taxonomy tag: tool | plan | question | circuit-breaker (free-form-tolerant). */
  kind: string
  /** the specific tool / breaker name, e.g. `Bash`, `Edit`, `dangerous-rm`. */
  tool: string
  /** FULL action content shown to the human. */
  content: string
  /** one-line summary (SSE/badge). */
  summary: string
  /** short header, e.g. "boris · Bash". */
  title: string
  /** nature-peers who may answer (informational — the broker does not gate on it). */
  approvers: string[]
  createdMs: number
  expiresMs: number
}

/** One notice as the board serves it (GET /fleet/v1/notices[/<id>]) — docs/19 §4.
 *  Mirrors iapeer's `FleetNotice` (src/daemon/notices.ts).
 *
 *  THREE fields carry a contract that is easy to get subtly wrong, so they are called out
 *  here rather than only in the renderer:
 *  - `resetsAtMs` is OPTIONAL and its absence is MEANINGFUL: "the runtime did not say
 *    when the wall lifts", NEVER "there is no wall". claude does not expose a per-model
 *    bucket reset at all. The 5h/7d `resets_at` visible in the statusline blob belongs to
 *    a DIFFERENT limit and must never be substituted here (measured live 15.07.2026: the
 *    5h bucket read 11 % and the 7d 66 % while fable was fully exhausted — substituting
 *    either would have told the owner a confident lie). Same rule for `model`.
 *  - `errorType` is FREE-FORM — the runtime's own value (`rate_limit`, `overloaded`,
 *    `rate_limit_reached`, an expired auth, whatever ships next). Never switch on it
 *    exhaustively; render what you were given.
 *  - `id` is NOT stable across a daemon restart (the board is in-memory and re-issues
 *    `n1`, `n2`, … on re-detection), so it may be used as a de-dup key only WITHIN one
 *    board lifetime — see FleetFace's guard-drop on reconcile. */
export interface FleetNotice {
  id: string
  /** the peer that went mute */
  personality: string
  runtime: string
  /** `peer-mute` in v1. Unknown kinds ride this same surface — render them anyway. */
  kind: string
  /** the runtime's OWN error value — free-form, never switched on exhaustively. */
  errorType: string
  /** absent ⇒ the runtime did not name a model (always so on codex). */
  model?: string
  /** epoch-ms; absent ⇒ the runtime did not state a reset ⇒ render "unknown". */
  resetsAtMs?: number
  summary: string
  /** verbatim refusal (claude) / rendered from typed fields (codex). */
  content: string
  sessionId?: string
  createdMs: number
  lastMs: number
  expiresMs: number
  /** distinct OCCURRENCES folded in (>=1) — render as `×N`. The board dedups; a face
   *  must NOT count for itself. */
  count: number
}

/** The resolution POST body a face sends. `approver` is a personality string (audit,
 *  not authz — confirmed with iapeer 2026-07-06); `via` marks the channel. */
export interface ResolveBody {
  approver?: string
  reason?: string
  via?: string
}

export interface FleetClientDeps {
  env?: NodeJS.ProcessEnv
  /** Injectable fetch (tests). Default global fetch. */
  fetch?: typeof fetch
  /** Per-call abort ceiling. These are QUICK reads/posts, NOT the 600 s hook long-poll. */
  timeoutMs?: number
}

/** Quick-call abort ceiling. A face's reads/resolves are sub-second on loopback; this is
 *  only a safety net against a wedged daemon socket. NOT the hook's long-poll ceiling. */
export const FLEET_CALL_TIMEOUT_MS = 15_000

/** `<IAPEER_ROOT>/state/iapeer/router.json` — the daemon's advertised addresses + caps
 *  (mirror of iapeer's pluginStateDir('iapeer')/router.json). */
export function routerJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveIapeerRoot(env), 'state', 'iapeer', 'router.json')
}

interface RouterInfo {
  tcp?: unknown
  fleet?: unknown
  version?: unknown
}

function readRouterInfo(env: NodeJS.ProcessEnv): RouterInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(routerJsonPath(env), 'utf8')) as RouterInfo
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Resolve the daemon fleet base URL (origin-form, no path) from router.json's `tcp`
 *  field (strip the `/mcp` suffix), else the well-known loopback default. TCP loopback is
 *  always served (the daemon dual-listens), so a client never needs the unix socket. */
export function resolveFleetBase(env: NodeJS.ProcessEnv = process.env): string {
  const info = readRouterInfo(env)
  if (info && typeof info.tcp === 'string' && info.tcp) return info.tcp.replace(/\/mcp\/?$/, '')
  const port = env.IAPEER_PORT?.trim() || '8765'
  return `http://127.0.0.1:${port}`
}

/** STATIC feature-detect (docs/15): the daemon advertises `fleet:1` in router.json when
 *  it serves the Fleet API (which carries the approval surface, docs/17). Absent ⇒
 *  pre-fleet/pre-approval daemon ⇒ the approval face must not start. A `200` from
 *  `GET /fleet/v1/approvals` (probeApprovals) is the runtime confirmation on top of this. */
export function fleetAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return readRouterInfo(env)?.fleet === 1
}

function headers(env: NodeJS.ProcessEnv): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  const bearer = env.IAPEER_BEARER_TOKEN?.trim()
  if (bearer) h.authorization = `Bearer ${bearer}`
  return h
}

async function fleetFetch(
  url: string,
  init: RequestInit,
  deps: FleetClientDeps,
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? FLEET_CALL_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()
  try {
    return await doFetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export const APPROVALS_PATH = '/fleet/v1/approvals'
export const NOTICES_PATH = '/fleet/v1/notices'

/** What a live probe learned about one fleet surface. THREE-VALUED ON PURPOSE — collapsing
 *  it to a boolean is a trap:
 *  - `absent`     the daemon ANSWERED and does not serve this surface (a pre-0.4.94 daemon
 *                 404s /notices). Definitive: it cannot start serving it without a daemon
 *                 restart, which restarts us too. Safe to disable the surface.
 *  - `unreachable` nobody answered. This says NOTHING about the surface — most often it
 *                 means the daemon is not listening YET. router.json is only removed on a
 *                 GRACEFUL close, so after a reboot or a SIGKILL a stale `fleet:1` file
 *                 outlives the daemon, and a runtime that boots first sees exactly this.
 *                 Disabling on it would kill the surface for the whole process lifetime;
 *                 the face's reconnect loop heals it instead. */
export type SurfaceState = 'live' | 'absent' | 'unreachable'

/** Live-probe ONE fleet surface. See SurfaceState for why the transport failure is a
 *  distinct answer rather than a false. */
export async function probeSurface(
  base: string,
  path: string,
  deps: FleetClientDeps = {},
): Promise<SurfaceState> {
  const env = deps.env ?? process.env
  try {
    const resp = await fleetFetch(`${base}${path}`, { method: 'GET', headers: headers(env) }, deps)
    return resp.ok ? 'live' : 'absent'
  } catch {
    return 'unreachable'
  }
}

/** RUNTIME feature-detect: `GET /fleet/v1/approvals` → 200 confirms the approval surface
 *  is live (a pre-approval daemon 404s). Returns false on any non-200 / transport error.
 *  The BOOLEAN form is for the one-shot CLI commands, where "cannot reach it" and "not
 *  served" are equally a no-op; a long-lived face must use probeSurface and distinguish. */
export async function probeApprovals(base: string, deps: FleetClientDeps = {}): Promise<boolean> {
  return (await probeSurface(base, APPROVALS_PATH, deps)) === 'live'
}

/** GET /fleet/v1/approvals → all pending requests (full items). The RECONCILING snapshot
 *  the face fetches on connect/reconnect (docs/15 obligation 4: snapshot=state). THROWS on
 *  transport failure / non-200 (the caller — the face loop — logs and retries). */
export async function listApprovals(base: string, deps: FleetClientDeps = {}): Promise<PendingApproval[]> {
  const env = deps.env ?? process.env
  const resp = await fleetFetch(`${base}/fleet/v1/approvals`, { method: 'GET', headers: headers(env) }, deps)
  if (!resp.ok) throw new Error(`GET /fleet/v1/approvals → ${resp.status}`)
  const data = (await resp.json()) as { approvals?: unknown }
  return Array.isArray(data.approvals) ? (data.approvals as PendingApproval[]) : []
}

/** GET /fleet/v1/approvals/<id> → one pending item with FULL content (criterion #7).
 *  Returns null on 404 — the broker deletes an item from `pending` on settle, so a
 *  request resolved (CLI / tray / timeout) between the SSE hint and this GET is a 404 =
 *  "already resolved, skip" (confirmed with iapeer). THROWS on other non-200. */
export async function getApproval(
  base: string,
  id: string,
  deps: FleetClientDeps = {},
): Promise<PendingApproval | null> {
  const env = deps.env ?? process.env
  const resp = await fleetFetch(
    `${base}/fleet/v1/approvals/${encodeURIComponent(id)}`,
    { method: 'GET', headers: headers(env) },
    deps,
  )
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`GET /fleet/v1/approvals/${id} → ${resp.status}`)
  const data = (await resp.json()) as { approval?: PendingApproval }
  return data.approval ?? null
}

// ── Notices (docs/19) — READ-ONLY: there is no POST on this surface by contract ──

/** RUNTIME feature-detect for the notice board: `GET /fleet/v1/notices` → 200. A daemon
 *  that predates notices (< 0.4.94) serves the fleet API but 404s here — so `fleet:1` in
 *  router.json is NOT sufficient and this probe is the second gate. Boolean form for the
 *  CLI; the face uses probeSurface (see SurfaceState). */
export async function probeNotices(base: string, deps: FleetClientDeps = {}): Promise<boolean> {
  return (await probeSurface(base, NOTICES_PATH, deps)) === 'live'
}

/** GET /fleet/v1/notices → the live board. The RECONCILING snapshot (docs/15 obligation 4:
 *  snapshot=state, events are hints). An ABSENT `notices` field means an EMPTY board — the
 *  daemon omits it when nothing is live (docs/19 client obligation 3), which is exactly
 *  what `Array.isArray` short-circuits to []. THROWS on transport failure / non-200. */
export async function listNotices(base: string, deps: FleetClientDeps = {}): Promise<FleetNotice[]> {
  const env = deps.env ?? process.env
  const resp = await fleetFetch(`${base}/fleet/v1/notices`, { method: 'GET', headers: headers(env) }, deps)
  if (!resp.ok) throw new Error(`GET /fleet/v1/notices → ${resp.status}`)
  const data = (await resp.json()) as { notices?: unknown }
  return Array.isArray(data.notices) ? (data.notices as FleetNotice[]) : []
}

/** GET /fleet/v1/notices/<id> → one notice with its FULL `content` + `count`, neither of
 *  which rides the SSE event. Returns null on 404 — a notice whose TTL passed between the
 *  event and this GET is simply gone (nothing to show, nothing to resolve). THROWS on
 *  other non-200. */
export async function getNotice(
  base: string,
  id: string,
  deps: FleetClientDeps = {},
): Promise<FleetNotice | null> {
  const env = deps.env ?? process.env
  const resp = await fleetFetch(
    `${base}/fleet/v1/notices/${encodeURIComponent(id)}`,
    { method: 'GET', headers: headers(env) },
    deps,
  )
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`GET /fleet/v1/notices/${id} → ${resp.status}`)
  const data = (await resp.json()) as { notice?: FleetNotice }
  return data.notice ?? null
}

export type ResolveOutcome = 'ok' | 'gone'

/** POST /fleet/v1/approvals/<id>/(approve|deny) — answer a request from the Telegram face.
 *  Returns 'gone' on 404 (already resolved elsewhere / expired / unknown — the caller tells
 *  the user "already handled"), 'ok' on success. THROWS on other non-200 / transport error. */
export async function resolveApproval(
  base: string,
  id: string,
  action: 'approve' | 'deny',
  body: ResolveBody,
  deps: FleetClientDeps = {},
): Promise<ResolveOutcome> {
  const env = deps.env ?? process.env
  const resp = await fleetFetch(
    `${base}/fleet/v1/approvals/${encodeURIComponent(id)}/${action}`,
    { method: 'POST', headers: headers(env), body: JSON.stringify({ ...body, via: body.via ?? 'telegram' }) },
    deps,
  )
  if (resp.status === 404) return 'gone'
  if (!resp.ok) throw new Error(`POST /fleet/v1/approvals/${id}/${action} → ${resp.status}`)
  return 'ok'
}
