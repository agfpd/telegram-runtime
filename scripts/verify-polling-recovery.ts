/**
 * Live, isolated socket-level polling acceptance. No host credentials, Telegram
 * traffic, IAP state or lifecycle commands. The Bot API fixture hangs getUpdates
 * and fails bootstrap over HTTP, then accepts an injected message after repair.
 *
 * bun scripts/verify-polling-recovery.ts --mode after --output /tmp/proof.jsonl
 * --mode before --supervisor /absolute/pre-fix-pollingSupervisor.ts uses the
 * original implementation. Both runs use identical outage timing. Before-mode
 * observes grammY's actual 100 s retry sleep (no fake timers), then exits.
 */
import { Bot } from 'grammy'
import { resolve } from 'node:path'
import { appendFileSync, existsSync } from 'node:fs'
import * as fixed from '../src/pollingSupervisor.ts'

const args = process.argv.slice(2)
const arg = (name: string) => args[args.indexOf(name) + 1]
const mode = arg('--mode')
if (mode !== 'before' && mode !== 'after') throw new Error('--mode before|after required')
const output = arg('--output')
if (!output || output.startsWith('--')) throw new Error('--output required')
if (existsSync(output)) throw new Error('use a NEW evidence output path')
const modulePath = args.includes('--supervisor') ? resolve(arg('--supervisor')) : undefined
const impl: typeof fixed = modulePath ? await import(modulePath) : fixed
const startedAt = Date.now()
const log = (evt: string, fields: Record<string, unknown> = {}) => {
  const row = JSON.stringify({ ts: new Date().toISOString(), ms: Date.now() - startedAt, evt, ...fields })
  appendFileSync(output, row + '\n')
  console.log(row)
}
const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('acceptance wait timed out')
    await Bun.sleep(20)
  }
}

let offline = false
let generation = 0
let bootstrapFailures = 0
let pending: Record<string, unknown>[] = []
const received: string[] = []
const heartbeats: number[] = []
const restarts: number[] = []
const success = (result: unknown) => Response.json({ ok: true, result })
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0, idleTimeout: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split('/').pop()!
    if (method === 'control') {
      offline = (await req.json()).offline
      log(offline ? 'network.down' : 'network.restored')
      return success(true)
    }
    if (method === 'inject') {
      const text = (await req.json()).text
      pending.push({ update_id: text === 'before' ? 1 : 2, message: {
        message_id: text === 'before' ? 1 : 2, date: Math.floor(Date.now() / 1000),
        from: { id: 7, is_bot: false, first_name: 'Fixture' },
        chat: { id: 7, type: 'private' }, text,
      } })
      log('message.injected', { text })
      return success(true)
    }
    if (method === 'inbound') {
      const { text } = await req.json()
      received.push(text)
      log('inbound.ok', { text, generation })
      return success(true)
    }
    if (method === 'getMe' || method === 'deleteWebhook') {
      if (offline) {
        bootstrapFailures++
        log('http.bootstrap.failed', { method, generation, bootstrapFailures })
        return Response.json({ ok: false, error_code: 503, description: 'isolated outage' }, { status: 503 })
      }
      log('http.bootstrap.ok', { method, generation })
      return success(method === 'getMe'
        ? { id: 1, is_bot: true, first_name: 'Probe', username: 'isolated_probe_bot' } : true)
    }
    if (method === 'sendMessage') return success({ message_id: 77, date: 1, chat: { id: 7, type: 'private' } })
    if (method !== 'getUpdates') return new Response('unexpected method', { status: 404 })
    const payload = await req.json()
    const stop = payload.limit === 1 && payload.timeout === undefined
    if (stop) {
      return offline
        ? Response.json({ ok: false, error_code: 503, description: 'stop during isolated outage' }, { status: 503 })
        : success([])
    }
    if (offline) {
      log('http.poll.hung', { generation })
      // Real HTTP request remains pending until the client aborts it.
      await new Promise<void>(res => {
        if (req.signal.aborted) res()
        else req.signal.addEventListener('abort', () => res(), { once: true })
      })
      return success([])
    }
    await Bun.sleep(100)
    return success(pending.splice(0))
  },
})
const root = `http://127.0.0.1:${server.port}`
const post = async (method: string, body: unknown) => {
  const response = await fetch(`${root}/${method}`, { method: 'POST', body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`fixture ${method} failed`)
}
log('probe.start', { mode, supervisor: modulePath ?? 'working-tree', pid: process.pid, port: server.port, grammy: '1.44.0' })
const controller = new AbortController()
let currentBot!: Bot
const running = impl.supervisePolling<Bot, Awaited<ReturnType<Bot['api']['getMe']>>>({
  botKey: 'isolated_probe_bot', pollTimeoutSeconds: 30,
  makeGeneration: g => {
    const guarded = impl.createGuardedPollingFetch({
      botKey: 'isolated_probe_bot', generation: g, fetch: (url, init) => fetch(url, init),
      stallMs: 45_000, stopStallMs: 1000, heartbeatMs: 1000,
      log: (evt, fields) => {
        if (evt === 'poll.heartbeat') heartbeats.push(g)
        log(evt, fields)
      },
    })
    const bot = new Bot('1:ISOLATED_NO_CREDENTIAL', { client: { apiRoot: root, fetch: guarded.fetch as typeof fetch } })
    if (mode === 'after') impl.guardPollingBootstrap(bot, {
      botKey: 'isolated_probe_bot', generation: g, timeoutMs: 2000, log,
    })
    bot.on('message:text', async ctx => { await post('inbound', { text: ctx.message.text }) })
    return { bot, stalled: guarded.stalled }
  },
  publish: (bot, g) => { currentBot = bot; generation = g },
  onStart: () => {},
  log: (evt, fields) => {
    if (evt === 'poll.restart') restarts.push(generation)
    log(evt, fields)
  },
  signal: controller.signal, stopWaitMs: 2000,
})
// Failures must never become a silently pending background proof.
void running.catch(error => { log('probe.fatal', { detail: String(error) }); process.exit(1) })
try {
  await post('inject', { text: 'before' })
  await waitFor(() => received.includes('before') && heartbeats.includes(1), 5000)
  await post('control', { offline: true })
  await waitFor(() => restarts.length > 0 && bootstrapFailures >= 4, 65_000)
  const sent = await currentBot.api.sendMessage(7, 'outbound survives the outage')
  log('outbound.ok', { messageId: sent.message_id, generation })
  await post('control', { offline: false })
  const restoredAt = Date.now()
  await post('inject', { text: 'after' })
  if (mode === 'before') {
    // First retry is immediate; after its failure grammY really sleeps 100 s.
    await Bun.sleep(30_000)
    if (received.includes('after') || heartbeats.some(g => g > 1)) throw new Error('baseline unexpectedly recovered')
    log('probe.zombie.proven', { noProgressForMs: Date.now() - restoredAt, generation })
    // Observe the real 100 s timer firing as well: "permanent" is not proven.
    await waitFor(() => received.includes('after'), 85_000)
    log('probe.baseline.late-recovery', { recoveryMs: Date.now() - restoredAt, generation })
  } else {
    await waitFor(() => received.includes('after') && heartbeats.some(g => g > 1), 20_000)
    log('probe.recovered', { recoveryMs: Date.now() - restoredAt, generation })
  }
  log('probe.pass', { mode, received, generation, restarts })
} finally {
  controller.abort()
  // A before-mode init sleep has no cancellation signal. This is an isolated
  // child process, so force-exit only after evidence is safely written.
  await Promise.race([running, Bun.sleep(2500)])
  server.stop(true)
}
process.exit(0)
