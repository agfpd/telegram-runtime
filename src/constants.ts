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

/** Peer-name grammar — identical to the IAP/foundation ecosystem
 *  (/^[a-z][a-z0-9-]{0,31}$/). */
export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

export const IAPEER_DIR = '.iapeer'
export const PEER_PROFILE_FILE = 'peer-profile.json'
