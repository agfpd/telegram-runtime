// Native OpenCode → core broker/watch → real Fleet SSE → Telegram face/renderers.
// No Telegram credentials or Telegram network traffic: the output is captured HTML,
// not a claim of owner delivery. See verify-opencode-face.md for prerequisites.
import { strict as assert } from 'node:assert'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { FleetFace } from '../src/fleetFace.ts'
import { resolveApproval, type PendingApproval, type FleetNotice } from '../src/fleetClient.ts'
import { buildCardText, buildKeyboard, buildResolvedText, parseCallbackData } from '../src/approvalCard.ts'
import { buildNoticeText } from '../src/noticeCard.ts'
import { createOpencodeJournalParser, opencodeStateBusy } from '../src/cli.ts'

const { values } = parseArgs({ options: {
  core: { type: 'string' }, opencode: { type: 'string' }, seed: { type: 'string' }, output: { type: 'string' },
} })
assert.ok(values.core && values.opencode && values.seed && values.output,
  '--core <iapeer checkout> --opencode <native binary> --seed <OpenCode config dir with plugin dependencies> --output <NEW directory>')
const core = resolve(values.core!), bin = resolve(values.opencode!), seed = resolve(values.seed!), output = resolve(values.output!)
assert.ok(existsSync(bin) && existsSync(join(seed, 'node_modules/@opencode-ai/plugin/package.json')))
assert.ok(!existsSync(output), 'output must be NEW')
mkdirSync(output, { recursive: true, mode: 0o700 })
const originalHome = process.env.HOME!
const coreSHA = spawnSync('git', ['-C', core, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
const coreStatus = spawnSync('git', ['-C', core, 'status', '--porcelain'], { encoding: 'utf8' }).stdout
const coreDiffSHA256 = createHash('sha256').update(spawnSync('git', ['-C', core, 'diff', 'HEAD'], { maxBuffer: 16 * 1024 * 1024 }).stdout).digest('hex')
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
function protectedState() {
  return Object.fromEntries(['telegram-runtime', 'web-runtime', 'notifier-runtime', 'voicetalk-runtime', 'iapeer']
    .flatMap(name => [join(originalHome, '.local/bin', name),
      join(originalHome, '.iapeer/runtimes', name.replace('-runtime', ''), 'runtime.json')])
    .filter(existsSync).map(path => {
      const st = statSync(path)
      return [path, { sha256: digest(path), mode: st.mode, inode: st.ino, mtimeMs: st.mtimeMs }]
    }))
}
const before = protectedState()
function channelProcesses() {
  const ps = spawnSync('/bin/ps', ['-Ao', 'pid,ppid,lstart,comm'], { encoding: 'utf8' })
  assert.equal(ps.status, 0)
  return ps.stdout.split('\n').filter(line => /\/\.local\/bin\/(telegram-runtime|web-runtime|notifier-runtime|voicetalk-runtime)$/.test(line))
}
const processesBefore = channelProcesses()
const root = mkdtempSync(join(tmpdir(), 'telegram-oc-face-'))
const home = join(root, 'home'), personality = 'ocface', identity = `opencode-${personality}`
const config = join(home, 'config/opencode')
mkdirSync(config, { recursive: true })
// Copy dependencies only, never an operator's provider/auth/config files.
cpSync(join(seed, 'node_modules'), join(config, 'node_modules'), { recursive: true })
for (const name of ['package.json', 'bun.lock', 'bun.lockb']) {
  if (existsSync(join(seed, name))) cpSync(join(seed, name), join(config, name))
}
const portReservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
const port = portReservation.port!
portReservation.stop(true)
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, TMPDIR: root,
  IAPEER_ROOT: join(root, 'iapeer'), IAPEER_PORT: String(port), IAPEER_TEST_SANDBOX: '1',
  IAPEER_OPENCODE_BIN: bin, IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'), IAPEER_APPROVAL_TIMEOUT_MS: '6000',
  XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
  XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', HOMEBREW_NO_AUTO_UPDATE: '1',
}
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, env)
const { startConfiguredDaemon } = await import(join(core, 'src/daemon/main.ts'))
const { initPeer } = await import(join(core, 'src/init/index.ts'))
const { setApprovalMode } = await import(join(core, 'src/approval/install.ts'))
const { wakeOrSpawn } = await import(join(core, 'src/lifecycle/index.ts'))
const { opencodePaths } = await import(join(core, 'src/opencode/config.ts'))
const { opencodeAdapter } = await import(join(core, 'src/launch/adapters/opencode.ts'))
const { killPtyHost } = await import(join(core, 'src/launch/ptyHost.ts'))
const paths = opencodePaths(personality, { env })
const events = (): any[] => existsSync(paths.events) ? readFileSync(paths.events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
async function until<T>(label: string, read: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await Bun.sleep(100)
  }
  throw new Error(`timeout: ${label}`)
}
const checks: string[] = [], wire: unknown[] = [], captured: any[] = [], faceLog: unknown[] = []
const check = (label: string, condition: unknown) => { assert.ok(condition, label); checks.push(label); console.log(`PASS ${label}`) }
const cards = new Map<string, PendingApproval>(), notices: FleetNotice[] = [], resolutions: any[] = []
let failProvider = false
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body = await req.json() as any
  wire.push(body)
  if (failProvider) return Response.json({ error: { message: 'OCFACE synthetic invalid API key', type: 'invalid_api_key' } }, { status: 401 })
  const last = body.messages?.at(-1)
  const tag = last?.role === 'user' ? JSON.stringify(last.content).match(/RUN_BASH (allowed|denied|timedout)/)?.[1] : undefined
  const sse = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({
    id: 'chatcmpl-' + wire.length, object: 'chat.completion.chunk', created: 1, model: 'synthetic',
    choices: [{ index: 0, delta, finish_reason }],
  }) + '\n\n'
  const data = tag
    ? sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + wire.length, type: 'function', function: {
      name: 'bash', arguments: JSON.stringify({ command: `echo ${tag} > ${join(root, tag)}`, description: `face ${tag}` }),
    } }] }, null) + sse({}, 'tool_calls')
    : sse({ role: 'assistant', content: 'DONE' }, null) + sse({}, 'stop')
  return new Response(data + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
} })
let daemon: any, face: FleetFace | undefined, success = false
const base = `http://127.0.0.1:${port}`
const makeFace = (approval = true) => new FleetFace({ base, deps: { env }, reconcileIntervalMs: 0,
  log: (event, fields) => faceLog.push({ time: Date.now(), event, ...fields }),
  ...(approval ? { approval: {
    onRequest(item: PendingApproval) {
      cards.set(item.id, item)
      captured.push({ type: 'approval', item, text: buildCardText(item), keyboard: buildKeyboard(item.id) })
    },
    onResolved(info: any) {
      resolutions.push(info)
      const item = cards.get(info.id)
      if (item) captured.push({ type: 'resolved', info, text: buildResolvedText(item, info) })
    },
  } } : {}),
  notice: { onNotice(item) { notices.push(item); captured.push({ type: 'notice', item, text: buildNoticeText(item) }) } },
})
async function idle() {
  await until('native idle', () => existsSync(paths.state) && JSON.parse(readFileSync(paths.state, 'utf8')).status === 'idle')
}
async function deliver(text: string) {
  const result = await opencodeAdapter.deliver({ personality, identity }, text, env)
  assert.ok(result.ok, JSON.stringify(result))
}
try {
  daemon = await startConfiguredDaemon({ port, socketPath: join(root, 'router.sock'), env, muteWatchIntervalMs: 250 })
  const cwd = join(root, personality)
  mkdirSync(cwd)
  await initPeer({ cwd, runtime: 'opencode', personality, description: 'isolated face proof', intelligence: 'artificial', env })
  setApprovalMode(cwd, 'gated', env)
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ model: 'synthetic/synthetic', small_model: 'synthetic/synthetic', enabled_providers: ['synthetic'],
    provider: { synthetic: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic', options: { baseURL: provider.url + 'v1', apiKey: 'fixture-only' },
      models: { synthetic: { name: 'Synthetic', tool_call: true, limit: { context: 100000, output: 1000 } } } } } }))
  face = makeFace()
  face.start()
  check('native OpenCode endpoint ready', (await wakeOrSpawn({ personality, runtime: 'opencode', task: 'hello' }, { env })).status === 'READY')
  await idle()
  for (const tag of ['allowed', 'denied', 'timedout'] as const) {
    await deliver(`RUN_BASH ${tag}`)
    const card = await until(`face card ${tag}`, () => [...cards.values()].find(item => item.content.includes(tag)))
    check(`${tag}: native approval reached Telegram renderer`, card.runtime === 'opencode' && card.tool === 'bash' && captured.some(c => c.type === 'approval' && c.item.id === card.id && c.text.includes('opencode')))
    check(`${tag}: command waits for human`, !existsSync(join(root, tag)))
    if (tag !== 'timedout') {
      const keyboard = buildKeyboard(card.id)
      const data = parseCallbackData(keyboard.inline_keyboard[0]![tag === 'allowed' ? 0 : 1]!.callback_data)!
      check(`${tag}: keyboard decision through real Fleet HTTP`, await resolveApproval(base, data.id, data.action, { approver: 'proof-owner', via: 'telegram' }, { env }) === 'ok')
    }
    await until(`${tag} face resolution`, () => resolutions.find(r => r.id === card.id))
    await idle()
    check(`${tag}: native execution matches decision`, existsSync(join(root, tag)) === (tag === 'allowed'))
    check(`${tag}: one card despite SSE/reconcile`, captured.filter(c => c.type === 'approval' && c.item.id === card.id).length === 1)
  }
  const parser = createOpencodeJournalParser()
  const gestures = events().flatMap(e => parser.events(e))
  check('live journal produces bash gesture', gestures.some(g => g.tool === 'bash'))
  check('live journal replay deduped', events().flatMap(e => parser.events(e)).length === 0)
  check('native idle state understood', opencodeStateBusy(JSON.parse(readFileSync(paths.state, 'utf8'))) === false)

  // Silence approvals, not notices; real error originates in the native provider
  // client, never by appending fabricated journal records or POSTing a board item.
  face.stop()
  face = makeFace(false)
  face.start()
  failProvider = true
  await deliver('PROVIDER_ERROR')
  await until('native session.error', () => events().find(e => e.type === 'session.error'))
  const notice = await until('notice through native watch and Fleet face', () => notices.find(n => n.personality === personality), 35_000)
  check('provider failure reaches notices with approvals off', notice.runtime === 'opencode' && notice.content.includes('OCFACE') && notice.errorType.includes('401'))
  check('unstated reset stays unknown', notice.resetsAtMs === undefined && captured.some(c => c.type === 'notice' && c.text.includes('время сброса неизвестно')))
  await face.reconcile()
  check('notice not duplicated on reconcile', notices.length === 1)
  success = true
} finally {
  face?.stop()
  try { killPtyHost(identity, env) } catch {}
  await daemon?.close().catch(() => {})
  provider.stop(true)
  for (const [name, path] of [['events.jsonl', paths.events], ['state.json', paths.state]] as const) {
    if (existsSync(path)) cpSync(path, join(output, name))
  }
  if (existsSync(join(root, 'iapeer/logs'))) cpSync(join(root, 'iapeer/logs'), join(output, 'core-logs'), { recursive: true })
  const after = protectedState()
  const processesAfter = channelProcesses()
  const unchanged = JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(processesBefore) === JSON.stringify(processesAfter)
  writeFileSync(join(output, 'result.json'), JSON.stringify({ success: success && unchanged, checks, coreVersion: JSON.parse(readFileSync(join(core, 'package.json'), 'utf8')).version,
    coreStatus, coreDiffSHA256,
    coreSHA, coreSHAAfter: spawnSync('git', ['-C', core, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    nativeSHA256: digest(bin), before, after, processesBefore, processesAfter, hostUnchanged: unchanged,
    boundary: 'Native OpenCode with loopback synthetic provider, source core, real Fleet HTTP/SSE and Telegram face/renderers. Captured HTML only: no Telegram API, chat delivery, polling, STT, owner callback gate or production activation proof.',
  }, null, 2))
  writeFileSync(join(output, 'cards.json'), JSON.stringify(captured, null, 2))
  writeFileSync(join(output, 'wire.json'), JSON.stringify(wire, null, 2))
  writeFileSync(join(output, 'face.json'), JSON.stringify(faceLog, null, 2))
  rmSync(root, { recursive: true, force: true })
  assert.ok(unchanged, 'protected host binaries/manifests and channel process identities unchanged')
}
