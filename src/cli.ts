#!/usr/bin/env bun
import { Bot, GrammyError, HttpError } from 'grammy'
import { randomUUID } from 'crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, dirname, extname, join } from 'path'
import { spawn, spawnSync } from 'child_process'
import { selfInstall } from './selfInstall.ts'
import { runSelfConfig } from './selfConfig.ts'

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
const RUNTIME = 'telegram'
const IAPEER_DIR = '.iapeer'
const PEER_PROFILE_FILE = 'peer-profile.json'
const MAX_TELEGRAM_TEXT = 4096
// Outbound send hardening: a hung Telegram API call (transient network /
// proxy glitch) used to block the serial outbound queue forever — the peer
// silently stopped receiving. We bound every outbound send with a timeout
// (so a hung call rejects instead of hanging) plus a few backoff retries.
const OUTBOUND_SEND_TIMEOUT_MS = Number(process.env.TELEGRAM_OUTBOUND_TIMEOUT_MS ?? '') || 30_000
const OUTBOUND_SEND_RETRIES = Number(process.env.TELEGRAM_OUTBOUND_RETRIES ?? '') || 2
// Telegram → IAP delivery is synchronous from the operator's point of view:
// if the core router refuses the send (ok=false/err) or our local waiter times
// out before the core wake deadline, the operator must see that verdict in the
// same chat. This timeout is deliberately shorter than iapeer's wake-deadline
// (240s today) so the bridge never leaves Telegram polling frozen behind a
// stuck CLI child. The verdict is "not delivered: …" — no auto-retry, no silent
// loss.
const IAP_SEND_TIMEOUT_MS = Number(process.env.TELEGRAM_IAP_SEND_TIMEOUT_MS ?? '') || 60_000
// Rich messages (Bot API 10.1, released 2026-06-11): an outbound peer envelope
// is sent as ONE rich message — `InputRichMessage.markdown` carries the agent's
// GFM verbatim and Telegram parses it SERVER-SIDE ("Rich Markdown is compatible
// with GitHub Flavored Markdown where possible"): headings, lists, tables,
// quotes and code render natively on the owner's client. Doc limits: 32768
// characters / 500 blocks (vs 4096 for sendMessage) — one rich send replaces
// chunking for any realistic report. grammy 1.43.0 carries no 10.1 typings yet;
// the call goes through `bot.api.raw`, a Proxy keyed on method name, so it
// works at runtime today (cast at the call site). Every failure falls back to
// the legacy chunked MarkdownV2→plain path — rich can degrade, never lose a
// message. Kill switch: TELEGRAM_RICH=0.
const RICH_OUTBOUND_ENABLED = process.env.TELEGRAM_RICH !== '0'
// The docs say "32768 UTF-8 characters"; whether that counts code points or
// UTF-8 bytes is unverified — we gate on JS .length as the approximation and
// let a 400 "too long" fall back to the chunked path (graceful, message kept).
const MAX_RICH_TEXT = 32768
// Paragraph-spacing workaround (defect 2026-06-12): Telegram clients render
// ADJACENT paragraph blocks with line breaks but NO vertical gap — the server
// parses \n\n into separate paragraph blocks correctly (proven by the API
// response echo), the air is lost at render time (owner screenshots). The
// bridge compensates by inserting a spacer paragraph (a lone &nbsp;) between
// two PLAIN paragraphs; structural blocks (headings, tables, lists, quotes,
// code, dividers) already render with spacing and must NOT get spacers. The
// feature is a day old client-side — this is deliberately CHEAP TO REMOVE:
// one env (TELEGRAM_RICH_SPACER=0), one call site, one function.
const RICH_SPACER_ENABLED = process.env.TELEGRAM_RICH_SPACER !== '0'
const RICH_SPACER_LINE = '&nbsp;'
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
// Outbound attachment → Telegram Bot API method, keyed on the file extension the
// sending agent chose. We trust the extension as the declared format rather than
// probing bytes/ffprobe: it keeps the outbound path dependency-free and synchronous,
// and `sendVoice` in particular *requires* an OGG/OPUS container — the same thing the
// `.ogg`/`.oga` extension declares. Voice → inline waveform player; audio → music
// track; photo → image; everything else falls back to a plain document (no regression).
const VOICE_EXTS = new Set(['.ogg', '.oga'])
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac'])

type Flags = Record<string, string | boolean | string[]>

type TelegramInterface = {
  user_id?: string
  // The bot CATALOG KEY (operator-chosen alias, NAME_RE grammar) — the stable local
  // handle that names the credential dir bots/<key>/.env (token + getMe @username) and
  // keys inbound/outbound routing. NOT the @username and NOT the token. The real
  // human-readable @username is NOT stored here (it would be a write-only duplicate of
  // the .env): it lives once in bots/<key>/.env TELEGRAM_BOT_USERNAME (filled by `bot
  // add` via getMe) and is DERIVED for display from there (see `bot list`).
  bot?: string
  // Agent-activity progress channel (second, separate channel — NOT
  // send_to_peer). Tri-state on purpose: `true`/`false` is an explicit
  // per-peer operator choice (set via the `/activity` chat command), `undefined`
  // means "never decided" → falls back to the default, which is ON in code
  // (product decision: the activity stream is visible by default — a new
  // peer streams out of the box). TELEGRAM_ACTIVITY_DEFAULT=0 is the env
  // opt-out for hosts where the stream is noise.
  activity?: boolean
  // Operator slash-command aliases (§3.5) — TRANSITION FALLBACK ONLY. The
  // canonical location moved to top-level `PeerProfile.expansion.aliases`
  // (private runtime-plugin config, design sync with iapeer 2026-06-11);
  // aliases here were misfiled in the passport section. Read as a fallback
  // until iapeer's fleet-wide data migration lands, then this field (and the
  // fallback in resolveAliases()) can be dropped. Alias keys live in the
  // `/alias_*` namespace (underscore — Telegram registered commands forbid `-`);
  // bare slash keys (`/new`, `/compact`) are reserved for the control layer.
  aliases?: Record<string, string>
}

// `natural` is the post-vocab-flip contract word for human peers; legacy `human`
// is kept for not-yet-flipped registries. BOTH must round-trip verbatim through
// readPeerProfile/writePeerProfile — before `natural` joined this union the typed
// reader silently coerced it to the runtime default (`human` for telegram), so
// every `interface bot/human` verb run CLOBBERED the foundation-provisioned
// `intelligence: natural` (the exact pilot-notifier lesson selfConfig.ts guards
// against: preserve, don't re-derive identity). Found live 2026-06-10 during
// connect-flow acceptance.
type Intelligence = 'natural' | 'human' | 'artificial' | 'scripted'

const HUMAN_RUNTIMES_TR = new Set(['telegram', 'discord', 'matrix', 'email', 'web'])
const SCRIPTED_RUNTIMES_TR = new Set(['webhook', 'api', 'cron'])

function defaultIntelligenceForRuntime(runtime: string): Intelligence {
  if (HUMAN_RUNTIMES_TR.has(runtime)) return 'human'
  if (SCRIPTED_RUNTIMES_TR.has(runtime)) return 'scripted'
  return 'artificial'
}

function isIntelligence(value: unknown): value is Intelligence {
  return value === 'natural' || value === 'human' || value === 'artificial' || value === 'scripted'
}

type PeerProfile = {
  personality: string
  runtime: string
  runtimes: string[]
  description: string
  intelligence: Intelligence
  // Private runtime-plugin config (owner: telegram-runtime; design sync with
  // iapeer 2026-06-11, topic aliases-section-design). Named for the MECHANISM,
  // not the plugin: expansion is runtime-agnostic by the 2026-05-25 decision —
  // a future discord/matrix runtime reads the SAME aliases. Round-trips
  // verbatim (unknown siblings preserved); sanitizing happens at the point of
  // use — see resolveAliases(). Intentionally NOT projected into the public
  // peers-profiles.json registry (iapeer side) — read from the local profile
  // per-message.
  expansion?: {
    aliases?: Record<string, string>
    [key: string]: unknown
  }
  interfaces?: {
    telegram?: TelegramInterface
    [key: string]: unknown
  }
}

type PeerRecord = PeerProfile & {
  cwd: string
}

type PeersIndex = {
  version: number
  peers: PeerRecord[]
}

type BotCredential = {
  key: string
  token: string
}

type PeerDirectory = {
  peers: PeerRecord[]
  byPersonality: Map<string, PeerRecord>
  byTelegramBot: Map<string, PeerRecord>
}

type IapEnvelope = {
  fromPersonality: string
  fromRuntime: string
  fromIntelligence?: Intelligence
  topic?: string
  attachments: string[]
  message: string
}

type RuntimeContext = {
  cwd: string
  owner: PeerProfile
  ownerUserId: string
  iapBin: string
  bots: Map<string, Bot>
  credentials: Map<string, BotCredential>
}

class TelegramRuntimeError extends Error {}

type ReleaseLock = () => void

function usage(): string {
  return `Usage:
  telegram-runtime                 # self-install (npx contract): bin on PATH + manifest
  telegram-runtime self-install    # explicit self-install (idempotent)
  telegram-runtime self-config     # per-peer self-config hook (foundation-invoked)
  telegram-runtime prepare [--user-id <telegram-user-id>]
  telegram-runtime interface human --user-id <telegram-user-id>
  telegram-runtime interface bot <bot-key> --peer <personality>
  telegram-runtime bot add <bot-key> --token <token> [--username <fallback-if-offline>]
  telegram-runtime bot remove <bot-key>
  telegram-runtime bot list [--json]
  telegram-runtime run
  telegram-runtime doctor [--json]`
}

function setFlag(flags: Flags, key: string, value: string | boolean): void {
  const previous = flags[key]
  if (previous === undefined) {
    flags[key] = value
    return
  }
  if (Array.isArray(previous)) {
    previous.push(String(value))
    return
  }
  flags[key] = [String(previous), String(value)]
}

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = []
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const raw = arg.slice(2)
    const eq = raw.indexOf('=')
    if (eq >= 0) {
      setFlag(flags, raw.slice(0, eq), raw.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      setFlag(flags, raw, true)
      continue
    }
    i++
    setFlag(flags, raw, next)
  }
  return { positional, flags }
}

function stringFlag(flags: Flags, key: string): string | undefined {
  const value = flags[key]
  if (Array.isArray(value)) return value.at(-1)
  return typeof value === 'string' ? value : undefined
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function assertName(value: string, source: string): void {
  if (!NAME_RE.test(value)) {
    throw new TelegramRuntimeError(
      `${source} must match /^[a-z][a-z0-9-]{0,31}$/, got "${value}"`,
    )
  }
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase()
}

function iapeerRoot(): string {
  // IAPEER_ROOT-aware (mirror of the foundation's resolveGlobalRoot): the env override
  // wins, else ~/.iapeer. Unset in production → identical to the historical behavior
  // (the live peer unchanged); set in a sandbox/test → the whole runtime (manifest, bots
  // registry, peers index) lands under the isolated root, in lockstep with manifest.ts.
  const override = process.env.IAPEER_ROOT?.trim()
  if (override) return override
  return join(homedir(), '.iapeer')
}

function globalTelegramRoot(): string {
  return join(iapeerRoot(), 'runtimes', RUNTIME)
}

function botsRoot(): string {
  return join(globalTelegramRoot(), 'bots')
}

function inboxRoot(): string {
  return join(globalTelegramRoot(), 'inbox')
}

function peersIndexPath(): string {
  return join(iapeerRoot(), 'peers-profiles.json')
}

function peerProfilePath(cwd = process.cwd()): string {
  return join(cwd, IAPEER_DIR, PEER_PROFILE_FILE)
}

function ensureScaffold(cwd = process.cwd()): void {
  mkdirSync(join(cwd, IAPEER_DIR, 'runtimes', RUNTIME), { recursive: true, mode: 0o700 })
  mkdirSync(join(cwd, IAPEER_DIR, 'plugins', 'telegram-runtime'), {
    recursive: true,
    mode: 0o700,
  })
  mkdirSync(globalTelegramRoot(), { recursive: true, mode: 0o700 })
  mkdirSync(botsRoot(), { recursive: true, mode: 0o700 })
  mkdirSync(inboxRoot(), { recursive: true, mode: 0o700 })
  mkdirSync(join(globalTelegramRoot(), 'logs'), { recursive: true, mode: 0o700 })
  mkdirSync(join(globalTelegramRoot(), 'cache'), { recursive: true, mode: 0o700 })
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (err) {
    throw new TelegramRuntimeError(
      `${path} is invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  renameSync(tmp, path)
}

function readPeerProfile(cwd = process.cwd()): PeerProfile | null {
  const raw = readJsonFile<Partial<PeerProfile>>(peerProfilePath(cwd))
  if (!raw) return null
  if (typeof raw.personality !== 'string') {
    throw new TelegramRuntimeError(`${peerProfilePath(cwd)} personality is required`)
  }
  if (typeof raw.runtime !== 'string') {
    throw new TelegramRuntimeError(`${peerProfilePath(cwd)} runtime is required`)
  }
  const personality = normalizeName(raw.personality)
  assertName(personality, 'personality')
  const runtimes = Array.isArray(raw.runtimes)
    ? raw.runtimes.filter((item): item is string => typeof item === 'string')
    : [raw.runtime]
  const intelligence: Intelligence = isIntelligence(raw.intelligence)
    ? raw.intelligence
    : defaultIntelligenceForRuntime(raw.runtime)
  return {
    personality,
    runtime: raw.runtime,
    runtimes: unique([raw.runtime, ...runtimes]),
    description: typeof raw.description === 'string' ? raw.description : '',
    intelligence,
    // expansion и interfaces round-trip'ятся verbatim (sanitize в точке
    // использования — resolveAliases): typed-парс здесь терял бы незнакомые
    // сиблинги при последующем writePeerProfile.
    ...(raw.expansion && typeof raw.expansion === 'object' && !Array.isArray(raw.expansion)
      ? { expansion: raw.expansion }
      : {}),
    ...(raw.interfaces && typeof raw.interfaces === 'object'
      ? { interfaces: raw.interfaces }
      : {}),
  }
}

function sanitizeAliases(input: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof key !== 'string' || !key.startsWith('/')) continue
    if (typeof value !== 'string' || value.length === 0) continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Expand an operator slash-command into the corresponding peer-profile alias text.
 *
 * Per §3.5 IAPeer DECISIONS: when an operator (human source) sends a message that
 * exactly matches a key in the target peer's `aliases` map (after trimming
 * surrounding whitespace, no fuzzy matching), the *-runtime package substitutes
 * the message text with the alias value before IAP delivery. The peer-LLM never
 * sees the literal `/<command>` — only the expanded text. If no alias matches,
 * the original text is returned unchanged.
 *
 * The trim is intentional: Telegram clients sometimes append a trailing newline
 * to single-line messages, and operators sometimes type a leading space; treating
 * `\n/new` and `/new ` as `/new` matches operator intent.
 *
 * This function does not check the source. The caller is responsible for ensuring
 * the message originates from a human operator (in the Telegram inbound flow,
 * that filter is already applied through `fromId === ctx.ownerUserId`).
 */
export function expandAlias(text: string, aliases: Record<string, string> | undefined): string {
  if (!aliases) return text
  const key = text.trim()
  const expansion = aliases[key]
  return typeof expansion === 'string' && expansion.length > 0 ? expansion : text
}

/**
 * Resolve the effective alias map for a peer profile.
 *
 * Canonical source is the top-level `expansion.aliases` section — private
 * runtime-plugin config, named for the mechanism so future runtimes (discord/
 * matrix) read the same map (design sync with iapeer 2026-06-11, topic
 * aliases-section-design). When present and non-empty after sanitizing, it
 * wins ALONE — no merge with the fallback, so a migrated profile is read
 * exactly as migrated.
 *
 * `interfaces.telegram.aliases` (the previous canonical location, 2026-06-07
 * contract split) is the TRANSITION fallback until iapeer's fleet-wide data
 * migration relocates all profiles; drop it (and TelegramInterface.aliases)
 * after migration + soak. The original top-level `aliases` fallback was
 * removed in this release: verified per-profile 2026-06-11 that zero registry
 * profiles still carry it (9 bot peers + index all migrated).
 *
 * Both sections round-trip verbatim through readPeerProfile (unknown-field
 * preservation), so sanitizing happens here at the point of use, not at parse.
 */
export function resolveAliases(profile: PeerProfile | null): Record<string, string> | undefined {
  if (!profile) return undefined
  const canonical = profile.expansion?.aliases
  if (canonical && typeof canonical === 'object' && !Array.isArray(canonical)) {
    const sanitized = sanitizeAliases(canonical as Record<string, unknown>)
    if (sanitized) return sanitized
  }
  const telegram = profile.interfaces?.telegram
  const fallback = telegram && typeof telegram === 'object' ? telegram.aliases : undefined
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
    return sanitizeAliases(fallback as Record<string, unknown>)
  }
  return undefined
}

function writePeerProfile(cwd: string, profile: PeerProfile): void {
  // Preserve unknown fields на round-trip. telegram-runtime PeerProfile type
  // содержит только runtime-relevant поля (personality/runtime/runtimes/
  // description/intelligence/expansion/interfaces); поля смежных контрактов
  // (например initial_prompt от Persistent-Peer §3.3.1) telegram-runtime не
  // парсит, но обязан сохранять — иначе interface bot/human команды молча
  // их теряют. Read-before-write merge поверх существующего файла.
  const path = peerProfilePath(cwd)
  let existing: Record<string, unknown> = {}
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        existing = raw as Record<string, unknown>
      }
    }
  } catch {
    // невалидный файл — пишем чистую typed версию (потери unknown нет, их и не было)
  }
  const merged: Record<string, unknown> = {
    ...existing,
    ...profile,
  }
  writeJsonAtomic(path, merged)
}

function unique<T>(values: readonly T[]): T[] {
  const out: T[] = []
  for (const value of values) {
    if (!out.includes(value)) out.push(value)
  }
  return out
}

function ensureCurrentProfile(cwd = process.cwd()): PeerProfile {
  ensureScaffold(cwd)
  const existing = readPeerProfile(cwd)
  if (existing) {
    if (!existing.runtimes.includes(RUNTIME)) {
      const updated = { ...existing, runtimes: unique([...existing.runtimes, RUNTIME]) }
      writePeerProfile(cwd, updated)
      return updated
    }
    return existing
  }
  const personality = normalizeName(basename(cwd))
  assertName(personality, 'cwd basename')
  const profile: PeerProfile = {
    personality,
    runtime: RUNTIME,
    runtimes: [RUNTIME],
    description: '',
    intelligence: defaultIntelligenceForRuntime(RUNTIME),
  }
  writePeerProfile(cwd, profile)
  return profile
}

function telegramInterface(profile: PeerProfile): TelegramInterface {
  const interfaces = profile.interfaces
  const telegram = interfaces?.telegram
  if (!telegram || typeof telegram !== 'object') return {}
  return telegram as TelegramInterface
}

function setTelegramInterface(profile: PeerProfile, patch: TelegramInterface): PeerProfile {
  const current = telegramInterface(profile)
  return {
    ...profile,
    interfaces: {
      ...(profile.interfaces ?? {}),
      telegram: {
        ...current,
        ...patch,
      },
    },
  }
}

function readPeersIndex(): PeersIndex {
  return readJsonFile<PeersIndex>(peersIndexPath()) ?? { version: 1, peers: [] }
}

function hydratePeerRecord(peer: PeerRecord): PeerRecord {
  if (!peer.cwd) return peer
  const profile = readPeerProfile(peer.cwd)
  if (!profile) return peer
  return {
    ...peer,
    personality: profile.personality,
    runtime: profile.runtime,
    runtimes: profile.runtimes,
    description: profile.description,
    intelligence: profile.intelligence,
    interfaces: profile.interfaces,
  }
}

function readPeerDirectory(): PeerDirectory {
  const index = readPeersIndex()
  const peers = (Array.isArray(index.peers) ? index.peers : []).map(hydratePeerRecord)
  const byPersonality = new Map<string, PeerRecord>()
  const byTelegramBot = new Map<string, PeerRecord>()
  for (const peer of peers) {
    if (!peer || typeof peer.personality !== 'string') continue
    byPersonality.set(peer.personality, peer)
    const telegram = telegramInterface(peer)
    if (telegram.bot) byTelegramBot.set(String(telegram.bot), peer)
  }
  return { peers, byPersonality, byTelegramBot }
}

function findPeerProfilePath(personality: string): string {
  const current = readPeerProfile(process.cwd())
  if (current?.personality === personality) return peerProfilePath(process.cwd())
  const record = readPeerDirectory().byPersonality.get(personality)
  if (!record?.cwd) {
    throw new TelegramRuntimeError(
      `peer "${personality}" is not in ${peersIndexPath()}; run IAP from that peer cwd first`,
    )
  }
  return peerProfilePath(record.cwd)
}

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function writeEnvFile(path: string, env: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lines = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

function botDir(botKey: string): string {
  return join(botsRoot(), botKey)
}

function botEnvPath(botKey: string): string {
  return join(botDir(botKey), '.env')
}

function botLockPath(botKey: string): string {
  return join(botDir(botKey), 'runtime.lock')
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: unknown }).code === 'EPERM'
    ) {
      return true
    }
    return false
  }
}

function acquireBotLock(botKey: string): ReleaseLock {
  const path = botLockPath(botKey)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const previousPid = Number(readFileSync(path, 'utf8').trim())
    if (processIsAlive(previousPid)) {
      throw new TelegramRuntimeError(`bot "${botKey}" is already owned by pid ${previousPid}`)
    }
    rmSync(path, { force: true })
  } catch (err) {
    if (err instanceof TelegramRuntimeError) throw err
  }

  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch (err) {
    throw new TelegramRuntimeError(
      `bot "${botKey}" lock is busy at ${path}: ${formatError(err)}`,
    )
  }
  writeFileSync(fd, `${process.pid}\n`)
  closeSync(fd)
  return () => {
    try {
      if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path)
    } catch {
      // Best-effort cleanup only; stale lock detection runs on next startup.
    }
  }
}

function loadCredential(botKey: string): BotCredential {
  const env = readEnvFile(botEnvPath(botKey))
  const token = env.TELEGRAM_BOT_TOKEN
  if (!token) {
    throw new TelegramRuntimeError(`${botEnvPath(botKey)} missing TELEGRAM_BOT_TOKEN`)
  }
  return {
    key: botKey,
    token,
  }
}

function listBotKeys(): string[] {
  try {
    return readdirSync(botsRoot(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && NAME_RE.test(entry.name))
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function runtimeFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxy =
    process.env.TELEGRAM_RUNTIME_PROXY ??
    process.env.CLAUDE_TG_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    ''
  return proxy
    ? fetch(url, { ...(init ?? {}), proxy } as RequestInit & { proxy: string })
    : fetch(url, init)
}

// ── getMe probe for `bot add` ───────────────────────────────────────────
// The token's truth lives in Telegram, not in operator flags: `bot add` validates
// the token via getMe and persists the REAL @username into the bot's .env
// (TELEGRAM_BOT_USERNAME) — the connect-flow activation line («напишите боту
// @<username>») reads it from there. The two failure modes are deliberately
// distinct: `invalid-token` (Telegram answered and said no) is always fatal,
// `network` (Telegram unreachable) can be overridden with an explicit
// --username (offline escape hatch). getMe is read-only and does NOT consume
// updates — safe to call while the live poller holds the same token.
export type BotIdentityProbe =
  | { ok: true; username: string }
  | { ok: false; reason: 'invalid-token' | 'network'; detail: string }

export async function probeBotIdentity(
  token: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = runtimeFetch,
): Promise<BotIdentityProbe> {
  let response: Response
  try {
    // Scoped one-shot timeout (NOT global in runtimeFetch — long-polling getUpdates
    // legitimately hangs ~30s; this signal lives and dies with this single call).
    response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    return { ok: false, reason: 'network', detail: error instanceof Error ? error.message : String(error) }
  }
  let body: { ok?: boolean; description?: string; result?: { username?: string } } | undefined
  try {
    body = (await response.json()) as typeof body
  } catch {
    body = undefined
  }
  if (!body?.ok) {
    return {
      ok: false,
      reason: 'invalid-token',
      detail: body?.description ?? `HTTP ${response.status}`,
    }
  }
  const username = body.result?.username
  if (!username) {
    return { ok: false, reason: 'invalid-token', detail: 'getMe result has no username' }
  }
  return { ok: true, username }
}

function chunkText(text: string): string[] {
  if (text.length <= MAX_TELEGRAM_TEXT) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > MAX_TELEGRAM_TEXT) {
    let cut = rest.lastIndexOf('\n\n', MAX_TELEGRAM_TEXT)
    if (cut < MAX_TELEGRAM_TEXT / 2) cut = rest.lastIndexOf('\n', MAX_TELEGRAM_TEXT)
    if (cut < MAX_TELEGRAM_TEXT / 2) cut = rest.lastIndexOf(' ', MAX_TELEGRAM_TEXT)
    if (cut <= 0) cut = MAX_TELEGRAM_TEXT
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ── Markdown → Telegram MarkdownV2 ──────────────────────────────────────
// Agents write GitHub-Flavored Markdown (GFM) — the "natural" markdown they
// know. Telegram's MarkdownV2 is stricter: every special char outside a
// formatting span (_ * [ ] ( ) ~ ` > # + - = | { } . !) must be backslash-
// escaped or the Bot API rejects the WHOLE message (400 "can't parse
// entities") — it never arrives. This tokenizer translates GFM → valid
// MarkdownV2: bold/italic/strike/code/links/spoilers map to TG syntax, every
// other special char is escaped. Ported from the legacy telegram-connect
// channel, where it was proven in production. On a parse error the send path
// falls back to plain text (see sendChunkResilient), so even a converter miss
// never loses the message — at worst it arrives unformatted instead of lost.
const MDV2_PLAIN_SPECIAL = '_*[]()~`>#+-=|{}.!'

function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false
  return /[\p{L}\p{N}_]/u.test(ch)
}

function escapeCodeContent(text: string): string {
  // Inside code spans Telegram MarkdownV2 only requires escaping `\` and `` ` ``.
  let out = ''
  for (const c of text) {
    if (c === '\\' || c === '`') out += '\\' + c
    else out += c
  }
  return out
}

// MarkdownV2 has no heading syntax — render GFM headings (`# Title`) as bold so
// they don't arrive as a literal "# Title". Runs before the tokenizer; the
// emitted **Title** is then mapped to TG bold by escapeMarkdownV2Auto.
function headingsToBold(text: string): string {
  return text.replace(
    /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm,
    (_m, _hashes, title) => `**${title}**`,
  )
}

function escapeMarkdownV2Auto(text: string): string {
  let out = ''
  let i = 0
  const n = text.length

  while (i < n) {
    const c = text[i]
    const prev = i > 0 ? text[i - 1] : undefined

    // 1. Fenced code block: ```...```
    if (c === '`' && text.startsWith('```', i)) {
      const end = text.indexOf('```', i + 3)
      if (end !== -1) {
        const inner = text.slice(i + 3, end)
        out += '```' + escapeCodeContent(inner) + '```'
        i = end + 3
        continue
      }
    }

    // 2. Inline code: `...`
    if (c === '`') {
      const end = text.indexOf('`', i + 1)
      if (end !== -1 && end !== i + 1) {
        const inner = text.slice(i + 1, end)
        out += '`' + escapeCodeContent(inner) + '`'
        i = end + 1
        continue
      }
    }

    // 3. Spoiler: ||...||
    if (c === '|' && text.startsWith('||', i)) {
      const end = text.indexOf('||', i + 2)
      if (end !== -1) {
        const inner = text.slice(i + 2, end)
        out += '||' + escapeMarkdownV2Auto(inner) + '||'
        i = end + 2
        continue
      }
    }

    // 4. Link: [text](url) with balanced parens inside url.
    if (c === '[') {
      const closeBracket = text.indexOf(']', i + 1)
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        let depth = 1
        let j = closeBracket + 2
        while (j < n && depth > 0) {
          if (text[j] === '\\' && j + 1 < n) {
            j += 2
            continue
          }
          if (text[j] === '(') depth++
          else if (text[j] === ')') depth--
          if (depth === 0) break
          j++
        }
        if (depth === 0 && j < n) {
          const linkText = text.slice(i + 1, closeBracket)
          const url = text.slice(closeBracket + 2, j)
          // Inside link text — recurse for nested formatting.
          // Inside URL — escape only `\` and `)` per Telegram spec.
          const urlEscaped = url.replace(/[\\)]/g, '\\$&')
          out += '[' + escapeMarkdownV2Auto(linkText) + '](' + urlEscaped + ')'
          i = j + 1
          continue
        }
      }
    }

    // 5. Bold: **text** (GFM double-asterisk). Single * stays literal.
    if (c === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2)
      if (end !== -1 && end !== i + 2) {
        const inner = text.slice(i + 2, end)
        out += '*' + escapeMarkdownV2Auto(inner) + '*'
        i = end + 2
        continue
      }
    }

    // 6. Strikethrough: ~~text~~ (GFM double-tilde). Single ~ stays literal.
    if (c === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2)
      if (end !== -1 && end !== i + 2) {
        const inner = text.slice(i + 2, end)
        out += '~' + escapeMarkdownV2Auto(inner) + '~'
        i = end + 2
        continue
      }
    }

    // 7. Italic: _..._ ONLY at word boundary. snake_case_var stays literal.
    if (c === '_' && !isWordChar(prev)) {
      let matched = false
      for (let j = i + 1; j < n; j++) {
        if (text[j] === '\\') {
          j++
          continue
        }
        if (text[j] === '_') {
          const after = j + 1 < n ? text[j + 1] : undefined
          if (!isWordChar(after) && j > i + 1) {
            const inner = text.slice(i + 1, j)
            out += '_' + escapeMarkdownV2Auto(inner) + '_'
            i = j + 1
            matched = true
          }
          break
        }
      }
      if (matched) continue
    }

    // 8. Plain char — escape if special, else pass through.
    if (c === '\\') {
      // Pre-escaped pair from caller? Pass through.
      if (i + 1 < n && MDV2_PLAIN_SPECIAL.includes(text[i + 1])) {
        out += '\\' + text[i + 1]
        i += 2
        continue
      }
      // Lone backslash → escape it.
      out += '\\\\'
      i++
      continue
    }
    if (MDV2_PLAIN_SPECIAL.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
    i++
  }
  return out
}

// Public entry: agent text (GFM) → valid Telegram MarkdownV2.
export function toTelegramMarkdownV2(text: string): string {
  return escapeMarkdownV2Auto(headingsToBold(text))
}

// A client-side 400 from the Bot API on the MarkdownV2 attempt — the signal to
// resend the chunk as PLAIN text instead of losing it. Two formatting-class
// failures qualify: the converter produced something MarkdownV2 can't parse
// ("can't parse entities"), or backslash-escaping pushed the chunk past
// Telegram's 4096-char cap ("...is too long" — chunkText splits the ORIGINAL
// text at 4096, but escaping only adds characters, so a tag/punctuation-heavy
// chunk can overflow once escaped). Both are cured by sending the original
// (shorter, unescaped) text plain. Transport failures (timeout/network/429/5xx)
// are NOT cured by a plain resend and must bubble to the retry loop, so they
// are deliberately excluded here.
function isFormattingError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    /can'?t parse entities|is too long/i.test(err.description ?? '')
  )
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '') || 'file'
}

async function downloadTelegramFile(args: {
  bot: Bot
  token: string
  botKey: string
  fileId: string
  uniqueId?: string
  kind: string
}): Promise<string> {
  const file = await args.bot.api.getFile(args.fileId)
  if (!file.file_path) throw new TelegramRuntimeError('Telegram returned no file_path')
  const url = `https://api.telegram.org/file/bot${args.token}/${file.file_path}`
  const response = await runtimeFetch(url)
  if (!response.ok) {
    throw new TelegramRuntimeError(`Telegram file download failed: HTTP ${response.status}`)
  }
  const rawExt = file.file_path.includes('.') ? file.file_path.split('.').pop()! : args.kind
  const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || args.kind
  const dir = join(inboxRoot(), args.botKey)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(
    dir,
    `${Date.now()}-${safeFilePart(args.uniqueId ?? file.file_unique_id ?? args.fileId)}.${ext}`,
  )
  writeFileSync(path, Buffer.from(await response.arrayBuffer()), { mode: 0o600 })
  return path
}

// Map a (lowercased) file extension to the Telegram Bot API send method and the
// multipart field name it expects. Pure + exported so the routing is unit-testable
// without touching the network.
export function selectSendMethod(ext: string): {
  method: 'sendVoice' | 'sendAudio' | 'sendPhoto' | 'sendDocument'
  field: 'voice' | 'audio' | 'photo' | 'document'
} {
  if (VOICE_EXTS.has(ext)) return { method: 'sendVoice', field: 'voice' }
  if (AUDIO_EXTS.has(ext)) return { method: 'sendAudio', field: 'audio' }
  if (PHOTO_EXTS.has(ext)) return { method: 'sendPhoto', field: 'photo' }
  return { method: 'sendDocument', field: 'document' }
}

async function sendFileViaRawApi(args: {
  credential: BotCredential
  chatId: string
  filePath: string
}): Promise<number> {
  const stat = statSync(args.filePath)
  if (stat.size > 50 * 1024 * 1024) {
    throw new TelegramRuntimeError(`file too large for Telegram Bot API: ${args.filePath}`)
  }
  const ext = extname(args.filePath).toLowerCase()
  const { method, field } = selectSendMethod(ext)
  logOutbound('attachment.send', { file: basename(args.filePath), ext, method, bytes: stat.size })
  const form = new FormData()
  form.append('chat_id', args.chatId)
  form.append(field, new File([readFileSync(args.filePath)], basename(args.filePath)))
  const response = await runtimeFetch(
    `https://api.telegram.org/bot${args.credential.token}/${method}`,
    { method: 'POST', body: form },
  )
  const json = (await response.json()) as {
    ok?: boolean
    description?: string
    result?: { message_id?: number }
  }
  if (!json.ok) {
    throw new TelegramRuntimeError(`${method} failed: ${json.description ?? 'unknown error'}`)
  }
  return Number(json.result?.message_id ?? 0)
}

function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*)"`)
  const m = re.exec(attrs)
  return m ? unescapeAttr(m[1]) : undefined
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function decodeCdata(inner: string): string {
  if (!inner.startsWith('<![CDATA[') || !inner.endsWith(']]>')) return inner
  return inner.slice('<![CDATA['.length, -']]>'.length).replaceAll(']]]]><![CDATA[>', ']]>')
}

// Find `needle` in `s` at/after `from`, ignoring any occurrence INSIDE a
// <![CDATA[ … ]]> section. The IAP sender CDATA-wraps the message and
// attachments, so a body that literally contains "</message>" or "</iap>" (an
// agent quoting the envelope's own tag names) must NOT be mistaken for the
// structural closing tag — otherwise the envelope is truncated and the message
// is lost or corrupted. The sender's "]]>" escape (`]]]]><![CDATA[>`) is a CDATA
// close immediately followed by a reopen, so a plain open/close state toggle
// skips it correctly without special-casing. With no CDATA present this behaves
// exactly like indexOf, so legacy non-CDATA envelopes are unaffected.
function indexOfOutsideCdata(s: string, needle: string, from = 0): number {
  let i = from
  let inCdata = false
  while (i < s.length) {
    if (inCdata) {
      if (s.startsWith(']]>', i)) {
        inCdata = false
        i += 3
        continue
      }
      i++
      continue
    }
    if (s.startsWith('<![CDATA[', i)) {
      inCdata = true
      i += '<![CDATA['.length
      continue
    }
    if (s.startsWith(needle, i)) return i
    i++
  }
  return -1
}

function tagContent(xml: string, tag: string): string | undefined {
  const open = `<${tag}>`
  const start = xml.indexOf(open)
  if (start < 0) return undefined
  const innerStart = start + open.length
  // Close on the structural </tag>, skipping identical tag text inside CDATA.
  const end = indexOfOutsideCdata(xml, `</${tag}>`, innerStart)
  if (end < 0) return undefined
  return decodeCdata(xml.slice(innerStart, end))
}

export function parseIapEnvelope(xml: string): IapEnvelope {
  // Normalize line endings before parsing. Defensive and transport-agnostic: a
  // raw-mode pty stdin can surface bare CRs instead of LFs, and Telegram does not
  // render \r as a line break, so multi-line replies (and code blocks) would
  // collapse to one paragraph. Fold \r\n and lone \r → \n once, over the whole
  // envelope: message and attachments both come out LF-terminated. The attachments
  // split (/\r?\n/) and the MarkdownV2 converter are unaffected — they key on \n.
  xml = xml.replace(/\r\n?/g, '\n')
  const open = /^<iap\s+([^>]*)>/.exec(xml.trim())
  if (!open) throw new TelegramRuntimeError('invalid IAP envelope: missing <iap ...>')
  const fromPersonality = attrValue(open[1], 'from-personality')
  const fromRuntime = attrValue(open[1], 'from-runtime')
  if (!fromPersonality || !fromRuntime) {
    throw new TelegramRuntimeError('invalid IAP envelope: missing from-personality/from-runtime')
  }
  const fromIntelligenceRaw = attrValue(open[1], 'from-intelligence')
  const fromIntelligence = isIntelligence(fromIntelligenceRaw) ? fromIntelligenceRaw : undefined
  const message = tagContent(xml, 'message')
  if (message === undefined) throw new TelegramRuntimeError('invalid IAP envelope: missing message')
  const attachmentsRaw = tagContent(xml, 'attachments')
  return {
    fromPersonality,
    fromRuntime,
    ...(fromIntelligence ? { fromIntelligence } : {}),
    topic: attrValue(open[1], 'topic'),
    attachments: attachmentsRaw
      ? attachmentsRaw.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
      : [],
    message,
  }
}

export function extractIapEnvelopes(buffer: string): { envelopes: string[]; rest: string } {
  const envelopes: string[] = []
  let rest = buffer
  while (true) {
    const start = rest.indexOf('<iap ')
    if (start < 0) {
      return { envelopes, rest: rest.slice(Math.max(0, rest.length - 8)) }
    }
    if (start > 0) rest = rest.slice(start)
    // The envelope-closing </iap> must be matched OUTSIDE any CDATA: a message
    // body that literally contains "</iap>" is CDATA-wrapped by the sender and
    // must not truncate the envelope here (which would drop the message).
    const end = indexOfOutsideCdata(rest, '</iap>')
    if (end < 0) return { envelopes, rest }
    const envelopeEnd = end + '</iap>'.length
    envelopes.push(rest.slice(0, envelopeEnd))
    rest = rest.slice(envelopeEnd)
  }
}

function iapEnv(owner: PeerProfile): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PEER_PERSONALITY: owner.personality,
    PEER_RUNTIME: RUNTIME,
    PEER_IDENTITY: `${RUNTIME}-${owner.personality}`,
  }
}

export type IapSendResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; detail: string; stdout: string; stderr: string; timedOut?: boolean; timeoutMs?: number }

function cleanIapSendDetail(detail: string): string {
  return detail
    .replace(/^\s*iapeer\s+send:\s*/i, '')
    .replace(/^\s*iap\s+send\s+failed:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseLogfmtValue(line: string, key: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${key}=(?:"((?:\\\\.|[^"\\\\])*)"|(\\S+))`)
  const m = re.exec(line)
  if (!m) return undefined
  if (m[1] !== undefined) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  return m[2]
}

// Accept both today's CLI shape (non-zero + stderr "iapeer send: <err>") and
// the lower-level/result-shaped vocabulary from the daemon/log path
// (ok=false err=..., or a JSON line with ok:false). This keeps the bridge on the
// contract word ("ok=false + err") instead of one concrete CLI presentation.
function parseIapSendNotOk(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`
  for (const rawLine of combined.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (obj.ok === false) {
          const detail = obj.err ?? obj.error ?? obj.reason ?? obj.detail
          return cleanIapSendDetail(typeof detail === 'string' && detail ? detail : 'delivery failed')
        }
      } catch {}
    }
    if (/\bok=false\b/.test(line)) {
      const detail =
        parseLogfmtValue(line, 'err') ??
        parseLogfmtValue(line, 'error') ??
        parseLogfmtValue(line, 'reason') ??
        parseLogfmtValue(line, 'detail')
      return cleanIapSendDetail(detail ?? 'delivery failed')
    }
  }
  return null
}

function formatTimeoutSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000))
}

export function iapDeliveryFailureVerdict(result: Extract<IapSendResult, { ok: false }>): string {
  if (result.timedOut) {
    return `not delivered: delivery timed out after ${formatTimeoutSeconds(result.timeoutMs ?? IAP_SEND_TIMEOUT_MS)}s — check the session`
  }
  return `not delivered: ${cleanIapSendDetail(result.detail) || 'delivery failed'}`
}

export async function runIapSendCommand(args: {
  bin: string
  cwd: string
  env: NodeJS.ProcessEnv
  targetPersonality: string
  message: string
  attachments: string[]
  timeoutMs?: number
}): Promise<IapSendResult> {
  const timeoutMs = args.timeoutMs ?? IAP_SEND_TIMEOUT_MS
  const tmp = join(tmpdir(), `telegram-runtime-${process.pid}-${Date.now()}-${randomUUID()}.txt`)
  writeFileSync(tmp, args.message || '(message)', { mode: 0o600 })
  try {
    const argv = ['send', args.targetPersonality, '--message-file', tmp]
    for (const attachment of args.attachments) {
      argv.push('--attachment', attachment)
    }
    return await new Promise<IapSendResult>(resolve => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let child: ReturnType<typeof spawn> | undefined
      const finish = (result: IapSendResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        try {
          child?.kill('SIGKILL')
        } catch {}
        finish({
          ok: false,
          detail: `delivery timed out after ${formatTimeoutSeconds(timeoutMs)}s`,
          stdout,
          stderr,
          timedOut: true,
          timeoutMs,
        })
      }, timeoutMs)
      try {
        child = spawn(args.bin, argv, {
          cwd: args.cwd,
          env: args.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        finish({
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
          stdout,
          stderr,
        })
        return
      }
      child.stdout?.on('data', data => (stdout += String(data)))
      child.stderr?.on('data', data => (stderr += String(data)))
      child.on('error', err => finish({ ok: false, detail: err.message, stdout, stderr }))
      child.on('close', status => {
        const notOk = parseIapSendNotOk(stdout, stderr)
        if (notOk) {
          finish({ ok: false, detail: notOk, stdout, stderr })
          return
        }
        if (status === 0) {
          finish({ ok: true, stdout, stderr })
          return
        }
        const detail = cleanIapSendDetail((stderr || stdout || `exit ${status}`).trim())
        finish({ ok: false, detail, stdout, stderr })
      })
    })
  } finally {
    rmSync(tmp, { force: true })
  }
}

function runIapSend(
  ctx: RuntimeContext,
  targetPersonality: string,
  message: string,
  attachments: string[],
): Promise<IapSendResult> {
  return runIapSendCommand({
    bin: ctx.iapBin,
    cwd: ctx.cwd,
    env: iapEnv(ctx.owner),
    targetPersonality,
    message,
    attachments,
  })
}

let inboundIapQueue = Promise.resolve()

function enqueueIapSend(task: () => Promise<void> | void): void {
  inboundIapQueue = inboundIapQueue
    .then(async () => task())
    .catch(err => {
      process.stderr.write(`telegram-runtime: inbound delivery failed: ${formatError(err)}\n`)
    })
}

let outboundTelegramQueue = Promise.resolve()
// Depth of the serial outbound queue: incremented at enqueue, decremented when
// the task settles. A growing depth with no matching `queue.dequeue` is the
// fingerprint of a wedged queue (a never-settling send blocking everything
// behind it) — exactly the failure that returns ok to send_to_peer while the
// human receives nothing.
let outboundQueueDepth = 0

function enqueueOutbound(task: () => Promise<void> | void): void {
  outboundQueueDepth++
  logOutbound('queue.enqueue', { depth: outboundQueueDepth })
  outboundTelegramQueue = outboundTelegramQueue
    .then(async () => task())
    .catch(err => {
      process.stderr.write(`telegram-runtime: outbound delivery failed: ${formatError(err)}\n`)
    })
    .finally(() => {
      outboundQueueDepth--
      logOutbound('queue.dequeue', { depth: outboundQueueDepth })
    })
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Structured observability for the outbound Telegram path. Every send emits a
// timestamped one-line JSON event to stderr (captured by launchd in
// .iapeer/logs/persistent-peer/launchd-stderr.log). This is the channel that
// was empty during the outbound-stall incidents — so the absence of a
// `chunk.error`/`chunk.timeout` after a `chunk.start` is itself the signal that
// the call hung without ever throwing (vs. a thrown 429, which would surface as
// `chunk.error` with tgCode:429). Disable with TELEGRAM_OUTBOUND_LOG=0.
const OUTBOUND_LOG_ENABLED = process.env.TELEGRAM_OUTBOUND_LOG !== '0'

function logOutbound(event: string, fields: Record<string, unknown> = {}): void {
  if (!OUTBOUND_LOG_ENABLED) return
  const payload: Record<string, unknown> = { ts: new Date().toISOString(), evt: event }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) payload[k] = v
  }
  process.stderr.write(`telegram-runtime outbound ${JSON.stringify(payload)}\n`)
}

// Classify an outbound send failure so the log distinguishes the failure modes
// that matter for the stall diagnosis: a Telegram API rejection (e.g. 429 with
// retry_after) vs. a client-side timeout (AbortSignal fired) vs. a raw network
// error. grammy wraps an aborted fetch in HttpError, so the abort is checked
// both directly and through the HttpError wrapper.
function classifyOutboundError(err: unknown): {
  kind: 'api' | 'timeout' | 'network' | 'unknown'
  tgCode?: number
  retryAfter?: number
  detail: string
} {
  const detail = formatError(err)
  if (err instanceof GrammyError) {
    return { kind: 'api', tgCode: err.error_code, retryAfter: err.parameters?.retry_after, detail }
  }
  const isAbort = (e: unknown): boolean => {
    const n = (e as { name?: string } | null)?.name
    return n === 'TimeoutError' || n === 'AbortError'
  }
  if (isAbort(err) || /abort|timed out|timeout/i.test(detail)) {
    return { kind: 'timeout', detail }
  }
  if (err instanceof HttpError) {
    return { kind: isAbort((err as { error?: unknown }).error) ? 'timeout' : 'network', detail }
  }
  return { kind: 'unknown', detail }
}

// Telegram "typing…" while the target peer is actively processing a turn.
// A working peer emits output continuously (the spinner / elapsed-time / token
// counter tick ~1Hz) and goes quiescent when idle — so "the peer's pane-log
// advanced since the last poll" (paneLogAgeMs < PANELOG_BUSY_MS) is a
// runtime-agnostic "still working" signal (verified for both Claude and Codex).
// Typing is refreshed every poll (the Telegram indicator lapses in ~5s) until the
// pane-log goes quiescent or the cap is hit; TYPING_MIN_MS keeps it on through the
// brief startup window before the peer's first byte. One watcher per peer. Disable
// with TELEGRAM_TYPING=0.
const TYPING_POLL_MS = Number(process.env.TELEGRAM_TYPING_POLL_MS ?? '') || 3000
// Anti-runaway backstop, NOT a turn limit: the real stop is the pane going
// static (turn done). High enough that a genuine long reply is never cut; only
// a pathological never-static pane would hit it. 30 min default.
const TYPING_CAP_MS = Number(process.env.TELEGRAM_TYPING_CAP_MS ?? '') || 1_800_000
const TYPING_MIN_MS = Number(process.env.TELEGRAM_TYPING_MIN_MS ?? '') || 5000
// Busy/idle threshold for the pane-log occupancy source (see paneLogAgeMs). A
// peer is "still working" while its pane-log advanced within this window; the
// turn is over once output goes quiescent past it. Verified live (14.06): a busy
// peer's mtime never stalled >~1s (spinner/elapsed-timer repaint ~1Hz), idle
// peers froze for minutes-to-hours — so 4s cleanly separates the two without
// fragmenting a turn on thinking pauses. Tunable; raise if a runtime ever proves
// to emit on a slower cadence mid-turn.
const PANELOG_BUSY_MS = Number(process.env.TELEGRAM_PANELOG_BUSY_MS ?? '') || 4000
// One watcher per peer, shared by the typing indicator and the activity stream
// (they poll the same pane on the same cadence — see watchPeerTurn).
const activeWatchers = new Set<string>()

// The ONE coupling point between the (otherwise independent) activity channel and
// the outbound path (v0.7). Problem: the activity status is a single message
// edited in place, so when a peer sends a normal outbound message mid-turn it
// lands BELOW the status — the stream gets stuck ABOVE the answers (actions on
// top, answers below — illogical). Fix: a peer's outbound send finalizes that
// peer's current status (collapse to "✓ N шагов" in place) and resets it, so the
// NEXT tool call opens a FRESH status message — which lands below the answer.
// Series [activity → answer → activity] then reads top-to-bottom in real order:
// статус1 ✓ → answer → статус2 (new, below). Keyed by personality; a callback is
// registered only while a watcher with an active activity stream is live.
const activityCheckpoints = new Map<string, () => void>()

// Signal the live activity watcher for `personality` (if any) to finalize+reset
// its status message. Best-effort and non-blocking — never gates delivery.
function checkpointActivity(personality: string): void {
  activityCheckpoints.get(personality)?.()
}

// Occupancy source for both progress channels (typing + the activity stream). Under
// pty hosting the iapeer supervisor writes each hosted peer's raw child byte-stream to
// ~/.iapeer/logs/lifecycle/<runtime>-<personality>.log; this poller keys off that
// file's mtime (see paneLogAgeMs) to gate the turn lifecycle — typing directly, and
// the tool-call stream because watchPeerTurn's `done` gate is owned here (no live
// output signal → instant turn-end → activity-loop stops). Keyed by identity. Honours
// IAPEER_ROOT (sandbox/test). LOAD-BEARING cross-package contract owned by iapeer's pty
// supervisor — its path/format is the seam; any change is coordinated with iapeer.
function paneLogPath(target: PeerRecord): string {
  return join(iapeerRoot(), 'logs', 'lifecycle', `${target.runtime}-${target.personality}.log`)
}

// Milliseconds since the peer's pane-log last advanced (= since its last byte of
// output) — the busy/idle proxy that replaces diffing pane CONTENT. A small age =
// the peer is actively working (spinner/elapsed-timer repaint keeps it fresh,
// including through thinking pauses); a large/growing age = the turn has ended and
// the prompt is quiescent. null if the log is missing/unreadable — callers treat
// that as idle (a missing log = no live peer output to stream).
function paneLogAgeMs(target: PeerRecord): number | null {
  try {
    return Date.now() - statSync(paneLogPath(target)).mtimeMs
  } catch {
    return null
  }
}

// ── Agent-activity progress channel ─────────────────────────────────────
// A SECOND, separate channel from send_to_peer: while a peer works on a turn,
// telegram-runtime tails the peer's own transcript (the same file Claude/Codex
// already write natively), extracts the sequence of tool calls, and renders
// them into ONE editable status message in the operator's chat ("▸ Read
// README ▸ Bash npm test ▸ send_to_peer <peer> …"). On turn end the
// message is finalized (collapsed to a ✓ summary). send_to_peer is untouched —
// answers still arrive exactly as before; this is best-effort and never blocks
// or shares a queue with the answer path.
//
// Source = polling the transcript, NOT a PostToolUse hook (design decision,
// owner-sanctioned 02.06): the hook needs a carrier plugin + per-agent setup
// and is dead without telegram-runtime; polling lives entirely here and works
// uniformly for claude and codex without touching the agents.
const ACTIVITY_MASTER_ON = process.env.TELEGRAM_ACTIVITY !== '0'
// Default for peers that were never toggled (interfaces.telegram.activity is
// undefined): ON in CODE — a product property, not host configuration (a
// product decision: the fleet's work is visible out of the box; before this the
// default lived in an env var nobody set, so every new peer required a manual
// /activity). Priority ladder: per-peer /activity toggle (strongest, both
// directions) → TELEGRAM_ACTIVITY=0 master kill / TELEGRAM_ACTIVITY_DEFAULT=0
// default opt-out (env, host-level escape hatches) → this code default.
const ACTIVITY_DEFAULT_ON = process.env.TELEGRAM_ACTIVITY_DEFAULT !== '0'
// Realtime cadence (release v0.5). The activity stream runs on its OWN fast
// poller (watchPeerTurn), decoupled from the 3s typing poll — lowering the
// shared typing cadence would over-send sendChatAction. We poll the transcript
// every ACTIVITY_POLL_MS for snappy detection, but edit at most once per
// ACTIVITY_EDIT_INTERVAL_MS: Telegram documents ~1 message/sec to a single chat
// (core.telegram.org/bots/faq) and edits are subject to the same flood limit;
// 1s is the practical per-chat ceiling. On a 429 we honour parameters.retry_after
// (backoff until then) — see flush() in watchPeerTurn.
const ACTIVITY_POLL_MS = Number(process.env.TELEGRAM_ACTIVITY_POLL_MS ?? '') || 500
const ACTIVITY_EDIT_INTERVAL_MS = Number(process.env.TELEGRAM_ACTIVITY_EDIT_MS ?? '') || 1000
// How many trailing gesture lines to keep visible (older ones collapse behind a
// leading "⋯"). Bounds message length under Telegram's 4096 cap; the final
// collapse drops the list entirely anyway.
const ACTIVITY_MAX_STEPS = Number(process.env.TELEGRAM_ACTIVITY_MAX_STEPS ?? '') || 30
const ACTIVITY_LOG_ENABLED = process.env.TELEGRAM_ACTIVITY_LOG !== '0'
// Codex sessions are date-partitioned and keyed by session id, not cwd, so the
// active rollout is located by scanning recently-modified rollout files and
// matching session_meta.cwd. Bound the scan to sessions touched this recently.
const CODEX_SESSION_WINDOW_MS = Number(process.env.TELEGRAM_CODEX_WINDOW_MS ?? '') || 6 * 3600_000

type ToolEvent = { tool: string; label?: string }

function logActivity(event: string, fields: Record<string, unknown> = {}): void {
  if (!ACTIVITY_LOG_ENABLED) return
  const payload: Record<string, unknown> = { ts: new Date().toISOString(), evt: event }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) payload[k] = v
  }
  process.stderr.write(`telegram-runtime activity ${JSON.stringify(payload)}\n`)
}

function activityEnabledForPeer(target: PeerRecord): boolean {
  if (!ACTIVITY_MASTER_ON) return false
  const tg = telegramInterface(target)
  // Read fresh from the (hydrated) profile every turn → toggling on/off, or a
  // brand-new peer with interfaces.telegram, takes effect with no runtime restart.
  if (typeof tg.activity === 'boolean') return tg.activity
  return ACTIVITY_DEFAULT_ON
}

// Strip an MCP tool's mcp__<server>__<tool> prefix down to the bare tool name
// (the gesture the operator recognises): mcp__plugin_…_iap__send_to_peer →
// send_to_peer. Non-MCP tool names pass through unchanged.
export function shortToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const idx = name.lastIndexOf('__')
    if (idx >= 0 && idx + 2 < name.length) return name.slice(idx + 2)
  }
  return name
}

export function isOutboundGesture(name: string): boolean {
  return shortToolName(name) === 'send_to_peer'
}

// Decide whether to HIDE a send_to_peer gesture, target-aware (v0.8.2):
//   • to the human OPERATOR of the chat → HIDE. That send is already shown as the
//     delivered message, AND it is the one whose transcript gesture raced the
//     outbound checkpoint into a hung post-status (the v0.8.1 desync). isOperator
//     identifies operator (human) targets.
//   • to another AGENT (agent→agent, e.g. boris→linus) → KEEP. The owner wants
//     cross-agent communication visible in the stream.
// Non-send tools are never hidden. With NO operator predicate (pure callers /
// tests) ALL send_to_peer is hidden — the conservative v0.8.1 default. A
// send_to_peer with no resolvable target is hidden too (cannot prove it is agent-
// bound, and it is the noisier/riskier case).
function hideSendGesture(
  name: string,
  target: string | undefined,
  isOperator?: (personality: string) => boolean,
): boolean {
  if (!isOutboundGesture(name)) return false
  if (!isOperator) return true
  return !target || isOperator(target)
}

// Extract the send_to_peer target personality from a Codex function_call's
// JSON-string arguments (v0.8.2).
function codexSendTarget(args: unknown): string | undefined {
  if (typeof args !== 'string' || !args) return undefined
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    return typeof parsed.personality === 'string' ? parsed.personality : undefined
  } catch {
    return undefined
  }
}

// Normalize a label to a single line (newlines/runs of whitespace → one space).
// NO length truncation (v0.6): the operator wanted the full label text — it all
// collapses to "✓ N шагов" at turn end anyway, so clipping mid-turn just hides
// substance. The only length guard is at the whole-message level in
// renderActivity (Telegram's 4096 cap), not per-label.
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

// A gesture, NOT content: a non-private hint (filename / peer name / the agent's
// own description). Never the full file body or large argument blobs — those can
// be big and private (design constraint). For Bash we use the agent's own
// description (a deliberate, safe summary), falling back to the command verb only.
// For Skill we surface the skill name (NOT its `args`, which carry the full task
// text and are private). For the subagent spawn (Agent — the live tool name in
// claude transcripts; older harnesses named it Task) we surface the subagent type
// or the agent's own short description, NEVER the prompt (large, private). v0.7.
export function toolLabel(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const inp = input as Record<string, unknown>
  const short = shortToolName(name)
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  if (short === 'Bash') {
    const desc = str(inp.description)
    if (desc) return oneLine(desc)
    const cmd = str(inp.command)
    if (cmd) return oneLine(cmd.trim().split(/\s+/)[0] ?? '')
    return undefined
  }
  if (short === 'Read' || short === 'Edit' || short === 'Write' || short === 'NotebookEdit') {
    const fp = str(inp.file_path) ?? str(inp.notebook_path)
    return fp ? oneLine(basename(fp)) : undefined
  }
  if (short === 'send_to_peer') return str(inp.personality)
  if (short === 'Skill') {
    const skill = str(inp.skill) ?? str(inp.name)
    return skill ? oneLine(skill) : undefined
  }
  if (short === 'Task' || short === 'Agent') {
    const sub = str(inp.subagent_type) ?? str(inp.description)
    return sub ? oneLine(sub) : undefined
  }
  const generic = str(inp.query) ?? str(inp.pattern) ?? str(inp.description)
  return generic ? oneLine(generic) : undefined
}

// Extract tool-call gestures from one parsed Claude transcript line. Skips
// sidechain (subagent) lines — those are the Task agent's own internal context;
// the parent's gesture stream shows the Task spawn itself, not its internals.
// isOperator (v0.8.2) lets operator-bound send_to_peer be hidden while agent→agent
// sends stay visible — see hideSendGesture.
export function claudeLineEvents(
  obj: unknown,
  isOperator?: (personality: string) => boolean,
): ToolEvent[] {
  const o = obj as Record<string, any> | null
  if (!o || o.type !== 'assistant' || o.isSidechain) return []
  const content = o.message?.content
  if (!Array.isArray(content)) return []
  const out: ToolEvent[] = []
  for (const c of content) {
    if (c && c.type === 'tool_use' && typeof c.name === 'string') {
      const target = typeof c.input?.personality === 'string' ? c.input.personality : undefined
      if (hideSendGesture(c.name, target, isOperator)) continue // operator-bound send (v0.8.1/.2)
      const label = toolLabel(c.name, c.input)
      out.push(label ? { tool: shortToolName(c.name), label } : { tool: shortToolName(c.name) })
    }
  }
  return out
}

// Current context occupancy in tokens for the completion line (v0.8): the prompt
// size of the most recent MAIN-chain assistant turn (input + both cache buckets).
// A raw count, NOT a percent — so it is context-window-INDEPENDENT and renders
// identically regardless of the peer's model (200k vs 1M) and cross-runtime.
// Sidechain (subagent) usage is skipped: the PARENT thread's context is what fills.
export function claudeContextTokens(obj: unknown): number | null {
  const o = obj as Record<string, any> | null
  if (!o || o.type !== 'assistant' || o.isSidechain) return null
  const u = o.message?.usage
  if (!u || typeof u !== 'object') return null
  const n = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0)
  const total =
    n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
  return total > 0 ? total : null
}

function codexCallLabel(name: string, args: unknown): string | undefined {
  if (typeof args !== 'string' || !args) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(args) as Record<string, unknown>
  } catch {
    return undefined
  }
  const cmd = parsed.cmd ?? parsed.command
  if ((name === 'exec_command' || name === 'shell' || name === 'bash') && typeof cmd === 'string') {
    return oneLine(cmd.trim().split(/\s+/)[0] ?? '')
  }
  const fp = parsed.file_path ?? parsed.path
  if (typeof fp === 'string') return basename(fp)
  return undefined
}

// Extract tool-call gestures from one parsed Codex rollout line. Codex records
// tool calls as response_item payloads (function_call / custom_tool_call /
// tool_search_call) — a different schema from Claude's tool_use blocks.
// isOperator (v0.8.2): see hideSendGesture / claudeLineEvents.
export function codexLineEvents(
  obj: unknown,
  isOperator?: (personality: string) => boolean,
): ToolEvent[] {
  const o = obj as Record<string, any> | null
  if (!o || o.type !== 'response_item') return []
  const p = o.payload
  if (!p || typeof p !== 'object') return []
  const t = p.type
  if (t === 'function_call' && typeof p.name === 'string') {
    if (isOutboundGesture(p.name)) {
      const target = codexSendTarget(p.arguments)
      if (hideSendGesture(p.name, target, isOperator)) return [] // operator-bound (v0.8.1/.2)
      return [{ tool: 'send_to_peer', label: target }] // agent→agent — keep, label = target
    }
    const label = codexCallLabel(p.name, p.arguments)
    const tool = shortToolName(p.name)
    return [label ? { tool, label } : { tool }]
  }
  if ((t === 'custom_tool_call' || t === 'local_shell_call') && typeof p.name === 'string') {
    if (hideSendGesture(p.name, undefined, isOperator)) return [] // operator-bound (v0.8.1/.2)
    return [{ tool: shortToolName(p.name) }]
  }
  if (t === 'local_shell_call') return [{ tool: 'shell' }]
  if (t === 'tool_search_call') return [{ tool: 'tool_search' }]
  if (t === 'image_generation_call') return [{ tool: 'image_generation' }]
  return []
}

// Codex equivalent of claudeContextTokens (v0.8). Codex emits token_count
// payloads carrying info.last_token_usage (this turn) and info.total_token_usage
// (session cumulative). Context OCCUPANCY = the last turn's input size
// (input_tokens already includes the cached portion) — the same "prompt size now"
// semantic as the claude path, so the "· N tokens" suffix means the same thing on
// both runtimes. (Codex also reports info.model_context_window, deliberately
// unused: we show the raw count, never a window-relative %.)
export function codexContextTokens(obj: unknown): number | null {
  const p = (obj as Record<string, any> | null)?.payload
  if (!p || typeof p !== 'object' || p.type !== 'token_count') return null
  const v = p.info?.last_token_usage?.input_tokens
  return typeof v === 'number' && v > 0 ? v : null
}

// Past-tense of a splash gerund for the completion line (v0.8): "Pondering" →
// "Pondered", to mirror claude-code's TUI finish ("Churned for 1m 22s"). The
// splash set is all "-ing" forms; strip "ing" and apply the regular rule
// (consonant+y → "ied", else "+ed" — "+ed" also restores the silent-e of -ate/-e
// stems, since "Bak"+"ed" = "Baked", "Forg"+"ed" = "Forged"). The handful of
// English irregulars are overridden by hand.
const PAST_TENSE_IRREGULAR: Record<string, string> = {
  Doing: 'Did',
  Spinning: 'Spun',
  Thinking: 'Thought',
}
export function pastTenseVerb(gerund: string): string {
  const override = PAST_TENSE_IRREGULAR[gerund]
  if (override) return override
  const stem = gerund.endsWith('ing') ? gerund.slice(0, -3) : gerund
  if (/[^aeiou]y$/i.test(stem)) return `${stem.slice(0, -1)}ied`
  return `${stem}ed`
}

// Turn duration in the claude-code style: "45s", "1m 22s", "1h 5m 3s" (v0.8).
// Floors to whole seconds, never below 1s (a turn always took some time).
export function formatTurnDuration(ms: number): string {
  const total = Math.max(1, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// claude-code "splash" working-verbs. One is picked at random at the start of a
// turn and stays STATIC for the whole turn (a new turn → a new word). Purely
// cosmetic header — replaces the old ⚙️ + peer-name line (the operator already
// knows which bot's chat they are in).
const SPLASH_VERBS = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Baking', 'Brewing', 'Calculating',
  'Cerebrating', 'Channelling', 'Churning', 'Clauding', 'Coalescing', 'Cogitating',
  'Computing', 'Concocting', 'Conjuring', 'Considering', 'Cooking', 'Crafting',
  'Creating', 'Crunching', 'Deciphering', 'Deliberating', 'Determining', 'Doing',
  'Effecting', 'Elucidating', 'Enchanting', 'Envisioning', 'Finagling', 'Forging',
  'Forming', 'Generating', 'Germinating', 'Hatching', 'Herding', 'Honking',
  'Hustling', 'Ideating', 'Imagining', 'Incubating', 'Inferring', 'Manifesting',
  'Marinating', 'Meandering', 'Moseying', 'Mulling', 'Mustering', 'Musing',
  'Noodling', 'Percolating', 'Pondering', 'Processing', 'Puttering', 'Puzzling',
  'Reticulating', 'Ruminating', 'Scheming', 'Schlepping', 'Shimmying', 'Simmering',
  'Smooshing', 'Spelunking', 'Spinning', 'Stewing', 'Sussing', 'Synthesizing',
  'Thinking', 'Tinkering', 'Transmuting', 'Unfurling', 'Vibing', 'Wandering',
  'Whirring', 'Wibbling', 'Wizarding', 'Working', 'Wrangling',
]

export function pickSplash(): string {
  return SPLASH_VERBS[Math.floor(Math.random() * SPLASH_VERBS.length)] ?? 'Working'
}

// v0.7 flush gates (pure). Return true to SKIP a status send entirely:
//   • final collapse (active=false) with no status open → never CREATE a status
//     from scratch, so a turn that ends right after a checkpoint leaves no orphan
//     "✓ 0 шагов" tail;
//   • active frame with no status open, no events yet, and splash-only no longer
//     allowed (we are past the turn-start instant splash, i.e. after a checkpoint)
//     → wait for the next real tool call before opening the next status message,
//     so статус2 is born with substance and lands below the answer.
export function skipStatusFlush(
  active: boolean,
  hasStatus: boolean,
  hasEvents: boolean,
  allowSplashOnly: boolean,
): boolean {
  if (!active && !hasStatus) return true
  if (active && !hasStatus && !hasEvents && !allowSplashOnly) return true
  return false
}

// One gesture per line: "▸ <tool>: <label>", or "▸ <tool>" only when the tool
// has no characteristic label (true fallback). The labels ARE the value of the
// feature — they show the substance of each call (see toolLabel) — so they are
// preserved, never stripped wholesale.
function gestureLine(e: ToolEvent): string {
  return e.label ? `▸ ${e.tool}: ${e.label}` : `▸ ${e.tool}`
}

// Render the single status message. Plain text (no parse_mode): tool names like
// send_to_peer contain underscores that MarkdownV2 would choke on, and an
// ephemeral status line must never fail to parse.
//   active: a splash verb on top (re-picked per tool call by the caller), then
//           the (tail of the) gesture list, one per line, growing in realtime.
//           With no tools yet it is just the splash — shown instantly at turn
//           start, before the first tool_use (v0.6).
//   final:  FULL collapse to one line in claude-code's finish style — the splash
//           verb in PAST tense + the turn duration + the context size in tokens
//           ("Pondered for 32s · 680958 tokens", v0.8). The gesture list is
//           dropped so no wall of text stays in history; durationMs is the status
//           message's lifetime (creation → collapse); contextTokens is the raw
//           context-occupancy count (window-independent) or null to omit it.
export function renderActivity(
  splash: string,
  events: ToolEvent[],
  active: boolean,
  durationMs = 0,
  contextTokens: number | null = null,
): string {
  if (!active) {
    const base = `${pastTenseVerb(splash)} for ${formatTurnDuration(durationMs)}`
    return contextTokens != null ? `${base} · ${contextTokens} tokens` : base
  }
  const head = `${splash}…`
  if (events.length === 0) return head
  const build = (evts: ToolEvent[], trunc: boolean): string =>
    [head, ...(trunc ? ['⋯'] : []), ...evts.map(gestureLine)].join('\n')
  let shown = events.slice(-ACTIVITY_MAX_STEPS)
  let truncated = events.length > shown.length
  let text = build(shown, truncated)
  // Whole-message guard for Telegram's 4096 cap. Labels are NOT clipped (v0.6),
  // so an unusually long one could push the message over the limit; drop the
  // oldest lines until it fits rather than let the edit be rejected.
  while (text.length > MAX_TELEGRAM_TEXT && shown.length > 1) {
    shown = shown.slice(1)
    truncated = true
    text = build(shown, truncated)
  }
  return text
}

// Claude stores each project's transcripts under ~/.claude/projects/<dir>, where
// <dir> is the cwd with every non-alphanumeric char replaced by '-' (verified
// e.g. /Users/alice/Projects/app → -Users-alice-Projects-app; dots map too,
// no run-collapsing).
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function latestJsonl(dir: string): string | null {
  let best: { path: string; mtime: number } | null = null
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      const p = join(dir, e.name)
      try {
        const m = statSync(p).mtimeMs
        if (!best || m > best.mtime) best = { path: p, mtime: m }
      } catch {}
    }
  } catch {
    return null
  }
  return best?.path ?? null
}

function claudeTranscriptPath(cwd: string): string | null {
  return latestJsonl(join(homedir(), '.claude', 'projects', claudeProjectDirName(cwd)))
}

function codexTranscriptPath(cwd: string): string | null {
  const root = join(homedir(), '.codex', 'sessions')
  const want = cwd.replace(/\/+$/, '').toLowerCase()
  const cutoff = Date.now() - CODEX_SESSION_WINDOW_MS
  const candidates: { path: string; mtime: number }[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1)
      } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          const m = statSync(p).mtimeMs
          if (m >= cutoff) candidates.push({ path: p, mtime: m })
        } catch {}
      }
    }
  }
  walk(root, 0)
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const c of candidates) {
    try {
      const firstLine = readFileSync(c.path, 'utf8').split('\n', 1)[0]
      const meta = JSON.parse(firstLine)
      const metaCwd = meta?.payload?.cwd ?? meta?.cwd
      if (typeof metaCwd === 'string' && metaCwd.replace(/\/+$/, '').toLowerCase() === want) {
        return c.path
      }
    } catch {}
  }
  return null
}

function activeTranscriptPath(target: PeerRecord): string | null {
  if (!target.cwd) return null
  if (target.runtime === 'codex') return codexTranscriptPath(target.cwd)
  // claude (and any future runtime writing Claude-style JSONL projects)
  return claudeTranscriptPath(target.cwd)
}

type TranscriptReader = { poll: () => ToolEvent[]; contextTokens: () => number | null }

// Tail the peer's transcript for tool-call gestures appended since the last
// poll. Byte-offset tailing (not re-reading the whole file): the offset is
// always advanced to a newline boundary, so each read starts on a clean line;
// a trailing partial line (write in flight) is left for the next poll. Returns
// null if no transcript can be located (→ activity silently disabled this turn).
// Alongside gestures, each poll updates the latest context-token count seen
// (contextTokens) for the v0.8 completion line — same parse pass, no extra read.
function createTranscriptReader(
  target: PeerRecord,
  isOperator?: (personality: string) => boolean,
): TranscriptReader | null {
  const path = activeTranscriptPath(target)
  if (!path) return null
  const parse = target.runtime === 'codex' ? codexLineEvents : claudeLineEvents
  const tokensOf = target.runtime === 'codex' ? codexContextTokens : claudeContextTokens
  let offset = 0
  let lastTokens: number | null = null
  try {
    offset = statSync(path).size
  } catch {
    return null
  }
  return {
    contextTokens: () => lastTokens,
    poll(): ToolEvent[] {
      try {
        const size = statSync(path).size
        if (size < offset) offset = 0 // file rotated/truncated
        if (size <= offset) return []
        const len = size - offset
        const buf = Buffer.allocUnsafe(len)
        const fd = openSync(path, 'r')
        try {
          readSync(fd, buf, 0, len, offset)
        } finally {
          closeSync(fd)
        }
        const text = buf.toString('utf8')
        const lastNl = text.lastIndexOf('\n')
        if (lastNl < 0) return [] // no complete line yet
        const consumed = text.slice(0, lastNl + 1)
        offset += Buffer.byteLength(consumed, 'utf8')
        const events: ToolEvent[] = []
        for (const line of consumed.split('\n')) {
          if (!line.trim()) continue
          let obj: unknown
          try {
            obj = JSON.parse(line)
          } catch {
            continue
          }
          for (const e of parse(obj, isOperator)) events.push(e)
          const t = tokensOf(obj)
          if (t !== null) lastTokens = t
        }
        return events
      } catch {
        return []
      }
    },
  }
}

// Per-peer turn watcher. TWO concurrent loops, one guard, started together,
// stopped together:
//   • Pane loop (3s) — owns turn lifetime + the "typing…" indicator. Pane
//     changed-since-last-poll = still working; pane static = turn done. Runs
//     even when typing is disabled, because it is also the turn-end detector for
//     the activity collapse. Its cadence is NOT lowered (would over-send typing).
//   • Activity loop (ACTIVITY_POLL_MS, ~0.5s) — tails the transcript fast for a
//     realtime stream, but edits at most once per ACTIVITY_EDIT_INTERVAL_MS to
//     respect Telegram's ~1 edit/sec-per-chat flood limit, and backs off on 429.
// Fire-and-forget; all activity sends are best-effort and isolated from the
// send_to_peer outbound queue (a failed/throttled edit never blocks delivery).
async function watchPeerTurn(
  bot: Bot,
  chatId: string,
  target: PeerRecord,
  isOperator?: (personality: string) => boolean,
): Promise<void> {
  const typingOn = process.env.TELEGRAM_TYPING !== '0'
  const activityOn = activityEnabledForPeer(target)
  if (!typingOn && !activityOn) return
  if (activeWatchers.has(target.personality)) return
  activeWatchers.add(target.personality)

  const reader = activityOn ? createTranscriptReader(target, isOperator) : null
  if (activityOn && !reader) {
    logActivity('reader.none', { peer: target.personality, runtime: target.runtime, cwd: target.cwd })
  }
  // Splash verb shown at the top. Picked now so it appears the instant the turn
  // starts (before any tool_use — like the typing indicator), and re-picked on
  // every new tool call below for a livelier feel (v0.6).
  let splash = pickSplash()
  const events: ToolEvent[] = []
  let statusMessageId: number | null = null
  // When the CURRENT status message was created (creation → collapse = the
  // duration shown in the completion line, v0.8). Reset per segment so статус2
  // after a checkpoint times its own lifetime, not the whole turn.
  let statusStartedAt = 0
  let lastRendered = ''
  let lastEditAt = 0
  let throttledUntil = 0
  let done = false
  // Set by checkpointActivity (via the registered callback) when this peer sends
  // an outbound message; honoured at the top of the activity loop (v0.7).
  let checkpointRequested = false
  // A status message may be created splash-only (no tool yet) ONLY at turn start
  // — the instant "still working" frame (v0.6). After a checkpoint reset this is
  // off: the next status message is born from a real tool call, never a bare
  // splash, so a trailing answer leaves no empty "✓ 0 шагов" stub behind (v0.7).
  let allowSplashOnly = true
  if (reader) activityCheckpoints.set(target.personality, () => (checkpointRequested = true))

  const flush = async (active: boolean): Promise<void> => {
    if (!reader) return // events may be empty: the active frame is then splash-only
    // v0.7 gates: no orphan "✓ 0 шагов", and post-checkpoint статус2 waits for a
    // real tool call before it is opened (see skipStatusFlush).
    if (skipStatusFlush(active, statusMessageId !== null, events.length > 0, allowSplashOnly)) return
    // Completion line (active=false) shows this status's lifetime + the peer's
    // current context size in tokens; both unused (0 / null) while active.
    const durationMs = !active && statusStartedAt ? Date.now() - statusStartedAt : 0
    const contextTokens = active ? null : reader.contextTokens()
    const text = renderActivity(splash, events, active, durationMs, contextTokens)
    if (active && text === lastRendered) return // skip "message is not modified"
    const now = Date.now()
    if (active) {
      // Throttle: honour any 429 backoff window and the ~1/sec per-chat ceiling.
      if (now < throttledUntil || now - lastEditAt < ACTIVITY_EDIT_INTERVAL_MS) return
    } else if (now < throttledUntil) {
      // The collapse is the final frame — wait out the backoff so the chat never
      // ends on a stale active state, then send it.
      await sleep(throttledUntil - now)
    }
    try {
      if (statusMessageId === null) {
        const msg = await bot.api.sendMessage(
          chatId,
          text,
          undefined,
          AbortSignal.timeout(OUTBOUND_SEND_TIMEOUT_MS),
        )
        statusMessageId = msg.message_id
        statusStartedAt = Date.now() // anchor for this segment's duration (v0.8)
      } else {
        await bot.api.editMessageText(
          chatId,
          statusMessageId,
          text,
          undefined,
          AbortSignal.timeout(OUTBOUND_SEND_TIMEOUT_MS),
        )
      }
      lastRendered = text
      lastEditAt = Date.now()
      logActivity('edit', { peer: target.personality, steps: events.length, active })
    } catch (err) {
      // Ephemeral channel: a failed edit must never break delivery. On a 429,
      // respect retry_after so we stop hammering; otherwise log and move on (the
      // next poll re-renders the latest state).
      const c = classifyOutboundError(err)
      if (c.kind === 'api' && c.tgCode === 429) {
        throttledUntil = Date.now() + (c.retryAfter ?? 1) * 1000 + 250
        logActivity('throttled', { peer: target.personality, retryAfter: c.retryAfter })
      } else {
        logActivity('edit.error', { peer: target.personality, detail: c.detail })
      }
    }
  }

  // Collapse the CURRENT status to its completion line ("Pondered for 32s") IN
  // PLACE, then drop the message id and the running tally so the next tool call
  // opens a fresh status message below the answer the peer just sent (v0.7 — see
  // activityCheckpoints). No-op if no status exists yet (nothing is stuck above
  // the answer). One last poll first so any trailing WORK gesture lands in THIS
  // segment, not the next (send_to_peer itself is no longer a gesture — v0.8.1).
  const finalizeAndReset = async (): Promise<void> => {
    if (statusMessageId === null) return
    try {
      events.push(...reader!.poll())
    } catch {}
    await flush(false)
    statusMessageId = null
    statusStartedAt = 0 // статус2 re-anchors its duration on its own creation (v0.8)
    events.length = 0
    lastRendered = ''
    allowSplashOnly = false
    splash = pickSplash()
    logActivity('checkpoint', { peer: target.personality })
  }

  // Fast activity poller — decoupled from the typing cadence. Stops when the
  // pane loop marks the turn done.
  const activityLoop = reader
    ? (async () => {
        while (!done) {
          // Honour a pending outbound checkpoint BEFORE rendering new activity, so
          // post-answer tool calls never bleed into the now-finalized status.
          if (checkpointRequested) {
            checkpointRequested = false
            await finalizeAndReset()
          }
          const fresh = reader.poll()
          if (fresh.length) {
            events.push(...fresh)
            splash = pickSplash() // a fresh verb on each new tool call (v0.6)
          }
          await flush(true)
          await sleep(ACTIVITY_POLL_MS)
        }
      })()
    : null

  const started = Date.now()
  try {
    if (typingOn) await bot.api.sendChatAction(chatId, 'typing').catch(() => {})
    while (Date.now() - started < TYPING_CAP_MS) {
      await sleep(TYPING_POLL_MS)
      // Busy = the peer's pane-log advanced within PANELOG_BUSY_MS (it emits
      // output — spinner/tool — roughly every second while working). This poller
      // owns the turn-lifecycle `done` gate (set in finally), under which the
      // activity-loop tails the transcript for gestures — so keeping it alive for
      // the whole turn is what re-enables BOTH channels. The TYPING_MIN_MS grace
      // covers the startup window before the peer's first byte; a missing log
      // (age null) reads as idle, exactly as the old null pane did.
      const age = paneLogAgeMs(target)
      const busy = age !== null && age < PANELOG_BUSY_MS
      if (busy || Date.now() - started < TYPING_MIN_MS) {
        if (typingOn) await bot.api.sendChatAction(chatId, 'typing').catch(() => {})
      } else {
        break
      }
    }
  } finally {
    done = true
    if (activityLoop) await activityLoop // let the in-flight poll/edit settle
    activeWatchers.delete(target.personality)
    activityCheckpoints.delete(target.personality)
    if (reader) {
      // Capture any trailing tool calls (e.g. the final send_to_peer) then
      // collapse the status message to its single-line ✓ summary. If the turn
      // ended right after a checkpoint (no status open), flush(false) is a no-op.
      try {
        events.push(...reader.poll())
      } catch {}
      await flush(false)
    }
  }
}

// Operator control command for the activity channel, applied to the peer bound
// to the bot the operator messaged. `/activity` → status; `/activity on|off` →
// toggle (persisted in the target peer's interfaces.telegram.activity).
export function parseActivityCommand(text: string): 'on' | 'off' | 'status' | null {
  const m = /^\/activity(?:@\w+)?(?:\s+(on|off|status))?$/i.exec(text.trim())
  if (!m) return null
  const arg = (m[1] ?? 'status').toLowerCase()
  return arg as 'on' | 'off' | 'status'
}

// CONTROL detection: a single bare "stop" word addressed to the bound peer.
//
// Returns true ONLY for an exact one-word stop token — «стоп» / «stop» (any
// case) or the «/stop» slash-command — after trimming surrounding whitespace
// and a trailing run of !/./? punctuation. This is the operator's remote
// "shut up" for a peer that is spewing from Telegram; the caller maps it to
// `iapeer interrupt`.
//
// FLEET-SAFETY: the match is surgical. Anything multi-word ("стоп подожди",
// "стоп!! что ты делаешь", "стоп, не надо") returns false and flows through the
// UNCHANGED envelope/delivery path — this runtime carries the whole fleet's
// live channel, so a normal message misclassified as control would break it.
// When in doubt we err toward delivery (e.g. a trailing comma is NOT stripped,
// so "стоп," is treated as a normal message). `iu` flags fold Cyrillic case
// (СТОП↔стоп). Telegram may append @botname to slash-commands — tolerated for
// /stop, mirroring /activity.
export function isStopCommand(text: string): boolean {
  const normalized = text.trim().replace(/[\s!.?]+$/u, '')
  return /^(?:стоп|stop|\/stop(?:@\w+)?)$/iu.test(normalized)
}

// Lifecycle control commands (контракт двухуровневой модели, 12.06.2026): a
// BARE slash command — exactly `/new` or `/compact`, nothing else — is ALWAYS
// control, never a prompt. These are the emergency handles: an unconditional
// fresh-session / context-compact for a peer whose prompt channel is wedged
// (hung turn, dead session), where a prompt-path shortcut cannot reach it.
// The prompt-path shortcuts live under `/alias_*` (expansion.aliases) and are
// NOT affected. FLEET-SAFETY mirrors isStopCommand: only the pure command
// (optionally with Telegram's appended @botname) is control; any argument or
// trailing text fails the match and flows through normal delivery.
export function parseLifecycleCommand(text: string): 'new' | 'compact' | null {
  const t = text.trim()
  if (/^\/new(?:@\w+)?$/i.test(t)) return 'new'
  if (/^\/compact(?:@\w+)?$/i.test(t)) return 'compact'
  return null
}

// The agent runtimes a peer can be HARD-switched to from Telegram. `telegram` is a
// presence runtime (the human side), never a switch target. A bare `/<runtime>`
// (e.g. `/codex`) is a CONTROL command in the two-level model — a reserved bare-slash
// name, distinct from the `/alias_*` prompt namespace.
const RUNTIME_SWITCH_RUNTIMES = ['claude', 'codex'] as const

// Parse a hard runtime-switch control command: a BARE `/claude` / `/codex` (optionally
// with Telegram's appended @botname), nothing else. Returns the target runtime, or null
// when the text is not a known-runtime switch. Validation that the TARGET peer actually
// declares the runtime happens in the handler (clean per-peer feedback). Same
// fleet-safety as the lifecycle/stop parsers: any argument or trailing text fails.
export function parseRuntimeSwitchCommand(text: string): string | null {
  const m = /^\/([a-z]+)(?:@\w+)?$/.exec(text.trim().toLowerCase())
  if (!m) return null
  return (RUNTIME_SWITCH_RUNTIMES as readonly string[]).includes(m[1]) ? m[1] : null
}

async function handleActivityCommand(
  bot: Bot,
  chatId: string,
  target: PeerRecord,
  cmd: 'on' | 'off' | 'status',
): Promise<void> {
  if (cmd === 'status') {
    const on = activityEnabledForPeer(target)
    await bot.api
      .sendMessage(chatId, `ℹ️ activity-стрим для ${target.personality}: ${on ? 'вкл' : 'выкл'}`)
      .catch(() => {})
    return
  }
  const want = cmd === 'on'
  try {
    const profile = readPeerProfile(target.cwd)
    if (!profile) {
      throw new TelegramRuntimeError(`profile for ${target.personality} not found at ${target.cwd}`)
    }
    writePeerProfile(target.cwd, setTelegramInterface(profile, { activity: want }))
    logActivity('toggle', { peer: target.personality, on: want })
    await bot.api
      .sendMessage(
        chatId,
        `${want ? '🟢' : '⚪️'} activity-стрим для ${target.personality} ${want ? 'включён' : 'выключен'}`,
      )
      .catch(() => {})
  } catch (err) {
    await bot.api
      .sendMessage(chatId, `⚠️ activity для ${target.personality}: ${formatError(err)}`)
      .catch(() => {})
  }
}

// Resolve the `iapeer` control binary. This is a DIFFERENT binary from the IAP
// send bin (`ctx.iapBin`, default `iap`): `iapeer interrupt …` lives at
// ~/.local/bin/iapeer. Prefer an explicit env override, then the absolute
// install path (so we never depend on launchd's PATH), then bare `iapeer`.
function resolveIapeerBin(): string {
  const override = (process.env.TELEGRAM_RUNTIME_IAPEER_BIN ?? '').trim()
  if (override) return override
  const installed = join(homedir(), '.local', 'bin', 'iapeer')
  if (existsSync(installed)) return installed
  return 'iapeer'
}

// Spawn `iapeer interrupt <personality> <runtime>` for the peer bound to this
// bot and feed the result back to the operator. The contract (fixed by iapeer):
//   exit 0 → interrupted (stdout «interrupt → <p> (<rt>)»); context intact.
//   exit 1 → peer not in a live session (stderr «… peer offline: <p> (<rt>)»).
// Runtime is passed EXPLICITLY (we know the chat→peer→runtime binding via the
// peer record), avoiding the CLI's "specify runtime" error when 2+ runtimes are
// live. Idempotent and safe to repeat. Any spawn/parse failure is surfaced to
// the operator and swallowed — a control command must never throw into the
// delivery path.
export async function handleStopCommand(bot: Bot, chatId: string, target: PeerRecord): Promise<void> {
  const bin = resolveIapeerBin()
  const result = spawnSync(bin, ['interrupt', target.personality, target.runtime], {
    encoding: 'utf8',
  })
  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  logActivity('stop', {
    peer: target.personality,
    runtime: target.runtime,
    status: result.status,
    error: result.error?.message,
  })
  // Mechanics speak plain dry English, no emoji, no peer-name prefix (a UX
  // decision) — same voice as the lifecycle verdicts above: the verdict
  // lands in the peer's own chat, the name would duplicate the chat itself.
  let feedback: string
  if (result.error) {
    feedback = `interrupt failed: ${result.error.message}`
  } else if (result.status === 0) {
    feedback = 'interrupted'
  } else if (/offline/i.test(stderr) || /offline/i.test(stdout)) {
    feedback = 'not in an active session'
  } else {
    feedback = `interrupt failed: ${stderr || stdout || `exit ${result.status}`}`
  }
  await bot.api.sendMessage(chatId, feedback).catch(() => {})
}

// Run a control binary WITHOUT blocking the event loop. `iapeer new` is a real
// TUI boot — typically 5–30s, bootDeadline ceiling 240s (iapeer 0.2.43 contract)
// — and a spawnSync of that length would freeze EVERY bot's polling and the
// whole outbound queue (this runtime carries the fleet). Timeout kills the
// child and resolves; never rejects.
export function runControlBinary(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error; timedOut?: boolean }> {
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: { status: number | null; error?: Error; timedOut?: boolean }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, ...r })
    }
    let child: ReturnType<typeof spawn>
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL')
      } catch {}
      finish({ status: null, timedOut: true })
    }, timeoutMs)
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      finish({ status: null, error: err as Error })
      return
    }
    child.stdout?.on('data', d => (stdout += String(d)))
    child.stderr?.on('data', d => (stderr += String(d)))
    child.on('error', err => finish({ status: null, error: err }))
    child.on('close', code => finish({ status: code }))
  })
}

// Generous external backstops over iapeer's own internal ceilings, so iapeer
// returns its truthful verdict before this channel timeout would SIGKILL the
// process — both default to 300s:
//   - new: a cold-resume/ready gate (bootDeadline 240s) can elapse before the
//     control keystroke even lands.
//   - compact: `iapeer compact` now BLOCKS on its waitForCompactDone gate until
//     the runtime writes a structured completion marker (Claude `compact_boundary`
//     / Codex `context_compacted`) — it no longer returns the instant `/compact`
//     was sent. That gate's own timeout (290s) sits deliberately INSIDE our 300s,
//     so a hung compact surfaces as iapeer's honest failure text, not our timeout.
const LIFECYCLE_TIMEOUT_MS: Record<'new' | 'compact', number> = {
  new: Number(process.env.TELEGRAM_NEW_TIMEOUT_MS ?? '') || 300_000,
  compact: Number(process.env.TELEGRAM_COMPACT_TIMEOUT_MS ?? '') || 300_000,
}

// Spawn `iapeer <new|compact> <personality> <runtime>` for the peer bound to
// this bot and feed the result back to the operator — the same shape as
// handleStopCommand (`iapeer interrupt`). Contract fixed with iapeer (topic
// control-commands, 12.06, his half live in 0.2.43):
//   new:     exit 0 ⟺ a fresh session is UP and READY (ready-gate verified) —
//            for a sleeping, dead AND hung peer alike; an explicit operator
//            /new also clears a C1 stop-parking (operator wins). stdout:
//            «new: <rt>-<p> fresh session up».
//   compact: exit 0 → the command landed in the dialogue; stdout may be
//            «compact → <peer> (<runtime>) after resume» when a clean-asleep
//            peer was resumed first. exit != 0 + stable token
//            «nothing-to-compact» → normal no-op (fresh context / no resumable
//            transcript), not a failure. Legacy/race «peer offline» still maps
//            to "not in an active session". Codex /compact exists since codex
//            0.138 and is mapped in iapeer's adapter from 0.2.43.
// Runtime is passed EXPLICITLY from the chat→peer→runtime binding. Repeats are
// idempotent-safe (wake-lock serialized on iapeer's side). Any failure is
// surfaced and swallowed — control must never throw into delivery.
export async function handleLifecycleCommand(
  bot: Bot,
  chatId: string,
  target: PeerRecord,
  op: 'new' | 'compact',
): Promise<void> {
  const bin = resolveIapeerBin()
  if (op === 'new') {
    // A real boot takes 5–30s — acknowledge immediately so the operator knows
    // the handle was grabbed; the verdict follows when the session is READY.
    // Mechanics speak plain dry English, no emoji, and NO peer-name prefix
    // (a UX decision): the verdict lands in the peer's own chat from
    // the peer's own bot — the name would duplicate what the chat already says.
    await bot.api.sendMessage(chatId, 'restarting session...').catch(() => {})
  }
  const result = await runControlBinary(
    bin,
    [op, target.personality, target.runtime],
    LIFECYCLE_TIMEOUT_MS[op],
  )
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  logActivity(op, {
    peer: target.personality,
    runtime: target.runtime,
    status: result.status,
    timedOut: result.timedOut,
    error: result.error?.message,
  })
  let feedback: string
  if (result.error) {
    feedback = `${op} failed: ${result.error.message}`
  } else if (result.timedOut) {
    feedback = `${op} timed out after ${Math.round(LIFECYCLE_TIMEOUT_MS[op] / 1000)}s — check the session`
  } else if (result.status === 0) {
    feedback = op === 'new' ? 'fresh session up' : 'context compacted'
  } else if (op === 'compact' && /nothing-to-compact/i.test(`${stderr}\n${stdout}`)) {
    feedback = 'nothing to compact — context is fresh'
  } else if (/offline/i.test(stderr) || /offline/i.test(stdout)) {
    feedback = 'not in an active session'
  } else {
    feedback = `${op} failed: ${stderr || stdout || `exit ${result.status}`}`
  }
  await bot.api.sendMessage(chatId, feedback).catch(() => {})
}

// Hard runtime switch (control): `iapeer new <peer> <toRuntime>` — mechanically restart
// the peer ON the target runtime. Same shape as handleLifecycleCommand('new') but with
// an EXPLICIT target runtime instead of the peer's current one (iapeer's `new` honours
// the passed runtime: `rt = runtime ?? peer.runtime`, refusing undeclared/foreign). We
// pre-check the peer DECLARES the runtime so the operator gets clean per-peer feedback
// rather than iapeer's refusal text. Any failure is surfaced and swallowed — control
// must never throw into the delivery path.
export async function handleRuntimeSwitchCommand(
  bot: Bot,
  chatId: string,
  target: PeerRecord,
  toRuntime: string,
): Promise<void> {
  if (target.runtime === toRuntime) {
    await bot.api.sendMessage(chatId, `already on ${toRuntime}`).catch(() => {})
    return
  }
  const declared = target.runtimes?.length ? target.runtimes : [target.runtime]
  if (!declared.includes(toRuntime)) {
    await bot.api
      .sendMessage(chatId, `${target.personality} does not declare runtime ${toRuntime} (has: ${declared.join(', ')})`)
      .catch(() => {})
    return
  }
  const bin = resolveIapeerBin()
  await bot.api.sendMessage(chatId, `switching to ${toRuntime}...`).catch(() => {})
  const result = await runControlBinary(bin, ['new', target.personality, toRuntime], LIFECYCLE_TIMEOUT_MS.new)
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  logActivity('runtime-switch', {
    peer: target.personality,
    from: target.runtime,
    to: toRuntime,
    status: result.status,
    timedOut: result.timedOut,
    error: result.error?.message,
  })
  let feedback: string
  if (result.error) {
    feedback = `switch failed: ${result.error.message}`
  } else if (result.timedOut) {
    feedback = `switch to ${toRuntime} timed out after ${Math.round(LIFECYCLE_TIMEOUT_MS.new / 1000)}s — check the session`
  } else if (result.status === 0) {
    feedback = `switched to ${toRuntime} — fresh session up`
  } else if (/offline/i.test(stderr) || /offline/i.test(stdout)) {
    feedback = 'not in an active session'
  } else {
    feedback = `switch to ${toRuntime} failed: ${stderr || stdout || `exit ${result.status}`}`
  }
  await bot.api.sendMessage(chatId, feedback).catch(() => {})
}

// Transcribe an inbound voice file to text. Tiered, all knobs via env:
//   1. TELEGRAM_STT_ENDPOINT — OpenAI-compatible POST /v1/audio/transcriptions
//      (e.g. speaches / faster-whisper-server). Direct fetch, NOT runtimeFetch:
//      the STT box is a LAN/operator service, not external Telegram traffic
//      behind the killswitch proxy.
//   2. TELEGRAM_STT_FALLBACK_CMD (default `mlx_whisper`, empty to disable) —
//      local CLI fallback; writes <name>.txt to a temp --output-dir.
//   3. null — caller delivers the raw audio as an attachment (degrade safely).
// TELEGRAM_STT_PROMPT (optional) primes the decoder for both tiers — see below.
async function transcribeVoice(filePath: string): Promise<string | null> {
  const lang = (process.env.TELEGRAM_STT_LANGUAGE ?? '').trim()
  // Optional decoder-priming prompt. Not transcribed into the output; it biases
  // punctuation, casing and term spelling (e.g. "Claude Code"/"Gemini" stay in
  // Latin instead of being phonetically mangled). OpenAI-compatible `prompt`
  // field for /v1/audio/transcriptions; `--initial-prompt` for mlx_whisper.
  const prompt = (process.env.TELEGRAM_STT_PROMPT ?? '').trim()
  const timeoutMs = Number(process.env.TELEGRAM_STT_TIMEOUT_MS ?? '') || 30000

  const endpoint = (process.env.TELEGRAM_STT_ENDPOINT ?? '').trim()
  if (endpoint) {
    try {
      const form = new FormData()
      form.append('file', new File([readFileSync(filePath)], basename(filePath)))
      const model = (process.env.TELEGRAM_STT_MODEL ?? '').trim()
      if (model) form.append('model', model)
      if (lang) form.append('language', lang)
      if (prompt) form.append('prompt', prompt)
      form.append('response_format', 'text')
      const res = await fetch(endpoint, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.ok) {
        const text = (await res.text()).trim()
        if (text) return text
        process.stderr.write('telegram-runtime: STT endpoint returned empty text\n')
      } else {
        process.stderr.write(`telegram-runtime: STT endpoint HTTP ${res.status}\n`)
      }
    } catch (err) {
      process.stderr.write(`telegram-runtime: STT endpoint failed: ${formatError(err)}\n`)
    }
  }

  const cmd =
    process.env.TELEGRAM_STT_FALLBACK_CMD === undefined
      ? 'mlx_whisper'
      : process.env.TELEGRAM_STT_FALLBACK_CMD.trim()
  if (cmd) {
    const outDir = join(tmpdir(), `tg-stt-${randomUUID()}`)
    try {
      mkdirSync(outDir, { recursive: true })
      const cmdArgs = [filePath, '--output-format', 'txt', '--output-dir', outDir]
      const fbModel = (process.env.TELEGRAM_STT_FALLBACK_MODEL ?? '').trim()
      if (fbModel) cmdArgs.push('--model', fbModel)
      if (lang) cmdArgs.push('--language', lang)
      if (prompt) cmdArgs.push('--initial-prompt', prompt)
      const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', timeout: timeoutMs * 4 })
      if (r.status === 0) {
        const txtPath = join(outDir, basename(filePath).replace(/\.[^.]+$/, '') + '.txt')
        if (existsSync(txtPath)) {
          const text = readFileSync(txtPath, 'utf8').trim()
          if (text) return text
        }
      } else {
        process.stderr.write(
          `telegram-runtime: STT fallback "${cmd}" exit ${r.status ?? 'signal'}\n`,
        )
      }
    } catch (err) {
      process.stderr.write(`telegram-runtime: STT fallback error: ${formatError(err)}\n`)
    } finally {
      try {
        rmSync(outDir, { recursive: true, force: true })
      } catch {}
    }
  }

  return null
}

async function handleInboundMessage(args: {
  ctx: RuntimeContext
  botKey: string
  bot: Bot
  credential: BotCredential
  telegramCtx: any
  text: string
  attachment?: {
    kind: string
    fileId: string
    uniqueId?: string
  }
}): Promise<void> {
  const fromId = String(args.telegramCtx.from?.id ?? '')
  if (fromId !== args.ctx.ownerUserId) return

  const directory = readPeerDirectory()
  const target = directory.byTelegramBot.get(args.botKey)
  if (!target) {
    await args.bot.api.sendMessage(
      args.ctx.ownerUserId,
      `telegram-runtime: bot "${args.botKey}" is not mapped to a peer`,
    ).catch(() => {})
    return
  }

  // Activity-channel control command, scoped to the peer bound to this bot.
  // Intercepted before alias expansion and IAP delivery so the peer-LLM never
  // sees `/activity`. The fromId === ownerUserId guard above already restricts
  // this to the human operator.
  if (!args.attachment) {
    const activityCmd = parseActivityCommand(args.text)
    if (activityCmd) {
      await handleActivityCommand(args.bot, args.ctx.ownerUserId, target, activityCmd)
      return
    }
    // Single-word "стоп"/"stop"/"/stop" → CONTROL, not a message. Intercepted
    // here (before alias expansion and IAP delivery) so it interrupts the peer's
    // live turn instead of being delivered as text. Multi-word stop phrases fail
    // isStopCommand and fall through to the normal delivery path below.
    if (isStopCommand(args.text)) {
      await handleStopCommand(args.bot, args.ctx.ownerUserId, target)
      return
    }
    // Bare `/new` / `/compact` → lifecycle CONTROL (emergency handle for a
    // wedged peer), intercepted before alias expansion and IAP delivery by the
    // two-level contract: a pure slash command is never a prompt. The
    // `/alias_*` prompt shortcuts are untouched (they expand below).
    const lifecycleCmd = parseLifecycleCommand(args.text)
    if (lifecycleCmd) {
      await handleLifecycleCommand(args.bot, args.ctx.ownerUserId, target, lifecycleCmd)
      return
    }
    // Bare `/claude` / `/codex` → HARD runtime switch CONTROL (mechanical restart of the
    // peer on the target runtime via `iapeer new <peer> <rt>`), intercepted before alias
    // expansion by the two-level contract. The soft, cooperative switch is an owner
    // `/alias_*` whose prompt does handoff → `iapeer default-runtime` → `iapeer self-fresh`.
    const switchRuntime = parseRuntimeSwitchCommand(args.text)
    if (switchRuntime) {
      await handleRuntimeSwitchCommand(args.bot, args.ctx.ownerUserId, target, switchRuntime)
      return
    }
  }

  const attachments: string[] = []
  let voiceTranscript: string | null = null
  if (args.attachment) {
    const filePath = await downloadTelegramFile({
      bot: args.bot,
      token: args.credential.token,
      botKey: args.botKey,
      fileId: args.attachment.fileId,
      uniqueId: args.attachment.uniqueId,
      kind: args.attachment.kind,
    })
    if (args.attachment.kind === 'voice') {
      // Deliver voice as a transcript, not an audio attachment. On STT failure
      // fall back to forwarding the file so the voice is never lost silently.
      // TELEGRAM_STT_KEEP_FILE=1 attaches the audio alongside the transcript.
      voiceTranscript = await transcribeVoice(filePath)
      if (voiceTranscript === null || process.env.TELEGRAM_STT_KEEP_FILE === '1') {
        attachments.push(filePath)
      }
    } else {
      attachments.push(filePath)
    }
  }

  // Operator slash-command expansion per §3.5 IAPeer DECISIONS.
  //
  // The source filter `fromId === ctx.ownerUserId` above already guarantees the
  // message is from a human operator (Telegram-side identity), so the human-only
  // condition of §3.5 is satisfied implicitly. Look up the target peer's profile
  // and substitute the text if it matches an alias key.
  //
  // Reads the profile fresh on every inbound message so operator edits to
  // the alias map take effect without restarting telegram-runtime. Canonical
  // location is the top-level expansion.aliases section with a transition
  // fallback to interfaces.telegram.aliases — see resolveAliases().
  const baseText = voiceTranscript !== null ? `🎤 [voice] ${voiceTranscript}` : args.text
  let deliveredText = baseText
  try {
    const targetProfile = readPeerProfile(target.cwd)
    deliveredText = expandAlias(baseText, resolveAliases(targetProfile))
  } catch (err) {
    // A malformed target profile must not block delivery — log and pass text as-is.
    process.stderr.write(
      `telegram-runtime: cannot read aliases for ${target.personality}: ${formatError(err)}\n`,
    )
  }

  // Piggyback a slash-menu re-sync on owner interaction: the profile was just read, so
  // an alias/runtime edit reflects in the menu immediately (not only on the periodic
  // tick). Best-effort and a no-op when the menu is unchanged.
  void syncBotCommands(args.ctx, args.botKey, args.bot)

  enqueueIapSend(async () => {
    const result = await runIapSend(args.ctx, target.personality, deliveredText, attachments)
    if (!result.ok) {
      const verdict = iapDeliveryFailureVerdict(result)
      process.stderr.write(`telegram-runtime: inbound delivery failed: ${result.detail}\n`)
      await args.bot.api.sendMessage(args.ctx.ownerUserId, verdict).catch(err => {
        process.stderr.write(
          `telegram-runtime: inbound delivery verdict failed: ${formatError(err)}\n`,
        )
      })
    }
  })

  // Surface the peer's work while it processes this turn. Fire-and-forget: one
  // watcher polls the peer's pane and refreshes the "typing…" indicator until
  // the pane goes static (turn done) or the cap is hit, AND — if the activity
  // channel is enabled for this peer — tails its transcript into a single
  // editable status message (a second channel).
  // isOperator identifies the human operator(s) so send_to_peer to THEM is hidden
  // from the stream (already the delivered message; the 0.8.1 race) while
  // agent→agent sends stay visible (v0.8.2). Built from the directory read above.
  const operatorTargets = new Set(
    // Operators are HUMAN peers. Post foundation-vocab-flip they carry `natural`;
    // legacy `human` is kept for back-compat (a not-yet-flipped / read-compat registry).
    // String() keeps this robust to the runtime's legacy `Intelligence` union type.
    directory.peers
      .filter(p => {
        const intel = String(p.intelligence)
        return intel === 'natural' || intel === 'human'
      })
      .map(p => p.personality),
  )
  const isOperator = (personality: string): boolean => operatorTargets.has(personality)
  void watchPeerTurn(args.bot, args.ctx.ownerUserId, target, isOperator)
}

// ─── Slash-menu auto-registration (setMyCommands) ────────────────────────────
// Each bot's Telegram slash menu is auto-built from the commands that ALREADY work in
// the channel — control + hard runtime-switch + the peer's `/alias_*` prompt shortcuts —
// so the owner gets a discoverable, autocompleted menu instead of having to know them by
// heart. Scoped to the owner's private chat (BotCommandScopeChat) so non-owners never
// see control. It surfaces the existing two-level model; it adds no new semantics.

// Telegram allows ONLY [a-z0-9_], 1–32 chars, in a REGISTERED command name (hyphen is
// rejected — core.telegram.org/bots/features). Aliases live under `/alias_*`; any key
// that still violates the grammar is skipped (logged) so one bad alias cannot make
// setMyCommands reject the whole batch.
function isValidCommandName(name: string): boolean {
  return /^[a-z0-9_]{1,32}$/.test(name)
}

// A Telegram command description is 1–256 chars. Collapse the alias prompt to one line
// and truncate — a readable hint of what the alias does.
function commandDescription(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  const d = oneLine.length > 0 ? oneLine : 'prompt alias'
  return d.length > 256 ? `${d.slice(0, 253)}...` : d
}

// Build a bot's slash menu for the peer bound to it: control commands + hard
// runtime-switch (one per DECLARED agent runtime, only when ≥2 so there is a real
// choice) + the peer's prompt aliases (canonical expansion.aliases via resolveAliases).
// Invalid command names are filtered.
export function buildBotCommands(
  target: PeerRecord,
  profile: PeerProfile | null,
): { command: string; description: string }[] {
  const cmds: { command: string; description: string }[] = [
    { command: 'new', description: 'restart the session (fresh, unconditional)' },
    { command: 'compact', description: 'compact the session context' },
    { command: 'stop', description: 'interrupt the current turn' },
    { command: 'activity', description: 'toggle the activity stream (on/off/status)' },
  ]
  const declaredAgentRuntimes = (target.runtimes?.length ? target.runtimes : [target.runtime]).filter(rt =>
    (RUNTIME_SWITCH_RUNTIMES as readonly string[]).includes(rt),
  )
  if (declaredAgentRuntimes.length >= 2) {
    for (const rt of declaredAgentRuntimes) {
      cmds.push({ command: rt, description: `switch this peer to ${rt} (restart)` })
    }
  }
  const aliases = resolveAliases(profile)
  if (aliases) {
    for (const [key, prompt] of Object.entries(aliases)) {
      const name = key.startsWith('/') ? key.slice(1) : key
      if (!isValidCommandName(name)) {
        process.stderr.write(
          `telegram-runtime: skipping alias "${key}" — not a valid Telegram command name [a-z0-9_]{1,32}\n`,
        )
        continue
      }
      cmds.push({ command: name, description: commandDescription(prompt) })
    }
  }
  return cmds
}

// Last-registered command signature per bot, so a sync calls setMyCommands ONLY when the
// menu changed. Start, periodic re-sync, and inbound piggyback all funnel through here.
const registeredCommands = new Map<string, string>()

// Register (or refresh) a bot's owner-scoped slash menu. Best-effort: a missing target,
// unreadable profile, or Telegram API error is logged and swallowed — the menu is a
// convenience and must NEVER break polling or delivery.
async function syncBotCommands(ctx: RuntimeContext, botKey: string, bot: Bot): Promise<void> {
  try {
    const target = readPeerDirectory().byTelegramBot.get(botKey)
    if (!target) return
    let profile: PeerProfile | null = null
    try {
      profile = readPeerProfile(target.cwd)
    } catch {
      // malformed profile → still register control + runtime-switch (aliases skipped)
    }
    const commands = buildBotCommands(target, profile)
    const signature = JSON.stringify(commands)
    if (registeredCommands.get(botKey) === signature) return
    await bot.api.setMyCommands(commands, { scope: { type: 'chat', chat_id: Number(ctx.ownerUserId) } })
    registeredCommands.set(botKey, signature)
    logActivity('commands-sync', { bot: botKey, peer: target.personality, count: commands.length })
  } catch (err) {
    process.stderr.write(`telegram-runtime: setMyCommands failed for ${botKey}: ${formatError(err)}\n`)
  }
}

function installBotHandlers(ctx: RuntimeContext, botKey: string, bot: Bot, credential: BotCredential): void {
  bot.on('message:text', async telegramCtx => {
    await handleInboundMessage({
      ctx,
      botKey,
      bot,
      credential,
      telegramCtx,
      text: telegramCtx.message.text,
    })
  })
  bot.on('message:photo', async telegramCtx => {
    const photos = telegramCtx.message.photo
    const best = photos[photos.length - 1]
    await handleInboundMessage({
      ctx,
      botKey,
      bot,
      credential,
      telegramCtx,
      text: telegramCtx.message.caption ?? '(photo)',
      attachment: { kind: 'photo', fileId: best.file_id, uniqueId: best.file_unique_id },
    })
  })
  bot.on('message:document', async telegramCtx => {
    const doc = telegramCtx.message.document
    await handleInboundMessage({
      ctx,
      botKey,
      bot,
      credential,
      telegramCtx,
      text: telegramCtx.message.caption ?? `(document: ${doc.file_name ?? 'file'})`,
      attachment: { kind: 'document', fileId: doc.file_id, uniqueId: doc.file_unique_id },
    })
  })
  bot.on('message:voice', async telegramCtx => {
    const voice = telegramCtx.message.voice
    await handleInboundMessage({
      ctx,
      botKey,
      bot,
      credential,
      telegramCtx,
      text: telegramCtx.message.caption ?? '(voice message)',
      attachment: { kind: 'voice', fileId: voice.file_id, uniqueId: voice.file_unique_id },
    })
  })
  bot.on('message:audio', async telegramCtx => {
    const audio = telegramCtx.message.audio
    await handleInboundMessage({
      ctx,
      botKey,
      bot,
      credential,
      telegramCtx,
      text: telegramCtx.message.caption ?? `(audio: ${audio.title ?? audio.file_name ?? 'audio'})`,
      attachment: { kind: 'audio', fileId: audio.file_id, uniqueId: audio.file_unique_id },
    })
  })
  bot.on('message:video', async telegramCtx => {
    const video = telegramCtx.message.video
    await handleInboundMessage({
      ctx,
      botKey,
      bot,
      credential,
      telegramCtx,
      text: telegramCtx.message.caption ?? '(video)',
      attachment: { kind: 'video', fileId: video.file_id, uniqueId: video.file_unique_id },
    })
  })
  bot.on('message:sticker', async telegramCtx => {
    const sticker = telegramCtx.message.sticker
    await handleInboundMessage({
      ctx,
      botKey,
      bot,
      credential,
      telegramCtx,
      text: `(sticker${sticker.emoji ? ` ${sticker.emoji}` : ''})`,
      attachment: { kind: 'sticker', fileId: sticker.file_id, uniqueId: sticker.file_unique_id },
    })
  })
  bot.catch(err => {
    process.stderr.write(`telegram-runtime: bot ${botKey} handler error: ${err.error}\n`)
  })
}

async function startPolling(botKey: string, bot: Bot): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => {
          attempt = 0
          process.stderr.write(`telegram-runtime: polling ${botKey} as @${info.username}\n`)
        },
      })
      return
    } catch (err) {
      const delay = Math.min(1000 * attempt, 15000)
      process.stderr.write(
        `telegram-runtime: polling ${botKey} failed: ${formatError(err)}, retrying in ${delay / 1000}s\n`,
      )
      await new Promise(resolveDelay => setTimeout(resolveDelay, delay))
    }
  }
}

// A line that BELONGS to a plain text paragraph — i.e. not a structural GFM
// marker. Only plain↔plain boundaries get a spacer: headings, tables, lists,
// quotes, fences, dividers, footnote definitions and HTML-tag lines render
// with their own spacing, and a spacer next to them would add ugly empty
// blocks (worse than the defect, per the owner's acceptance bar).
function isPlainParagraphLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  return !/^(#{1,6}\s|\||>|```|~~~|(-\s*){3,}$|(\*\s*){3,}$|(_\s*){3,}$|[-*+]\s|\d+[.)]\s|\[\^|<)/.test(t)
}

// Insert a spacer paragraph between adjacent PLAIN paragraphs so Telegram
// clients show vertical air (see RICH_SPACER_ENABLED). Fence-aware: blank
// lines INSIDE ``` / ~~~ code fences are code, not paragraph breaks — they
// pass through verbatim. Exported for tests.
export function spaceRichParagraphs(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    out.push(line)
    i++
    if (inFence) continue
    // At a blank run outside a fence: peek the next non-blank line; spacer only
    // when BOTH neighbours are plain paragraph text.
    if (line.trim() !== '') continue
    let j = i
    while (j < lines.length && lines[j].trim() === '') j++
    if (j >= lines.length) continue
    const prev = out.length >= 2 ? out[out.length - 2] : ''
    if (isPlainParagraphLine(prev) && isPlainParagraphLine(lines[j])) {
      out.push(RICH_SPACER_LINE, '')
    }
    while (i < j) {
      out.push(lines[i])
      i++
    }
  }
  return out.join('\n')
}

// Try to deliver the WHOLE envelope text as one Bot API 10.1 rich message
// (`rich_message.markdown` — Telegram parses the agent's GFM server-side).
// Returns true when delivered; false hands the envelope to the legacy chunked
// path. Deterministic API rejections (4xx except 429: unknown method, markdown
// the parser refuses, over-limit) fall back immediately — a retry cannot cure
// them and the legacy path still delivers the text. Transport failures
// (timeout / network / 429 / 5xx) get the same bounded retry loop as chunks;
// when they exhaust we STILL return false rather than throw: the legacy path
// gets its own retry budget before the envelope is declared undeliverable.
// Same timeout discipline as chunks: AbortSignal.timeout scoped to this send.
export async function sendRichResilient(bot: Bot, chatId: string, text: string): Promise<boolean> {
  // grammy 1.43.0 has no sendRichMessage typing; raw is a Proxy keyed on the
  // method name (verified in grammy's client.js), so the call reaches HTTP.
  const rawApi = bot.api.raw as unknown as Record<
    string,
    (payload: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
  >
  for (let attempt = 0; attempt <= OUTBOUND_SEND_RETRIES; attempt++) {
    const startedAt = Date.now()
    logOutbound('rich.start', {
      chatId,
      len: text.length,
      attempt,
      retries: OUTBOUND_SEND_RETRIES,
      timeoutMs: OUTBOUND_SEND_TIMEOUT_MS,
      queueDepth: outboundQueueDepth,
    })
    try {
      await rawApi.sendRichMessage(
        { chat_id: chatId, rich_message: { markdown: text } },
        AbortSignal.timeout(OUTBOUND_SEND_TIMEOUT_MS),
      )
      logOutbound('rich.ok', { chatId, attempt, ms: Date.now() - startedAt })
      return true
    } catch (err) {
      const c = classifyOutboundError(err)
      // The API understood the request and said no — bad markdown, over-limit,
      // or a Bot API server that predates 10.1 (404 "method not found").
      const deterministic =
        c.kind === 'api' &&
        c.tgCode !== undefined &&
        c.tgCode >= 400 &&
        c.tgCode < 500 &&
        c.tgCode !== 429
      logOutbound(
        deterministic ? 'rich.fallback' : c.kind === 'timeout' ? 'rich.timeout' : 'rich.error',
        {
          chatId,
          attempt,
          ms: Date.now() - startedAt,
          kind: c.kind,
          tgCode: c.tgCode,
          retryAfter: c.retryAfter,
          detail: c.detail,
        },
      )
      if (deterministic) return false
      if (attempt < OUTBOUND_SEND_RETRIES) {
        const backoff = Math.min(1000 * 2 ** attempt, 5000)
        await new Promise(resolveDelay => setTimeout(resolveDelay, backoff))
      }
    }
  }
  logOutbound('rich.giveup', { chatId, len: text.length })
  return false
}

// Send one chunk with a hard timeout and bounded retries. The 4th arg to
// grammy's API methods is an AbortSignal — AbortSignal.timeout aborts the
// underlying fetch, so a stuck call rejects (and the outbound queue keeps
// moving) instead of hanging the whole channel. Polling (getUpdates) is
// untouched: this timeout is scoped to outbound sends only.
async function sendChunkResilient(
  bot: Bot,
  chatId: string,
  text: string,
  meta: { chunk: number; of: number } = { chunk: 1, of: 1 },
): Promise<void> {
  // Convert agent GFM → valid Telegram MarkdownV2 once; reused across retries.
  // The converter should never throw, but if it ever does on some pathological
  // body, the message must NOT be lost: formatted=null routes the chunk straight
  // to a plain send for every attempt.
  let formatted: string | null
  try {
    formatted = toTelegramMarkdownV2(text)
  } catch (convErr) {
    formatted = null
    logOutbound('chunk.markdown_convert_error', {
      chatId,
      chunk: meta.chunk,
      of: meta.of,
      detail: formatError(convErr),
    })
  }
  let lastErr: unknown
  for (let attempt = 0; attempt <= OUTBOUND_SEND_RETRIES; attempt++) {
    const startedAt = Date.now()
    logOutbound('chunk.start', {
      chatId,
      chunk: meta.chunk,
      of: meta.of,
      len: text.length,
      attempt,
      retries: OUTBOUND_SEND_RETRIES,
      timeoutMs: OUTBOUND_SEND_TIMEOUT_MS,
      queueDepth: outboundQueueDepth,
    })
    try {
      try {
        if (formatted === null) {
          // Conversion failed above — send the original text plain.
          await bot.api.sendMessage(chatId, text, undefined, AbortSignal.timeout(OUTBOUND_SEND_TIMEOUT_MS))
        } else {
          await bot.api.sendMessage(
            chatId,
            formatted,
            { parse_mode: 'MarkdownV2' },
            AbortSignal.timeout(OUTBOUND_SEND_TIMEOUT_MS),
          )
        }
      } catch (err) {
        // MarkdownV2 is strict: a special the converter missed makes the Bot API
        // reject the whole message (400 "can't parse entities"), and escaping can
        // push a chunk past the 4096 cap ("...is too long"). Rather than lose it,
        // resend the ORIGINAL text as plain — formatting is dropped but the
        // message arrives. Only those formatting-class 400s fall back here; a
        // plain send that itself failed (formatted===null) and timeout/network/
        // 429 bubble to the retry loop below unchanged.
        if (formatted === null || !isFormattingError(err)) throw err
        logOutbound('chunk.markdown_fallback', {
          chatId,
          chunk: meta.chunk,
          of: meta.of,
          attempt,
          detail: (err as GrammyError).description,
        })
        await bot.api.sendMessage(chatId, text, undefined, AbortSignal.timeout(OUTBOUND_SEND_TIMEOUT_MS))
      }
      logOutbound('chunk.ok', {
        chatId,
        chunk: meta.chunk,
        of: meta.of,
        attempt,
        ms: Date.now() - startedAt,
      })
      return
    } catch (err) {
      lastErr = err
      const c = classifyOutboundError(err)
      logOutbound(c.kind === 'timeout' ? 'chunk.timeout' : 'chunk.error', {
        chatId,
        chunk: meta.chunk,
        of: meta.of,
        attempt,
        ms: Date.now() - startedAt,
        kind: c.kind,
        tgCode: c.tgCode,
        retryAfter: c.retryAfter,
        detail: c.detail,
      })
      if (attempt < OUTBOUND_SEND_RETRIES) {
        const backoff = Math.min(1000 * 2 ** attempt, 5000)
        await new Promise(resolveDelay => setTimeout(resolveDelay, backoff))
      }
    }
  }
  logOutbound('chunk.giveup', {
    chatId,
    chunk: meta.chunk,
    of: meta.of,
    detail: formatError(lastErr),
  })
  throw lastErr
}

async function sendOutboundToTelegram(ctx: RuntimeContext, envelope: IapEnvelope): Promise<void> {
  const directory = readPeerDirectory()
  const source = directory.byPersonality.get(envelope.fromPersonality)
  const botKey = source ? telegramInterface(source).bot : undefined
  if (!botKey) {
    throw new TelegramRuntimeError(
      `source peer "${envelope.fromPersonality}" has no interfaces.telegram.bot`,
    )
  }
  const bot = ctx.bots.get(botKey)
  const credential = ctx.credentials.get(botKey)
  if (!bot || !credential) {
    throw new TelegramRuntimeError(`bot "${botKey}" is not loaded`)
  }
  // Rich-first: one structured message via Bot API 10.1 when enabled and the
  // text fits the rich limit; ANY rich failure falls through to the legacy
  // chunked MarkdownV2→plain path, so an envelope is never lost to the rollout.
  // Spacer applied on the rich path only (the legacy chunked path renders via
  // MarkdownV2 where \n\n already shows air); gate on the SPACED length so the
  // text that actually goes out is what was measured.
  const richText = RICH_SPACER_ENABLED ? spaceRichParagraphs(envelope.message) : envelope.message
  const tryRich = RICH_OUTBOUND_ENABLED && richText.length <= MAX_RICH_TEXT
  // Newline fingerprint (counts only — zero content leak): GFM renders a blank
  // line (\n\n) as a paragraph break but space-joins a single \n (soft break),
  // so "paragraphs merged into one flowing block" downstream is distinguishable
  // by whether \n\n even REACHED the bridge — the question the paragraph-loss
  // defect (2026-06-12) could not answer without body logging.
  logOutbound('envelope.start', {
    from: envelope.fromPersonality,
    botKey,
    rich: tryRich,
    len: envelope.message.length,
    nlnl: (envelope.message.match(/\n\n/g) ?? []).length,
    nl: (envelope.message.match(/\n/g) ?? []).length,
    cr: (envelope.message.match(/\r/g) ?? []).length,
    attachments: envelope.attachments.length,
    queueDepth: outboundQueueDepth,
  })
  let mode: 'rich' | 'chunks' = 'chunks'
  let chunksSent: number | undefined
  if (tryRich && (await sendRichResilient(bot, ctx.ownerUserId, richText))) {
    mode = 'rich'
  } else {
    const chunks = chunkText(envelope.message)
    for (let i = 0; i < chunks.length; i++) {
      await sendChunkResilient(bot, ctx.ownerUserId, chunks[i], { chunk: i + 1, of: chunks.length })
    }
    chunksSent = chunks.length
  }
  for (const filePath of envelope.attachments) {
    await sendFileViaRawApi({ credential, chatId: ctx.ownerUserId, filePath })
  }
  // The answer has landed in the chat. Finalize+reset this peer's live activity
  // status so its stream doesn't stay stuck above the answer — the next tool call
  // opens a fresh status message below it (v0.7). Best-effort, never blocks.
  checkpointActivity(envelope.fromPersonality)
  logOutbound('envelope.done', {
    from: envelope.fromPersonality,
    mode,
    chunks: chunksSent,
    attachments: envelope.attachments.length,
  })
}

function installStdinEnvelopeReader(ctx: RuntimeContext): void {
  let buffer = ''
  // When stdin is a pty (under pty hosting), the canonical line-discipline caps a single
  // line at MAX_CANON (~1024B on macOS) and silently drops every overflow byte
  // (each echoed as BEL ^G), which truncates long single-line IAP envelopes and
  // wedges the channel. Raw mode disables that line-discipline. Guard on isTTY:
  // setRawMode throws on a non-tty stdin (e.g. piped input). The reader already
  // buffers raw bytes and slices on <iap>…</iap> markers, so raw mode is safe.
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += String(chunk)
    const extracted = extractIapEnvelopes(buffer)
    buffer = extracted.rest
    for (const raw of extracted.envelopes) {
      enqueueOutbound(async () => {
        // No-silent-drop contract (defect track telegram-sender-policy,
        // 2026-06-11): ANY envelope this bridge gives up on MUST leave a
        // STRUCTURED `envelope.drop` event with the reason and (when parseable)
        // the sender. The queue's catch-all already wrote a plain-text stderr
        // line, but plain text is invisible to forensics grepping the
        // structured `evt:` stream — exactly how the "sender without
        // interfaces.telegram.bot" drops at 13:01Z/16:48Z went unseen while
        // the daemon reported ok=true. The error still rethrows so the
        // existing catch-all line stays as a human-readable echo.
        let envelope: IapEnvelope
        try {
          envelope = parseIapEnvelope(raw)
        } catch (err) {
          logOutbound('envelope.drop', { stage: 'parse', reason: formatError(err) })
          throw err
        }
        try {
          await sendOutboundToTelegram(ctx, envelope)
        } catch (err) {
          logOutbound('envelope.drop', {
            stage: 'send',
            from: envelope.fromPersonality,
            reason: formatError(err),
          })
          throw err
        }
      })
    }
  })
  process.stdin.resume()
}

async function prepareCommand(args: string[]): Promise<void> {
  const { flags } = parseFlags(args)
  let profile = ensureCurrentProfile()
  const userId = stringFlag(flags, 'user-id')
  if (userId) {
    profile = setTelegramInterface(profile, { user_id: userId })
    writePeerProfile(process.cwd(), profile)
  }
  process.stdout.write(`${peerProfilePath(process.cwd())}\n`)
  printJson(profile)
}

async function interfaceCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  const { positional, flags } = parseFlags(rest)
  if (sub === 'human') {
    const userId = stringFlag(flags, 'user-id')
    if (!userId) throw new TelegramRuntimeError('interface human requires --user-id')
    const profile = setTelegramInterface(ensureCurrentProfile(), { user_id: userId })
    writePeerProfile(process.cwd(), profile)
    printJson(profile)
    return
  }
  if (sub === 'bot') {
    const botKey = positional[0]
    const peer = stringFlag(flags, 'peer')
    if (!botKey || !peer) {
      throw new TelegramRuntimeError('interface bot requires <bot-key> --peer <personality>')
    }
    assertName(botKey, 'bot-key')
    assertName(peer, 'peer')
    const path = findPeerProfilePath(peer)
    const cwd = dirname(dirname(path))
    const profile = readPeerProfile(cwd)
    if (!profile) throw new TelegramRuntimeError(`${path} missing`)
    // The profile stores ONLY the bot catalog key. The bot's real @username is NOT
    // copied here (that was a write-only duplicate of bots/<key>/.env): it lives once
    // in the credential .env (filled by `bot add` via getMe) and is derived from there
    // for any human-readable display (see `bot list`).
    const updated = setTelegramInterface(profile, { bot: botKey })
    writePeerProfile(cwd, updated)
    printJson(updated)
    return
  }
  throw new TelegramRuntimeError(usage())
}

async function botCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  const { positional, flags } = parseFlags(rest)
  if (sub === 'add') {
    const botKey = positional[0]
    const token = stringFlag(flags, 'token')
    if (!botKey || !token) throw new TelegramRuntimeError('bot add requires <bot-key> --token')
    assertName(botKey, 'bot-key')
    ensureScaffold()
    const path = botEnvPath(botKey)
    const env = readEnvFile(path)
    env.TELEGRAM_BOT_TOKEN = token
    const usernameFlag = stringFlag(flags, 'username')
    // getMe validation: Telegram is the source of truth for @username. An answered
    // rejection is fatal; an unreachable API degrades to the explicit --username
    // (offline escape hatch) with a warning, or fails when there is nothing to fall
    // back on. On success the getMe username WINS over a conflicting --username.
    const probe = await probeBotIdentity(token)
    if (probe.ok) {
      if (usernameFlag && usernameFlag !== probe.username) {
        process.stderr.write(
          `warn: --username ${usernameFlag} does not match getMe (@${probe.username}); using getMe\n`,
        )
      }
      env.TELEGRAM_BOT_USERNAME = probe.username
    } else if (probe.reason === 'invalid-token') {
      throw new TelegramRuntimeError(`bot add: Telegram rejected the token (getMe: ${probe.detail})`)
    } else if (usernameFlag) {
      process.stderr.write(
        `warn: getMe unreachable (${probe.detail}); writing --username ${usernameFlag} unvalidated\n`,
      )
      env.TELEGRAM_BOT_USERNAME = usernameFlag
    } else {
      throw new TelegramRuntimeError(
        `bot add: getMe unreachable (${probe.detail}); retry with network, or pass --username to add offline`,
      )
    }
    writeEnvFile(path, env)
    process.stdout.write(`wrote ${path}\n`)
    process.stdout.write(`username @${env.TELEGRAM_BOT_USERNAME}\n`)
    return
  }
  if (sub === 'remove') {
    const botKey = positional[0]
    if (!botKey) throw new TelegramRuntimeError('bot remove requires <bot-key>')
    assertName(botKey, 'bot-key')
    rmSync(botDir(botKey), { recursive: true, force: true })
    process.stdout.write(`removed ${botDir(botKey)}\n`)
    return
  }
  if (sub === 'list') {
    const bots = listBotKeys().map(key => {
      const env = readEnvFile(botEnvPath(key))
      return {
        key,
        env: botEnvPath(key),
        configured: Boolean(env.TELEGRAM_BOT_TOKEN),
        username: env.TELEGRAM_BOT_USERNAME ?? null,
      }
    })
    if (flags.json) printJson(bots)
    else
      for (const bot of bots)
        process.stdout.write(
          `${bot.key} ${bot.configured ? 'configured' : 'missing-token'}${bot.username ? ` @${bot.username}` : ''}\n`,
        )
    return
  }
  throw new TelegramRuntimeError(usage())
}

async function doctorCommand(args: string[]): Promise<void> {
  const { flags } = parseFlags(args)
  const problems: string[] = []
  const profile = readPeerProfile(process.cwd())
  if (!profile) problems.push(`${peerProfilePath(process.cwd())} missing`)
  const ownerUserId = profile ? telegramInterface(profile).user_id : undefined
  if (profile && !ownerUserId) problems.push('current peer missing interfaces.telegram.user_id')
  const directory = readPeerDirectory()
  const bots = listBotKeys().map(key => {
    const botEnv = readEnvFile(botEnvPath(key))
    const tokenConfigured = Boolean(botEnv.TELEGRAM_BOT_TOKEN)
    const target = directory.byTelegramBot.get(key)
    if (!tokenConfigured) problems.push(`bot ${key} missing TELEGRAM_BOT_TOKEN`)
    if (!target) problems.push(`bot ${key} is not mapped by any peer interfaces.telegram.bot`)
    return {
      key,
      token_configured: tokenConfigured,
      username: botEnv.TELEGRAM_BOT_USERNAME ?? null,
      target_peer: target?.personality ?? null,
    }
  })
  if (bots.length === 0) problems.push(`${botsRoot()} has no configured bots`)
  const result = {
    ok: problems.length === 0,
    cwd: process.cwd(),
    profile_path: peerProfilePath(process.cwd()),
    owner: profile
      ? {
          personality: profile.personality,
          runtime: profile.runtime,
          user_id_configured: Boolean(ownerUserId),
        }
      : null,
    bots,
    peers_index: peersIndexPath(),
    problems,
  }
  if (flags.json) printJson(result)
  else {
    process.stdout.write(`${result.ok ? 'ok' : 'not ok'}\n`)
    for (const problem of problems) process.stdout.write(`- ${problem}\n`)
  }
  if (!result.ok) process.exitCode = 1
}

async function runCommand(): Promise<void> {
  ensureScaffold()
  const owner = readPeerProfile(process.cwd())
  if (!owner) {
    throw new TelegramRuntimeError(`missing ${peerProfilePath(process.cwd())}; run telegram-runtime prepare`)
  }
  const ownerUserId = telegramInterface(owner).user_id
  if (!ownerUserId) {
    throw new TelegramRuntimeError('current peer missing interfaces.telegram.user_id')
  }
  const credentials = new Map<string, BotCredential>()
  const bots = new Map<string, Bot>()
  const releaseLocks: ReleaseLock[] = []
  let commandsSyncTimer: ReturnType<typeof setInterval> | undefined
  const cleanup = () => {
    if (commandsSyncTimer) clearInterval(commandsSyncTimer)
    for (const release of releaseLocks.splice(0).reverse()) release()
  }
  process.once('exit', cleanup)
  process.once('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })
  for (const key of listBotKeys()) {
    releaseLocks.push(acquireBotLock(key))
    const credential = loadCredential(key)
    credentials.set(key, credential)
    bots.set(key, new Bot(credential.token, { client: { fetch: runtimeFetch as typeof fetch } }))
  }
  if (bots.size === 0) throw new TelegramRuntimeError(`${botsRoot()} has no configured bots`)
  const ctx: RuntimeContext = {
    cwd: process.cwd(),
    owner,
    ownerUserId,
    iapBin: process.env.TELEGRAM_RUNTIME_IAP_BIN ?? process.env.IAP_BIN ?? 'iapeer',
    bots,
    credentials,
  }
  for (const [botKey, bot] of bots) {
    installBotHandlers(ctx, botKey, bot, credentials.get(botKey)!)
  }
  installStdinEnvelopeReader(ctx)
  process.stderr.write(
    `telegram-runtime: running ${RUNTIME}-${owner.personality}; bots=${Array.from(bots.keys()).join(', ')}\n`,
  )
  // Slash-menu (setMyCommands): register each bot's owner-scoped menu on start, then
  // re-sync on an interval so an owner edit to a peer-profile's aliases/runtimes lands
  // in the menu without a runtime restart (each sync re-registers ONLY on change).
  for (const [botKey, bot] of bots) void syncBotCommands(ctx, botKey, bot)
  const commandsSyncMs = Number(process.env.TELEGRAM_COMMANDS_SYNC_MS ?? '') || 30_000
  commandsSyncTimer = setInterval(() => {
    for (const [botKey, bot] of bots) void syncBotCommands(ctx, botKey, bot)
  }, commandsSyncMs)
  commandsSyncTimer.unref?.()
  await Promise.all(Array.from(bots.entries()).map(([key, bot]) => startPolling(key, bot)))
}

// `telegram-runtime` (bare) / `self-install`: the npx self-deploy contract. Place the
// launcher bin on PATH (a self-contained compiled snapshot, overwriting any legacy
// symlink) + write the runtime manifest at <IAPEER_ROOT>/runtimes/telegram/runtime.json
// (NO peers[] — operator-add). IDEMPOTENT. This is the npx↔foundation seam — after it,
// `iapeer create <human> --runtime telegram` resolves the launcher, bakes it into the
// always-on plist (TELEGRAM_RUNTIME_BIN), and runs the per-peer self-config hook.
async function selfInstallCommand(): Promise<void> {
  const r = selfInstall({ env: process.env, sourceEntry: import.meta.path })
  process.stdout.write('telegram-runtime self-install (idempotent)\n')
  process.stdout.write(`  bin:      ${r.binPath}  (${r.binMode})\n`)
  process.stdout.write(`  manifest: ${r.manifestPath}\n`)
  process.stdout.write(`  root:     ${r.root}\n`)
  process.stdout.write(
    `  docs:     ${r.docs.copied ? r.docs.dest : `skipped (${r.docs.reason ?? 'unknown'})`}\n`,
  )
  process.stderr.write(
    `telegram-runtime ${JSON.stringify({ ts: new Date().toISOString(), evt: 'self-install', bin: r.binPath, manifest: r.manifestPath, binMode: r.binMode, root: r.root, docs: r.docs })}\n`,
  )
}

// `telegram-runtime self-config`: the PER-PEER self-config hook the foundation invokes
// inside createPeer→initPeer (cwd = peer cwd, IAPEER_PEER_* in env). Merges this human's
// telegram presence (user_id + bot, from env) into the local peer profile, PRESERVING
// the foundation-provisioned identity (intelligence=natural). exit 0 = configured.
async function selfConfigCommand(): Promise<void> {
  const r = runSelfConfig({ env: process.env, cwd: process.cwd() })
  process.stdout.write(`${r.profilePath}\n`)
  process.stdout.write(
    `telegram-runtime self-config: configured peer "${r.personality}"` +
      `${r.userId ? ` user_id=${r.userId}` : ''}${r.bot ? ` bot=${r.bot}` : ''}` +
      `${r.botEnvPath ? ` (credential ${r.botEnvPath})` : ''}\n`,
  )
  process.stderr.write(
    `telegram-runtime ${JSON.stringify({ ts: new Date().toISOString(), evt: 'self-config', personality: r.personality, userId: r.userId, bot: r.bot, profile: r.profilePath })}\n`,
  )
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === '--help' || cmd === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (!cmd) {
    // Bare invocation = the npx self-install contract (the foundation's
    // defaultNpxRunner runs `npx -y <package>` with NO args).
    await selfInstallCommand()
    return
  }
  switch (cmd) {
    case 'self-install':
    case 'install':
      await selfInstallCommand()
      return
    case 'self-config':
      await selfConfigCommand()
      return
    case 'prepare':
      await prepareCommand(rest)
      return
    case 'interface':
      await interfaceCommand(rest)
      return
    case 'bot':
      await botCommand(rest)
      return
    case 'run':
      await runCommand()
      return
    case 'doctor':
      await doctorCommand(rest)
      return
    default:
      throw new TelegramRuntimeError(usage())
  }
}

if (import.meta.main) {
  main().catch(err => {
    process.stderr.write(`telegram-runtime: ${formatError(err)}\n`)
    process.exit(1)
  })
}
