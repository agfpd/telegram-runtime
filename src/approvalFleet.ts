// approvalFleet — telegram-runtime's client to the daemon's human-approval broker
// (docs/17). telegram-runtime is a FACE on the single in-daemon approval queue: it
// OBSERVES pending requests (via the fleet SSE stream / snapshot, U2) and ANSWERS them
// (approve/deny) when the owner taps a Telegram button (U3). It NEVER long-polls — the
// blocking ASK side is the gated peer's `iapeer approval-hook`; a face only reads the
// queue and posts a resolution.
//
// This is the FIRST integration of telegram-runtime with the daemon's Fleet-HTTP surface
// (docs/15) — until now the runtime only shelled out to `iapeer send` and polled Telegram.
// The transport mirrors iapeer's own reference client (src/approval/brokerClient.ts):
// resolve the base from router.json's `tcp`, carry the optional H8 bearer, fail by
// throwing (the caller decides what a transport failure means — for a FACE a failed
// read/resolve is a no-op, never a fail-safe deny; that invariant lives in the broker).
//
// Dependency-light on purpose (fetch + a router.json read): the run-loop imports it, but
// it pulls no grammy. Feature-detect is explicit — `fleetAvailable()` (router.json
// `fleet:1`) gates whether the approval face starts at all, so on a pre-approval daemon
// telegram-runtime behaves byte-identically to today.

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

/** RUNTIME feature-detect: `GET /fleet/v1/approvals` → 200 confirms the approval surface
 *  is live (a pre-approval daemon 404s). Returns false on any non-200 / transport error —
 *  the face stays down rather than crash-looping against a daemon that can't serve it. */
export async function probeApprovals(base: string, deps: FleetClientDeps = {}): Promise<boolean> {
  const env = deps.env ?? process.env
  try {
    const resp = await fleetFetch(`${base}/fleet/v1/approvals`, { method: 'GET', headers: headers(env) }, deps)
    return resp.ok
  } catch {
    return false
  }
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
