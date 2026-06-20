// Per-peer self-config hook — the shared contract BOTH provision modes call (Волна 2,
// doc «Протокол iapeer рантайма» § «Per-peer self-config-хук»). The foundation invokes
// it per peer as `telegram-runtime self-config` with cwd = the peer's cwd and the peer
// context in NAMESPACED env (IAPEER_PEER_PERSONALITY/_CWD/_RUNTIME/_INTELLIGENCE +
// IAPEER_ROOT — NOT the bare PEER_* the identity gate keys on). Our job is the RICH,
// telegram-specific state: this human's telegram PRESENCE (user_id + linked bot →
// interfaces.telegram), plus the bot credential when the operator hands one in.
//
// IDEMPOTENT ("ensure runtime state for peer X"): read-merge-write, byte-stable. exit 0
// = configured, ≠0 = failed (the foundation is fail-closed — a failed hook means the
// plist is written but NOT bootstrapped, so a misconfigured always-on telegram session
// never crash-loops).
//
// IDENTITY IS THE FOUNDATION'S DOMAIN — and telegram is intelligence-GATED (the launch
// primitive requires `natural`; the foundation provisions it). So the hook does a RAW
// read-merge-write that PRESERVES every field the foundation provisioned (especially
// `intelligence`=natural and `personality`). It deliberately does NOT use a typed
// reader that would coerce the contract `natural` back to the legacy `human` and
// clobber it (exactly the pilot-notifier lesson: preserve, don't re-derive identity).
//
// OPERATOR INPUTS come via env at `iapeer create` time (the foundation forwards the
// whole env into the hook): TELEGRAM_USER_ID → interfaces.telegram.user_id; the bot
// @username (TELEGRAM_BOT_USERNAME, or the legacy TELEGRAM_BOT key as a fallback) →
// interfaces.telegram.bot_username — the NATURAL KEY that also names the credential dir
// bots/<username>/.env (decision 2026-06-20). TELEGRAM_BOT_TOKEN → that credential .env
// under the IAPEER_ROOT-aware bots registry. Absent inputs → the hook is still
// `configured` (a no-op that confirms state); the operator can complete user_id/bot
// later via the `interface`/`bot` verbs.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import { IAPEER_DIR, NAME_RE, PEER_PROFILE_FILE, RUNTIME } from './constants.ts'
import { resolveIapeerRoot } from './manifest.ts'
import { writeJsonAtomic } from './fsAtomic.ts'

export interface SelfConfigOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export interface SelfConfigOutcome {
  personality: string
  profilePath: string
  /** What was written into interfaces.telegram this run (for the CLI summary/log). */
  userId?: string
  botUsername?: string
  /** Path of the bot credential .env, when a TELEGRAM_BOT_TOKEN was provided. */
  botEnvPath?: string
}

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v && v.length > 0 ? v : undefined
}

/** Normalize a telegram @username to its catalog/dir key form: trim, strip a leading
 *  '@', lowercase (Telegram usernames are case-insensitive; on-disk keys must be
 *  deterministic). Mirrors cli.ts normalizeBotUsername; kept local so this contract
 *  module stays free of the grammy run-loop in cli.ts. */
function normalizeBotUsername(value: string | undefined): string | undefined {
  const v = value?.trim().replace(/^@/, '').toLowerCase()
  return v && v.length > 0 ? v : undefined
}

/** Resolve the peer's personality for this hook invocation: prefer the NAMESPACED
 *  IAPEER_PEER_PERSONALITY (the contract env), then the bare PEER_PERSONALITY, then the
 *  cwd basename (so a manual `telegram-runtime self-config` in a peer cwd still works). */
function resolvePersonality(env: NodeJS.ProcessEnv, cwd: string): string {
  const candidate =
    trimmed(env.IAPEER_PEER_PERSONALITY) ?? trimmed(env.PEER_PERSONALITY) ?? basename(cwd).toLowerCase()
  if (!NAME_RE.test(candidate)) {
    throw new Error(`self-config: resolved personality "${candidate}" must match /^[a-z][a-z0-9-]{0,31}$/`)
  }
  return candidate
}

function peerProfilePath(cwd: string): string {
  return join(cwd, IAPEER_DIR, PEER_PROFILE_FILE)
}

/** Read the peer profile as a RAW object (no typed coercion) so every foundation-
 *  provisioned field — especially `intelligence` — round-trips untouched. Returns {}
 *  when the file is absent or malformed (nothing to preserve in the malformed case). */
function readRawProfile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  } catch {
    // malformed → start clean (nothing valid to preserve)
  }
  return {}
}

/** Write a bot credential .env under the IAPEER_ROOT-aware bots registry — the SAME
 *  path `telegram-runtime run` reads (cli.ts botEnvPath). Idempotent: re-running with
 *  the same token rewrites identical content. */
function writeBotCredential(
  env: NodeJS.ProcessEnv,
  botKey: string,
  token: string,
  username: string | undefined,
): string {
  const botDir = join(resolveIapeerRoot(env), 'runtimes', RUNTIME, 'bots', botKey)
  mkdirSync(botDir, { recursive: true, mode: 0o700 })
  const path = join(botDir, '.env')
  const lines = [`TELEGRAM_BOT_TOKEN=${token}`]
  if (username) lines.push(`TELEGRAM_BOT_USERNAME=${username}`)
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  chmodSync(path, 0o600)
  return path
}

/**
 * Configure runtime state for ONE telegram peer (idempotent). Merges this human's
 * telegram presence (user_id + linked bot, from env) into <cwd>/.iapeer/
 * peer-profile.json `interfaces.telegram`, PRESERVING every other field — most
 * importantly the foundation-provisioned `intelligence` (natural). When a bot token is
 * supplied, also writes its credential .env into the IAPEER_ROOT-aware bots registry.
 * Atomic tmp+rename. Returns what was configured.
 */
export function runSelfConfig(opts: SelfConfigOptions = {}): SelfConfigOutcome {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? trimmed(env.IAPEER_PEER_CWD) ?? process.cwd()
  const personality = resolvePersonality(env, cwd)
  const profilePath = peerProfilePath(cwd)

  const profile = readRawProfile(profilePath)

  // Operator-supplied telegram presence (env, forwarded by the foundation). The bot
  // @username is the natural key: prefer TELEGRAM_BOT_USERNAME, fall back to the legacy
  // TELEGRAM_BOT key (provisioning that predates the cutover).
  const userId = trimmed(env.TELEGRAM_USER_ID)
  const botUsername = normalizeBotUsername(env.TELEGRAM_BOT_USERNAME) ?? normalizeBotUsername(env.TELEGRAM_BOT)
  const token = trimmed(env.TELEGRAM_BOT_TOKEN)

  // Merge interfaces.telegram (preserve any existing telegram fields, e.g. an operator-
  // set `activity` flag). Only set user_id/bot_username when provided — never blank out.
  const interfaces =
    profile.interfaces && typeof profile.interfaces === 'object' && !Array.isArray(profile.interfaces)
      ? { ...(profile.interfaces as Record<string, unknown>) }
      : {}
  const telegram =
    (interfaces as { telegram?: unknown }).telegram &&
    typeof (interfaces as { telegram?: unknown }).telegram === 'object'
      ? { ...((interfaces as { telegram: Record<string, unknown> }).telegram) }
      : {}
  if (userId) telegram.user_id = userId
  if (botUsername) telegram.bot_username = botUsername
  // The @username IS the catalog key and also names the credential dir bots/<username>/.
  // The retired `bot` field (== personality duplicate) is stripped on every pass so an
  // idempotent re-config cleans up any legacy value left from before the cutover.
  delete telegram.bot
  ;(interfaces as Record<string, unknown>).telegram = telegram

  // Identity stays the foundation's domain — spread the raw profile FIRST so every
  // provisioned field (intelligence=natural, personality, runtimes, description, and
  // any unknown adjacent-contract fields) is preserved; only `interfaces` is replaced.
  const merged: Record<string, unknown> = { ...profile, interfaces }

  writeJsonAtomic(profilePath, merged)

  let botEnvPath: string | undefined
  if (botUsername && token) {
    // Credential dir keyed by @username; the .env records the same username so the dir
    // name and TELEGRAM_BOT_USERNAME stay in lockstep (the invariant migrateBotKeys relies on).
    botEnvPath = writeBotCredential(env, botUsername, token, botUsername)
  }

  return { personality, profilePath, userId, botUsername, botEnvPath }
}
