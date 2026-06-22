# Changelog

All notable changes to **telegram-runtime** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Granular history begins at the initial public release (0.16.5); earlier work
predates the public repository.

## [Unreleased]

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
