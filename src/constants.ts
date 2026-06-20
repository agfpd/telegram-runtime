// Shared constants for the telegram runtime PACKAGE-FACING contract surface
// (Волна 2 — manifest / self-install / self-config). Kept tiny and dependency-free
// so the contract modules (manifest.ts / selfInstall.ts / selfConfig.ts) can import
// it without pulling in the grammy run-loop in cli.ts.

import pkg from '../package.json'

/** The runtime id this package implements — the namespace folder under
 *  ~/.iapeer/runtimes/<runtime>/ AND the manifest's `runtime` field. */
export const RUNTIME = 'telegram'

/** The package version — single source of truth is package.json (bundled into the
 *  compiled bin by `bun build --compile`, and read from disk under `bun src/cli.ts`).
 *  Stamped into the runtime manifest (foundation reads it for `iapeer status` and
 *  `update-runtime` version-gating vs npm-latest). Bumping package.json is enough;
 *  nothing here needs hand-editing. */
export const VERSION: string = pkg.version

/** The launcher binary name placed on PATH — `<runtime>-runtime`. Mirrors the
 *  foundation's INFRA_RUNTIME_DEFAULT_BIN.telegram and the telegram adapter's
 *  buildArgv fallback (`telegram-runtime`). */
export const BIN_NAME = `${RUNTIME}-runtime`

/** The unscoped npm package name — the per-package subdir id for the FU6 on-host docs
 *  convention (`<IAPEER_ROOT>/docs/<PACKAGE_NAME>/`). The scope is stripped
 *  (`@agfpd/telegram-runtime` → `telegram-runtime`). Single source of truth is
 *  package.json `name`; happens to equal BIN_NAME here but is a distinct concept (the
 *  PACKAGE identity, not the launcher binary name). */
export const PACKAGE_NAME: string = pkg.name.split('/').pop() ?? pkg.name

/** Peer-name grammar — identical to the IAP/foundation ecosystem
 *  (/^[a-z][a-z0-9-]{0,31}$/). */
export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

/** Telegram bot @username grammar — the natural key of a telegram bot (decision
 *  2026-06-20: `bot_username` replaces the redundant `bot` catalog key). Telegram
 *  usernames are 5–32 chars, [A-Za-z0-9_], start with a letter, do NOT end in an
 *  underscore (bot usernames conventionally end in "bot"). DISTINCT from NAME_RE:
 *  it permits underscores (which peer names forbid) and forbids hyphens (which peer
 *  names allow) — that disjointness is load-bearing, it lets listBotKeys tell a
 *  username-named credential dir from a legacy personality-named one during the
 *  transition. @username lookups are case-insensitive in Telegram, so keys are
 *  normalized to lowercase before use (see normalizeBotUsername). */
export const BOT_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/

export const IAPEER_DIR = '.iapeer'
export const PEER_PROFILE_FILE = 'peer-profile.json'
