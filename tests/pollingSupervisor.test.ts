import { describe, expect, test } from 'bun:test'
import { Bot } from 'grammy'
import {
  createGuardedPollingFetch,
  supervisePolling,
  type FetchLike,
  type PollingGeneration,
  type PollingStall,
} from '../src/pollingSupervisor.ts'

function telegramResponse(result: unknown): Response {
  return Response.json({ ok: true, result })
}

describe('per-bot polling liveness', () => {
  test('healthy empty long polls emit an aggregated heartbeat distinct from updates', async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = []
    const results: unknown[][] = [[], [], [{ update_id: 7 }, { update_id: 8 }]]
    let now = 1_000
    const guarded = createGuardedPollingFetch({
      botKey: 'alpha_bot',
      generation: 1,
      fetch: async () => telegramResponse(results.shift()!),
      log: (event, fields = {}) => events.push({ event, fields }),
      stallMs: 1000,
      stopStallMs: 100,
      heartbeatMs: 100_000,
      now: () => now,
    })
    const init = { method: 'POST', body: JSON.stringify({ offset: 1, timeout: 30 }) }

    expect(await (await guarded.fetch('https://api.telegram.org/botTOKEN/getUpdates', init)).json()).toEqual({
      ok: true,
      result: [],
    })
    now += 30_000
    await guarded.fetch('https://api.telegram.org/botTOKEN/getUpdates', init)
    now += 80_000
    await guarded.fetch('https://api.telegram.org/botTOKEN/getUpdates', init)

    const heartbeats = events.filter(event => event.event === 'poll.heartbeat')
    expect(heartbeats).toHaveLength(2)
    expect(heartbeats[0].fields).toMatchObject({
      botKey: 'alpha_bot',
      generation: 1,
      cycles: 1,
      emptyCycles: 1,
      updates: 0,
    })
    expect(heartbeats[1].fields).toMatchObject({
      cycles: 2,
      emptyCycles: 1,
      updates: 2,
    })
  })

  test('a cancellation-ignoring stuck getUpdates trips the deadline while outbound stays usable', async () => {
    const events: Array<{ event: string; fields: Record<string, unknown> }> = []
    const never = new Promise<Response>(() => {})
    const guarded = createGuardedPollingFetch({
      botKey: 'stuck_bot',
      generation: 3,
      fetch: async input => {
        const url = String(input)
        return url.endsWith('/getUpdates') ? never : telegramResponse({ message_id: 42 })
      },
      log: (event, fields = {}) => events.push({ event, fields }),
      stallMs: 20,
      stopStallMs: 10,
      heartbeatMs: 1000,
    })

    const polling = guarded.fetch('https://api.telegram.org/botTOKEN/getUpdates', {
      method: 'POST',
      body: JSON.stringify({ offset: 1, timeout: 30 }),
    })
    // The getUpdates promise is still pending, but another method is neither
    // queued behind it nor subject to the inbound polling deadline.
    const outbound = await guarded.fetch('https://api.telegram.org/botTOKEN/sendMessage', {
      method: 'POST',
      body: JSON.stringify({ chat_id: 1, text: 'still works' }),
    })
    expect(await outbound.json()).toEqual({ ok: true, result: { message_id: 42 } })

    const stall = await guarded.stalled
    expect(stall).toMatchObject({ botKey: 'stuck_bot', generation: 3, seq: 1, phase: 'long-poll' })
    await expect(polling).rejects.toThrow('getUpdates stalled')
    expect(events.filter(event => event.event === 'poll.stalled')).toHaveLength(1)
    expect(events.some(event => event.event === 'poll.heartbeat')).toBe(false)
  })

  test('a stalled generation is stopped and replaced without restarting other bots', async () => {
    type Info = { username: string }
    type FakeBot = {
      generation: number
      starts: number
      stops: number
      start(options: { timeout?: number; onStart?: (info: Info) => void | Promise<void> }): Promise<void>
      stop(): Promise<void>
    }

    const controller = new AbortController()
    const events: Array<{ event: string; fields: Record<string, unknown> }> = []
    const bots: FakeBot[] = []
    const published: number[] = []

    const makeGeneration = (generation: number): PollingGeneration<FakeBot> => {
      let resolveRun!: () => void
      let resolveStall!: (stall: PollingStall) => void
      const stalled = new Promise<PollingStall>(resolve => {
        resolveStall = resolve
      })
      const bot: FakeBot = {
        generation,
        starts: 0,
        stops: 0,
        async start(options) {
          this.starts++
          await options.onStart?.({ username: `bot_${generation}` })
          if (generation === 1) {
            setTimeout(
              () =>
                resolveStall({
                  botKey: 'stuck_bot',
                  generation,
                  seq: 9,
                  phase: 'long-poll',
                  ageMs: 20,
                  deadlineMs: 20,
                }),
              5,
            )
          } else {
            controller.abort()
          }
          return new Promise<void>(resolve => {
            resolveRun = resolve
          })
        },
        async stop() {
          this.stops++
          resolveRun?.()
        },
      }
      bots.push(bot)
      return { bot, stalled }
    }

    await supervisePolling<FakeBot, Info>({
      botKey: 'stuck_bot',
      pollTimeoutSeconds: 30,
      makeGeneration,
      publish: bot => published.push(bot.generation),
      onStart: () => {},
      log: (event, fields = {}) => events.push({ event, fields }),
      signal: controller.signal,
      retryDelayMs: () => 0,
      stopWaitMs: 100,
    })

    expect(published).toEqual([1, 2])
    expect(bots[0]).toMatchObject({ generation: 1, starts: 1, stops: 1 })
    expect(bots[1]).toMatchObject({ generation: 2, starts: 1, stops: 1 })
    expect(events.find(event => event.event === 'poll.restart')?.fields).toMatchObject({
      botKey: 'stuck_bot',
      fromGeneration: 1,
      toGeneration: 2,
      stalledSeq: 9,
      stopOk: true,
    })
  })

  test('grammY integration: never-settling transport is replaced and its Bot API stays outbound-capable', async () => {
    type Info = Awaited<ReturnType<Bot['api']['getMe']>>
    const controller = new AbortController()
    const events: Array<{ event: string; fields: Record<string, unknown> }> = []
    const generations: number[] = []
    let currentBot: Bot | undefined
    let outboundMessageId: number | undefined

    const telegramFetch = (generation: number): FetchLike => async (input, init) => {
      const url = String(input)
      if (url.endsWith('/getMe')) {
        return telegramResponse({
          id: 1,
          is_bot: true,
          first_name: 'Probe',
          username: 'probe_bot',
          can_join_groups: false,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        })
      }
      if (url.endsWith('/deleteWebhook')) return telegramResponse(true)
      if (url.endsWith('/sendMessage')) return telegramResponse({ message_id: 77, date: 1, chat: { id: 1, type: 'private' } })
      if (!url.endsWith('/getUpdates')) throw new Error(`unexpected API method: ${url}`)

      const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
      if (payload.limit === 1 && payload.timeout === undefined) return telegramResponse([])
      if (generation === 1) return new Promise<Response>(() => {}) // deliberately ignores AbortSignal
      return new Promise<Response>((_, reject) => {
        const abort = () => reject(init?.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        if (init?.signal?.aborted) abort()
        else init?.signal?.addEventListener('abort', abort, { once: true })
      })
    }

    const makeGeneration = (generation: number): PollingGeneration<Bot> => {
      const guarded = createGuardedPollingFetch({
        botKey: 'probe_bot',
        generation,
        fetch: telegramFetch(generation),
        log: (event, fields = {}) => events.push({ event, fields }),
        stallMs: 20,
        stopStallMs: 10,
        heartbeatMs: 1000,
      })
      const bot = new Bot('1:probe', { client: { fetch: guarded.fetch as typeof fetch } })
      return { bot, stalled: guarded.stalled }
    }

    await supervisePolling<Bot, Info>({
      botKey: 'probe_bot',
      pollTimeoutSeconds: 30,
      makeGeneration,
      publish: (bot, generation) => {
        currentBot = bot
        generations.push(generation)
      },
      onStart: async (_info, generation) => {
        if (generation === 1) {
          const sent = await currentBot!.api.sendMessage(1, 'outbound during stuck inbound')
          outboundMessageId = sent.message_id
        } else {
          controller.abort()
        }
      },
      log: (event, fields = {}) => events.push({ event, fields }),
      signal: controller.signal,
      stopWaitMs: 100,
      retryDelayMs: () => 0,
    })

    expect(outboundMessageId).toBe(77)
    expect(generations).toEqual([1, 2])
    expect(events.some(event => event.event === 'poll.stalled')).toBe(true)
    expect(events.some(event => event.event === 'poll.restart')).toBe(true)
  })
})
