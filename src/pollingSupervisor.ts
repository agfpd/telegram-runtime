import type { Bot } from 'grammy'

export type PollingLog = (event: string, fields?: Record<string, unknown>) => void

export type PollingStall = {
  botKey: string
  generation: number
  seq: number
  phase: 'long-poll'
  ageMs: number
  deadlineMs: number
}

type FetchInput = string | URL | Request
export type FetchLike = (input: FetchInput, init?: RequestInit) => Promise<Response>

export type GuardedPollingFetch = {
  fetch: FetchLike
  stalled: Promise<PollingStall>
  healthy: Promise<void>
}

export type PollingFetchOptions = {
  botKey: string
  generation: number
  fetch: FetchLike
  log: PollingLog
  stallMs: number
  stopStallMs: number
  heartbeatMs: number
  now?: () => number
  recoveryMs?: number
}

class PollingDeadlineError extends Error {
  constructor(readonly stall: PollingStall) {
    super(`Telegram getUpdates stalled for ${stall.ageMs} ms (deadline ${stall.deadlineMs} ms)`)
    this.name = 'PollingDeadlineError'
  }
}

function isGetUpdates(input: FetchInput): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return /\/getUpdates(?:\?|$)/i.test(url)
}

function getUpdatesPhase(init?: RequestInit): 'long-poll' | 'stop-confirm' {
  if (typeof init?.body !== 'string') return 'long-poll'
  try {
    const payload = JSON.parse(init.body) as { limit?: unknown; timeout?: unknown }
    // grammY's Bot.stop() confirms the current offset with a final limit=1,
    // timeout-less getUpdates. It is not a polling heartbeat and must not
    // recursively request another bot-generation restart if the transport is
    // already unhealthy.
    if (payload.limit === 1 && payload.timeout === undefined) return 'stop-confirm'
  } catch {
    // Unknown payload shape: guard it as an ordinary long poll. Failing closed
    // preserves the liveness boundary if grammY changes its JSON encoder.
  }
  return 'long-poll'
}

function bufferedResponse(response: Response, bytes: Uint8Array): Response {
  const body =
    response.status === 204 || response.status === 205 || response.status === 304
      ? null
      : (bytes.slice().buffer as ArrayBuffer)
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function telegramUpdateCount(bytes: Uint8Array): number | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { ok?: unknown; result?: unknown }
    return value.ok === true && Array.isArray(value.result) ? value.result.length : null
  } catch {
    return null
  }
}

function safeErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  // Telegram puts the bot token in the URL path. Some fetch implementations
  // include that URL in transport errors; observability must never copy the
  // credential into the runtime log.
  return detail.replace(/\/bot[^/\s]+\//gi, '/bot<redacted>/')
}

/**
 * Wraps the fetch used by one grammY Bot generation.
 *
 * Only getUpdates is guarded. Outbound API methods deliberately pass straight
 * through, so a stuck inbound long poll cannot serialize or disable outbound.
 * A successful response is fully buffered inside the deadline: `fetch()` can
 * resolve after headers while its body remains stuck, and grammY awaits
 * `response.json()` outside a custom fetch implementation.
 *
 * The deadline is a Promise.race in addition to AbortController. That is
 * intentional: the production failure we defend against is precisely a
 * transport promise that may ignore or fail to observe cancellation.
 */
export function createGuardedPollingFetch(options: PollingFetchOptions): GuardedPollingFetch {
  const now = options.now ?? Date.now
  let seq = 0
  let settledStall = false
  let resolveStall!: (stall: PollingStall) => void
  const stalled = new Promise<PollingStall>(resolve => {
    resolveStall = resolve
  })
  let resolveHealthy!: () => void
  const healthy = new Promise<void>(resolve => { resolveHealthy = resolve })
  let healthySince: number | undefined
  let healthyCycles = 0

  let heartbeatAt = 0
  let heartbeatWindowStartedAt = now()
  let cycles = 0
  let emptyCycles = 0
  let updates = 0
  let errors = 0
  let maxCycleMs = 0
  let lastErrorLogAt = 0

  const reportError = (error: unknown, requestSeq: number, startedAt: number): void => {
    healthySince = undefined
    healthyCycles = 0
    errors++
    const at = now()
    // A disconnected host can fail every three seconds via grammY's retry
    // loop. Emit immediately, then at most once a minute per generation.
    if (lastErrorLogAt === 0 || at - lastErrorLogAt >= 60_000) {
      options.log('poll.error', {
        botKey: options.botKey,
        generation: options.generation,
        seq: requestSeq,
        ageMs: Math.max(0, at - startedAt),
        detail: safeErrorDetail(error),
      })
      lastErrorLogAt = at
    }
  }

  const emitHeartbeat = (cycleMs: number): void => {
    const at = now()
    healthySince ??= at
    healthyCycles++
    if (healthyCycles >= 3 && at - healthySince >= (options.recoveryMs ?? 120_000)) resolveHealthy()
    cycles++
    maxCycleMs = Math.max(maxCycleMs, cycleMs)
    if (heartbeatAt !== 0 && at - heartbeatAt < options.heartbeatMs) return
    options.log('poll.heartbeat', {
      botKey: options.botKey,
      generation: options.generation,
      seq,
      cycles,
      emptyCycles,
      updates,
      errors,
      windowMs: at - heartbeatWindowStartedAt,
      lastCycleMs: cycleMs,
      maxCycleMs,
    })
    heartbeatAt = at
    heartbeatWindowStartedAt = at
    cycles = 0
    emptyCycles = 0
    updates = 0
    errors = 0
    maxCycleMs = 0
  }

  const guardedFetch: FetchLike = async (input, init) => {
    if (!isGetUpdates(input)) return options.fetch(input, init)

    const phase = getUpdatesPhase(init)
    const requestSeq = ++seq
    const startedAt = now()
    const deadlineMs = phase === 'stop-confirm' ? options.stopStallMs : options.stallMs
    const controller = new AbortController()
    const parentSignal = init?.signal
    let timeout: ReturnType<typeof setTimeout> | undefined
    let removeParentAbort: (() => void) | undefined

    type Outcome = { response: Response; bytes: Uint8Array }
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const ageMs = Math.max(0, now() - startedAt)
        controller.abort(new DOMException('Telegram getUpdates deadline exceeded', 'TimeoutError'))
        if (phase === 'long-poll') {
          const stall: PollingStall = {
            botKey: options.botKey,
            generation: options.generation,
            seq: requestSeq,
            phase,
            ageMs,
            deadlineMs,
          }
          options.log('poll.stalled', stall)
          if (!settledStall) {
            settledStall = true
            resolveStall(stall)
          }
          reject(new PollingDeadlineError(stall))
        } else {
          options.log('poll.stop-stalled', {
            botKey: options.botKey,
            generation: options.generation,
            seq: requestSeq,
            ageMs,
            deadlineMs,
          })
          reject(new Error(`Telegram stop-confirm getUpdates stalled for ${ageMs} ms`))
        }
      }, deadlineMs)
    })

    const parentAbort = new Promise<never>((_, reject) => {
      if (!parentSignal) return
      const abort = () => {
        const reason = parentSignal.reason ?? new DOMException('Aborted', 'AbortError')
        controller.abort(reason)
        reject(reason)
      }
      if (parentSignal.aborted) abort()
      else {
        parentSignal.addEventListener('abort', abort, { once: true })
        removeParentAbort = () => parentSignal.removeEventListener('abort', abort)
      }
    })

    // Buffer the body before returning it to grammY. Keep a catch attached even
    // after the deadline wins: a cancellation-ignoring transport may settle
    // much later, and must not become an unhandled rejection.
    const operation: Promise<Outcome> = Promise.resolve()
      .then(() => options.fetch(input, { ...(init ?? {}), signal: controller.signal }))
      .then(async response => ({ response, bytes: new Uint8Array(await response.arrayBuffer()) }))
    void operation.catch(() => {})

    try {
      const { response, bytes } = await Promise.race([operation, deadline, parentAbort])
      const cycleMs = Math.max(0, now() - startedAt)
      if (phase === 'long-poll') {
        const count = telegramUpdateCount(bytes)
        if (count === null) {
          reportError(new Error('getUpdates returned an unsuccessful or invalid Bot API response'), requestSeq, startedAt)
        } else {
          if (count === 0) emptyCycles++
          else updates += count
          emitHeartbeat(cycleMs)
        }
      }
      return bufferedResponse(response, bytes)
    } catch (error) {
      if (phase === 'long-poll' && !(error instanceof PollingDeadlineError) && !parentSignal?.aborted) {
        reportError(error, requestSeq, startedAt)
      }
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
      removeParentAbort?.()
    }
  }

  return { fetch: guardedFetch, stalled, healthy }
}

export type PollingBot<TInfo> = {
  start(options: { timeout?: number; onStart?: (info: TInfo) => void | Promise<void> }): Promise<void>
  stop(): Promise<void>
}

export type PollingGeneration<TBot> = {
  bot: TBot
  stalled: Promise<PollingStall>
  healthy?: Promise<void>
}

/** Jitter prevents all bots retrying together after a shared network outage. */
export function pollingRetryDelayMs(attempt: number, random = Math.random): number {
  const base = Math.min(5000 * 2 ** Math.min(Math.max(attempt - 1, 0), 4), 60_000)
  return Math.round(base * (0.8 + random() * 0.2))
}

/**
 * Bot.start() retries getMe/deleteWebhook internally, BEFORE onStart or the
 * first getUpdates. In grammY 1.44.0 its ms backoff is passed to sleep(seconds),
 * so a disconnected bootstrap can go silent for hours. Own that retry at the
 * supervisor layer instead. This must wrap the API transformer (not fetch):
 * grammY converts fetch errors back into retryable HttpError instances.
 */
export function guardPollingBootstrap(
  bot: Pick<Bot, 'api'>,
  options: { botKey: string; generation: number; timeoutMs: number; log: PollingLog },
): void {
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method !== 'getMe' && method !== 'deleteWebhook') return prev(method, payload, signal)
    const startedAt = Date.now()
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => prev(method, payload, controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            reject(new Error(`bootstrap exceeded ${options.timeoutMs} ms`))
            controller.abort()
          }, options.timeoutMs)
        }),
      ])
      // prev returns the raw Bot API response. callApi would otherwise turn
      // a 5xx/429 response into GrammyError OUTSIDE this transformer.
      if (!result.ok) throw new Error(`Bot API ${result.error_code}: ${result.description}`)
      return result
    } catch (error) {
      const detail = safeErrorDetail(error)
      options.log('poll.bootstrap.error', {
        botKey: options.botKey,
        generation: options.generation,
        method,
        ageMs: Date.now() - startedAt,
        timedOut,
        detail,
      })
      // Deliberately NOT HttpError/GrammyError: bypass withRetries. A failed
      // generation is retried by supervisePolling with bounded, visible delay.
      throw new Error(`Telegram bootstrap ${method} failed: ${detail}`)
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  })
}

export type PollingSupervisorOptions<TBot extends PollingBot<TInfo>, TInfo> = {
  botKey: string
  pollTimeoutSeconds: number
  initial?: PollingGeneration<TBot>
  makeGeneration: (generation: number) => PollingGeneration<TBot>
  publish: (bot: TBot, generation: number) => void
  onStart: (info: TInfo, generation: number) => void | Promise<void>
  log: PollingLog
  signal?: AbortSignal
  retryDelayMs?: (attempt: number) => number
  stopWaitMs?: number
  startupWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

type SupervisorOutcome =
  | { kind: 'stopped' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'stalled'; stall: PollingStall }
  | { kind: 'aborted' }
  | { kind: 'startup-timeout' }

/** Supervises bootstrap AND polling; an unfenceable generation is process-fatal. */
export async function supervisePolling<TBot extends PollingBot<TInfo>, TInfo>(
  options: PollingSupervisorOptions<TBot, TInfo>,
): Promise<void> {
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    if (options.signal?.aborted) done()
    else options.signal?.addEventListener('abort', done, { once: true })
  }))
  const retryDelayMs = options.retryDelayMs ?? pollingRetryDelayMs
  const stopWaitMs = options.stopWaitMs ?? 15_000
  const startupWaitMs = options.startupWaitMs ?? 35_000
  let generation = 0
  let attempt = 0
  let initial = options.initial

  let onAbort!: () => void
  const aborted = new Promise<SupervisorOutcome>(resolve => {
    onAbort = () => resolve({ kind: 'aborted' })
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    while (!options.signal?.aborted) {
      const currentGeneration = ++generation
      const current = initial ?? options.makeGeneration(generation)
      initial = undefined
      options.publish(current.bot, generation)
      let started = false
      let active = true
      void current.healthy?.then(() => {
        if (!active) return
        if (attempt > 0) options.log('poll.recovered', { botKey: options.botKey, generation: currentGeneration, failures: attempt })
        attempt = 0
      })
      let startupTimer: ReturnType<typeof setTimeout> | undefined
      const startupDeadline = new Promise<SupervisorOutcome>(resolve => {
        startupTimer = setTimeout(() => resolve({ kind: 'startup-timeout' }), startupWaitMs)
      })
      options.log('poll.boot', { botKey: options.botKey, generation })
      const run = Promise.resolve()
        .then(() => current.bot.start({
          timeout: options.pollTimeoutSeconds,
          onStart: async info => {
            if (!active) throw new Error('Retired polling generation tried to start')
            started = true
            options.log('poll.start', { botKey: options.botKey, generation: currentGeneration })
            await options.onStart(info, currentGeneration)
            if (!active) throw new Error('Retired polling generation completed startup')
            if (startupTimer) clearTimeout(startupTimer)
          },
        }))
        .then<SupervisorOutcome>(() => ({ kind: 'stopped' }))
        .catch<SupervisorOutcome>(error => ({ kind: 'failed', error }))

      const outcome = await Promise.race<SupervisorOutcome>([
        run,
        current.stalled.then(stall => ({ kind: 'stalled', stall })),
        startupDeadline,
        aborted,
      ])
      active = false
      if (startupTimer) clearTimeout(startupTimer)

      if (outcome.kind === 'aborted') {
        await boundedWait(current.bot.stop().catch(() => {}), stopWaitMs)
        return
      }
      if (outcome.kind === 'failed' || outcome.kind === 'stopped') {
        attempt++
        const delayMs = retryDelayMs(attempt)
        options.log('poll.failed', {
          botKey: options.botKey,
          generation,
          started,
          detail: outcome.kind === 'failed' ? safeErrorDetail(outcome.error) : 'Polling stopped unexpectedly',
          retryInMs: delayMs,
        })
        options.log('poll.degraded', { botKey: options.botKey, generation, attempt, reason: outcome.kind, retryInMs: delayMs })
        await Promise.race([sleep(delayMs), aborted])
        continue
      }

      if (outcome.kind === 'startup-timeout') {
        options.log('poll.start.timeout', { botKey: options.botKey, generation, timeoutMs: startupWaitMs })
      }

      const restartStartedAt = Date.now()
      let stopOk = true
      let stopped = false
      const stop = current.bot.stop().catch(error => {
        stopOk = false
        options.log('poll.stop.error', {
          botKey: options.botKey,
          generation,
          detail: safeErrorDetail(error),
        })
      })
      const fenced = Promise.allSettled([stop, run]).then(() => {
        stopped = true
      })
      await boundedWait(fenced, stopWaitMs)
      if (!stopped) {
        stopOk = false
        options.log('poll.stop.timeout', { botKey: options.botKey, generation, timeoutMs: stopWaitMs })
        // Starting another generation while this one can still receive updates
        // risks duplicate pollers and lost/duplicated delivery. Let launchd heal
        // the whole process rather than pretending the old poller was fenced.
        options.log('poll.fatal', { botKey: options.botKey, generation, reason: 'generation-not-fenced' })
        throw new Error(`Telegram polling ${options.botKey} generation ${generation} could not be fenced`)
      }
      options.log('poll.restart', {
        botKey: options.botKey,
        fromGeneration: generation,
        toGeneration: generation + 1,
        reason: outcome.kind,
        stalledSeq: outcome.kind === 'stalled' ? outcome.stall.seq : undefined,
        stopOk,
        ms: Date.now() - restartStartedAt,
      })
      // Fence first, then back off. A successful bootstrap is not recovery:
      // only sustained completed getUpdates cycles clear the failure streak.
      attempt++
      const delayMs = retryDelayMs(attempt)
      options.log('poll.degraded', { botKey: options.botKey, generation, attempt, reason: outcome.kind, retryInMs: delayMs })
      await Promise.race([sleep(delayMs), aborted])
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}

async function boundedWait(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([operation, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Minimal grammY surface the cursor needs (kept structural for tests). */
export type CursorBot = {
  api: { config: { use(transformer: (prev: any, method: string, payload: any, signal?: any) => any): void } }
  use(middleware: (ctx: { update: { update_id: number } }, next: () => Promise<void>) => unknown): unknown
}

export type PollingCursor = {
  /** Highest update_id a generation of this bot has started handling (0 = none). */
  readonly lastTried: number
  /** Install on a fresh generation BEFORE any other middleware. */
  install(bot: CursorBot): void
}

/**
 * Per-bot update cursor that survives polling generations.
 *
 * grammY keeps its offset (`lastTriedUpdateId`) on the Bot instance, and a
 * new generation starts at 0 → `getUpdates(offset=1)`. When the old
 * generation died before Telegram applied its offset (next long poll and the
 * stop-confirm both lost), the server still holds the handled updates and
 * the new generation re-delivers them: one inbound message reaches the peer
 * twice. The cursor records each update_id as handling starts (same point
 * grammY records it) and raises every outgoing getUpdates offset to at least
 * lastTried + 1. Same at-most-once semantics as a single long-lived Bot.
 */
export function createPollingCursor(): PollingCursor {
  let lastTried = 0
  return {
    get lastTried() { return lastTried },
    install(bot) {
      bot.api.config.use((prev, method, payload, signal) => {
        if (method === 'getUpdates' && lastTried > 0) {
          const offset = typeof payload?.offset === 'number' ? payload.offset : 0
          if (offset <= lastTried) payload = { ...payload, offset: lastTried + 1 }
        }
        return prev(method, payload, signal)
      })
      bot.use((ctx, next) => {
        const id = ctx.update?.update_id
        if (Number.isSafeInteger(id) && id > lastTried) lastTried = id
        return next()
      })
    },
  }
}
