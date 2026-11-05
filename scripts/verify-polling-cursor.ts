/** Socket-level offset-loss reproduction; no Telegram, credentials or host state. */
import { Bot } from 'grammy'
import { parseArgs } from 'node:util'
import { appendFileSync, writeFileSync } from 'node:fs'
import * as polling from '../src/pollingSupervisor.ts'

export async function provePollingCursor(preserve: boolean, log: polling.PollingLog) {
  const controller = new AbortController()
  const watchdog = setTimeout(() => controller.abort(), 15_000)
  const cursor = preserve ? polling.createPollingCursor() : null
  let generation = 0
  let firstBatchSent = false
  let queue = [41]
  const received: number[] = []
  const requests: Array<{ generation: number; offset: number; stop: boolean }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const method = new URL(request.url).pathname.split('/').pop()
      if (method === 'getMe') return Response.json({ ok: true, result: { id: 1, is_bot: true, first_name: 'Probe', username: 'probe_bot' } })
      if (method === 'deleteWebhook') return Response.json({ ok: true, result: true })
      if (method !== 'getUpdates') return new Response('', { status: 404 })
      const payload = await request.json() as { offset: number; limit?: number }
      const stop = payload.limit === 1
      requests.push({ generation, offset: payload.offset, stop })
      log('fixture.getUpdates', { generation, offset: payload.offset, stop })
      // Both the next long poll and the stop-confirm fail BEFORE the server
      // applies their offsets. Update 41 therefore remains unconfirmed.
      if (generation === 1 && stop) return Response.json({ ok: false, error_code: 503, description: 'offline before offset ack' }, { status: 503 })
      if (generation === 1 && firstBatchSent) return new Promise<Response>(() => {})
      queue = queue.filter(id => id >= payload.offset)
      if (generation === 1) firstBatchSent = true
      if (generation >= 2 && !queue.includes(42) && !received.includes(42)) queue.push(42)
      if (queue.length === 0 && !stop) return new Promise<Response>(() => {})
      return Response.json({ ok: true, result: queue.map(update_id => ({
        update_id, message: { message_id: update_id, date: 1, chat: { id: 1, type: 'private' }, text: String(update_id) },
      })) })
    },
  })
  try {
    await polling.supervisePolling({
      botKey: 'probe_bot', pollTimeoutSeconds: 30, signal: controller.signal,
      makeGeneration(n) {
        generation = n
        const guarded = polling.createGuardedPollingFetch({
          botKey: 'probe_bot', generation: n, fetch: (input, init) => fetch(input, init),
          stallMs: 50, stopStallMs: 50, heartbeatMs: 1000, log,
        })
        const bot = new Bot('1:probe', { client: { apiRoot: server.url.origin, fetch: guarded.fetch } })
        polling.guardPollingBootstrap(bot, { botKey: 'probe_bot', generation: n, timeoutMs: 1000, log })
        cursor?.install(bot)
        bot.on('message:text', ctx => {
          received.push(ctx.update.update_id)
          log('fixture.delivered', { generation: n, updateId: ctx.update.update_id })
          if (ctx.update.update_id === 42) controller.abort()
        })
        return { bot, stalled: guarded.stalled, healthy: guarded.healthy }
      },
      publish() {}, onStart() {}, log, stopWaitMs: 4000, retryDelayMs: () => 0,
    })
    const expected = preserve ? [41, 42] : [41, 41, 42]
    if (JSON.stringify(received) !== JSON.stringify(expected)) throw new Error(`unexpected delivery ${JSON.stringify(received)}, expected ${JSON.stringify(expected)}`)
    const result = { preserve, received, requests }
    log('proof.pass', result)
    return result
  } finally {
    clearTimeout(watchdog)
    server.stop(true)
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { mode: { type: 'string' }, output: { type: 'string' } } })
  if (!values.output || !['before', 'after'].includes(values.mode ?? '')) throw new Error('--mode before|after --output <NEW file> required')
  writeFileSync(values.output, '', { flag: 'wx' })
  await provePollingCursor(values.mode === 'after', (evt, fields) => appendFileSync(values.output!, JSON.stringify({ ts: new Date().toISOString(), evt, ...fields }) + '\n'))
}
