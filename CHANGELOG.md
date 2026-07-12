# Changelog

All notable changes to **telegram-runtime** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Granular history begins at the initial public release (0.16.5); earlier work
predates the public repository.

## [Unreleased]

## [0.25.0] - 2026-07-12

### Added
- Live-runtime resolution hardened against the runtime-flip race. The freshest-pane-log
  heuristic (`liveRuntime`) can briefly pick the just-died runtime at a fast `/claude`↔`/codex`
  switch boundary, keying a whole turn's typing/tool-use indicators to dead artifacts (live
  incident 2026-06-22: an active turn rendered 0 steps). Turn start now resolves the runtime
  authoritatively via the foundation verb `iapeer live-runtime <peer>` (reads pid-alive pty
  sessions; foundation ≥0.4.22) with the mtime heuristic as fallback — new
  `resolveLiveRuntime` with a 5s per-peer cache and a 60s negative window so a foundation
  without the verb keeps the old behavior at zero extra cost. Mid-turn, the pane loop watches
  for heuristic/resolved disagreement and, on a verb-confirmed flip, re-keys the busy-gate and
  re-tails the new runtime's transcript in place (`runtime-flip` activity event). The
  `/<runtime>` switch no-op guard uses the verified resolution too.

### Changed
- grammy bumped `^1.21.0` → `^1.44.0`: `@grammyjs/types` 3.28 ships the Bot API 10.1
  `sendRichMessage` typing, so the rich outbound call is now natively typed through
  `bot.api.raw` — the transitional name-keyed-Proxy cast in `sendRichResilient` is removed
  (the follow-up the 0.14.0 rich adoption left open). No behavioral change: the payload shape
  is identical, the typecheck now proves it against the API schema.

## [0.23.0] - 2026-07-12

### Removed
- bot_username cutover transitional debt (dedicated debt-removal release; the 0.20.0 cutover
  soaked 22 days and the fleet is verified clean — `migrate-bot-keys --dry-run --json` reported
  zero dir renames, zero profile rewrites, zero warnings; no host profile or env file carries a
  legacy key). Gone: the legacy `bot` read-fallback in `peerBotKey` (and the `bot` field in the
  profile type), the NAME_RE arm in `listBotKeys` (credential dirs are matched by the
  bot-username grammar only), the whole `migrateBotKeys` machinery with its `migrate-bot-keys`
  CLI command and startup invocation, and self-config's legacy `TELEGRAM_BOT` env fallback plus
  the retired-`bot`-field strip (the foundation passes `TELEGRAM_BOT_USERNAME` only).
  `interfaces.telegram.bot_username` is now the single bot key on every path.

## [0.22.1] - 2026-07-06

### Fixed
- `onboard-approval` is cwd-clean: the verb no longer depends on the invoking working
  directory, so it runs identically from any location.

## [0.22.0] - 2026-07-06

### Added
- Approval service-bot `@approver_iapeer_bot` and the FACELESS route (Ф3 U4): peers without
  their own Telegram bot (implementers, infra) get their approval cards in the single
  dedicated approval bot — a pure telegram-runtime service bot, no foundation peer behind it.
  `onboard-approval` provisions it, with a DOUBLE warning when the operator declines.

## [0.21.0] - 2026-07-06

### Added
- Human-approval Telegram channel (Ф3 U1–U3) on top of the iapeer broker queue: fleet-API
  client with feature-detect (U1 — a host without the broker degrades silently), an
  approval-face SSE consumer with a dedup/reconcile state machine (U2 — restarts re-attach to
  pending requests without duplicate cards), and Allow/Deny cards carrying the VERBATIM action
  content with a `callback_query` handler gated to the owner (U3). A resolution from any
  channel (Telegram tap, CLI) extinguishes the request everywhere — single-queue invariant.

## [0.20.5] - 2026-06-23

### Fixed
- Rich outbound: a single `\n` renders as a line break (GFM hard break) instead of being
  swallowed by paragraph folding.

## [0.20.4] - 2026-06-23

### Added
- Structured observability for the INBOUND (Telegram → IAP) path — the mirror of the existing
  outbound log that was missing. Every inbound delivery now emits one-line JSON events
  (`inbound.start`, `inbound.ok`, `inbound.fail`) to the runtime log, including `woke` (parsed
  from the `iapeer send` result), `ms`, `len` and `att`. Before this, the inbound path logged
  nothing on success and only an unstructured stderr line on failure, so a lost inbound message
  left no trace in `telegram-<peer>.log` — the "no inbound records" symptom of the 2026-06-23
  silent-loss incident. Logging `woke=false` makes the live-injection path (the one that can be
  lost downstream by iapeer's mtime-proxy landed-confirm) auditable from the bridge side. The
  bridge still cannot re-verify delivery — reliability of the live-injection path is iapeer's
  layer — but the loss is no longer invisible. Disable with `TELEGRAM_INBOUND_LOG=0`.

## [0.20.3] - 2026-06-22

### Fixed
- The Telegram `/<runtime>` switch command (e.g. `/codex`) now makes the target runtime the
  peer's PERMANENT default, not just a one-shot restart. It previously ran `iapeer new <peer>
  <rt>` alone — starting the peer on `<rt>` once but leaving `default_runtime` unchanged, so the
  next idle-reap/wake reverted to the old default. It now persists first via `iapeer
  default-runtime <rt> --peer <peer>` (atomic local-profile write + registry reindex), and
  aborts the restart if the persist fails (so the peer never comes up on a runtime it will
  silently revert from).

## [0.20.2] - 2026-06-22

### Fixed
- Typing and tool-use/activity indicators now work for a peer running a NON-default
  runtime (e.g. codex while its `default_runtime` is claude). The runtime was resolved
  from the profile's `default_runtime` rather than the *live* runtime, so the typing
  busy-gate (pane-log mtime) and the transcript path/parser keyed to absent/stale claude
  artifacts and both indicators silently died. `liveRuntime()` now resolves the active
  runtime from the freshest `<runtime>-<personality>.log` pane-log — the file the iapeer
  supervisor writes only for the live runtime — falling back to the declared default when
  no pane-log exists (a never-run peer). The same fix corrects the runtime-switch
  "already on" guard, which compared against `default_runtime`.

## [0.20.1] - 2026-06-21

### Fixed
- Outbound GIF attachments are sent with `sendAnimation` instead of `sendPhoto`.
  Telegram's photo path runs image processing that rejects GIFs
  (`IMAGE_PROCESS_FAILED`), which silently dropped every GIF; they now deliver and
  play inline.

### Changed
- Documentation actualized for the `bot_username` binding model — `docs/` (EN + RU)
  and the dev notes.

## [0.20.0] - 2026-06-20

### Changed
- A bot's `@username` is now its natural key. `interfaces.telegram.bot_username`
  names the credential directory (`bots/<username>/`), the profile binding, and
  inbound/outbound routing — replacing the redundant `bot` field.
- `bot add <bot-username>` and `interface bot <bot-username>` take the `@username`;
  `bot add` validates it against Telegram (`getMe`) and refuses a mismatch (which
  would mis-route).

### Added
- Idempotent cutover migration: credential directories are renamed to
  `bots/<username>/` and local profiles rewritten to `bot_username` automatically at
  startup (zero-gap), also runnable as `migrate-bot-keys [--dry-run] [--json]`.

### Removed
- The redundant `interfaces.telegram.bot` field (it duplicated the peer name). It is
  still read as a fallback during the migration window and will be dropped in a later
  release.

## [0.19.4] - 2026-06-20

### Changed
- `writePeerProfile` persists `default_runtime` and drops the legacy `runtime` mirror,
  so a local profile mutation no longer re-seeds the retired field.

## [0.19.3] - 2026-06-20

### Changed
- Intelligence vocabulary is now `natural` | `artificial` | `absent` (the legacy
  `human` / `scripted` values are normalized at the boundary).
- Profile reads resolve the runtime from `default_runtime` first, falling back to the
  legacy `runtime` mirror.

## [0.19.2] - 2026-06-20

### Removed
- Transitional debt: the `interfaces.telegram.aliases` read-fallback (and
  `TelegramInterface.aliases`), the `CLAUDE_TG_PROXY` environment variable, and the
  `install` command alias.

## [0.19.1] - 2026-06-20

### Changed
- Internal dead-code removal and de-duplication (a shared `writeJsonAtomic`, shared
  `sleep` / `backoffMs` across the send-retry loops, constants imported from one
  source). No behavior change.

## [0.19.0] - 2026-06-19

### Added
- The bot's slash-menu is auto-registered in Telegram (`setMyCommands`): control
  commands, alias shortcuts, and — for an agent declared on two or more runtimes — a
  hard runtime switch (`/claude`, `/codex`). The menu re-syncs when the agent's
  profile changes.

## [0.18.0] - 2026-06-18

### Changed
- The bot `@username` is no longer written into the profile (it was a write-only
  duplicate); it is derived from the bot's credential `.env`.

### Added
- Minimal continuous-integration workflow and status badges.

## [0.17.0] - 2026-06-18

### Added
- On-host documentation: install scaffolds `docs/` into
  `~/.iapeer/docs/telegram-runtime/`.

## [0.16.6] - 2026-06-18

### Added
- `docs/` is shipped inside the npm package.

## [0.16.5] - 2026-06-18

- Initial public release.

[Unreleased]: https://github.com/agfpd/telegram-runtime/compare/298ec51...HEAD
[0.20.1]: https://github.com/agfpd/telegram-runtime/compare/bd2d0d9...298ec51
[0.20.0]: https://github.com/agfpd/telegram-runtime/compare/d101caf...bd2d0d9
[0.19.4]: https://github.com/agfpd/telegram-runtime/compare/c0381e3...d101caf
[0.19.3]: https://github.com/agfpd/telegram-runtime/compare/1d72471...c0381e3
[0.19.2]: https://github.com/agfpd/telegram-runtime/compare/595ccfa...1d72471
[0.19.1]: https://github.com/agfpd/telegram-runtime/compare/3c42ad1...595ccfa
[0.19.0]: https://github.com/agfpd/telegram-runtime/compare/606f935...3c42ad1
[0.18.0]: https://github.com/agfpd/telegram-runtime/compare/2b2ef55...606f935
[0.17.0]: https://github.com/agfpd/telegram-runtime/compare/ae7aa05...2b2ef55
[0.16.6]: https://github.com/agfpd/telegram-runtime/compare/d4f9070...ae7aa05
[0.16.5]: https://github.com/agfpd/telegram-runtime/commit/d4f9070
