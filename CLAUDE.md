# telegram-runtime — dev-notes

Dev-doc for the Implementer working on this project (the `telegram-runtime`
source). You are spawned on-demand by the PM (boris) to do scoped work here and
report back over IAP. This file is read by both Claude (`CLAUDE.md`) and Codex
(`AGENTS.md` → symlink to this file).

## What this is

`telegram-runtime` is the Telegram runtime-router for IAP peers. It is NOT a
Claude/Codex MCP channel and exposes no Telegram tools to agents. It runs as a
real IAP runtime endpoint for a human peer (e.g. arthur): receives IAP envelopes
on stdin and delivers them to the right Telegram bot; receives Telegram updates
(text/voice/attachments) and forwards them to the peer over IAP.

- Single entry: `src/cli.ts` (commands: `run`, `doctor`, `prepare`, …).
- Telegram bindings are derived from peer passports
  (`<peer-cwd>/.iapeer/peer-profile.json`, `~/.iapeer/peers-profiles.json`),
  not a separate source of truth.
- Telegram lib: `grammy`. Outbound sends go through a serial promise queue
  (`enqueueOutbound`); inbound voice is transcribed via an OpenAI-compatible STT
  endpoint (speaches) with an mlx fallback.

## Self-check before any change

- `bun test` passes (`tests/`).
- `bun src/cli.ts doctor --json` runs clean.
- `tsc --noEmit` (typecheck) is clean.
- Behavioral acceptance is LIVE: a fix is proven by reproducing the failure on a
  running runtime and watching it pass — not by diff or typecheck alone.

## Release → Deploy — publish to npm, THEN activate from the cloud

Activation is two ordered phases. Run them in order and never substitute a
working-tree build for the deploy — reordering or bypassing is how the registry
desynced (0.16.3 reached the dev-host via a working-tree self-install while npm sat
5 minors behind, until corrected 2026-06-14).

1. RELEASE: bump `package.json`, commit, push to origin, then `npm publish` on EVERY
   bump so the registry is the source of truth (matching the iapeer/notifier runtimes).
   Push BEFORE publish with an EXPLICIT `git push origin <branch>` (never a bare
   `git push --follow-tags`, never publish-without-push): a push failure then surfaces
   before the registry moves ahead of origin — otherwise npm carries a version git
   lacks (silent repo-lag). Authenticated as `agfpd-owner`; the package is public and
   source-distributed — it ships `bin/ src/ docs/*.md docs/ru/ tsconfig.json` per the
   `files` field (NOT `docs/internals/`: a directory listed in `files` overrides
   `.gitignore`/`.npmignore`, so the allowlist uses precise paths to exclude it), not
   the 63 MB compiled bin. Confirm with `npm view @agfpd/telegram-runtime version`. The version also
   travels into the runtime manifest (package.json → `VERSION` → `buildManifest`),
   so `iapeer status` and the update-runtime version-gate can observe what is
   deployed.
2. DEPLOY: activate a release with `iapeer update-runtime telegram` — it
   version-gates installed vs npm-latest, re-installs from npm (writing the bin +
   manifest), and restarts the runtime's peers. This is the ONLY release-activation
   path. It blips arthur's bridge fleet-wide and touches the owner's own channel,
   so it is boris' admin zone: hand boris the moment + owner-warning + GO, do not
   run it yourself.

DEV-PROBE ONLY (never a release-activation path): `bun src/cli.ts run` interprets
the working tree, and `bun src/cli.ts self-install` compiles a throwaway local bin
for testing. Using working-tree self-install to ACTIVATE a release bypasses npm and
desyncs the registry — the anti-pattern this section prevents.

Mechanics underneath (and the MANUAL FALLBACK if update-runtime is unavailable).
The runtime is a long-lived launchd process running the COMPILED single-file Bun
binary `~/.local/bin/telegram-runtime run` — NOT `bun src/cli.ts run`. Since the
tmux→pty migration (verified live 2026-06-14) the chain is: `com.iapeer.<peer>`
(launchd) → `iapeer run-infra <peer> telegram` → `iapeer supervisor daemon
telegram-<peer> telegram` (pty-host) → `telegram-runtime run`; there is NO tmux
session anymore. To deploy manually: `bun src/cli.ts self-install` (atomic bin
replace; the running process keeps its old inode, so this alone is blip-free), then
restart with `iapeer stop <peer> && iapeer start <peer>` — boris' admin zone, ~6-10s
fleet-wide blip. Do NOT use `launchctl kickstart`: the pty supervisor is detached
and survives the run-infra restart, so an idempotent run-infra re-adopts the OLD
child and silently redeploys nothing (same trap the old tmux session had; confirmed
against iapeer's foundation code 2026-06-14). `iapeer stop`=`launchctl bootout`
(host-aware teardown kills the detached supervisor+child); `iapeer start`=`launchctl
bootstrap` (fresh supervisor+child on the new bin) — which also subsumes the old
LWCR-needs-update trap. Confirm any deploy by process start vs bin mtime
(`ps -o pid,lstart -p $(pgrep -f "telegram-runtime run")` postdates
`ls -la ~/.local/bin/telegram-runtime`) and a NEW child PID. "Committed" ≠ "built" ≠
"published" ≠ "running". `<peer>` is the HUMAN peer served (here `arthur`), not your
own implementer session; ONE process polls ALL bots, so the restart blips the whole
fleet.

## Architectural anchors

- Identity ABI: `PEER_PERSONALITY` / `PEER_RUNTIME` / `PEER_IDENTITY`.
- Outbound timeout scope: `AbortSignal.timeout` is scoped to outbound sends
  only — NEVER global in `runtimeFetch`, or it breaks long-polling `getUpdates`
  (which legitimately hangs ~30s).
- STT env: `TELEGRAM_STT_ENDPOINT` / `TELEGRAM_STT_MODEL` /
  `TELEGRAM_STT_LANGUAGE` / `TELEGRAM_STT_FALLBACK_MODEL` (set in the peer's
  `launch.env`, not hardcoded).
- Agent-activity occupancy source = pane-log mtime, NOT tmux. The typing indicator
  and the tool-call activity stream both key off whether the TARGET peer is busy;
  since the pty migration that signal is `statSync` mtime of iapeer's supervisor
  pane-log `~/.iapeer/logs/lifecycle/<runtime>-<personality>.log` (busy =
  age < `PANELOG_BUSY_MS`, default 4 s) — see `paneLogAgeMs`. This path/format is a
  LOAD-BEARING contract owned by iapeer's pty supervisor; coordinate with iapeer
  before depending on any change to it. Tool-call gestures still come from the
  peer's native JSONL transcript (hosting-independent) — the mtime source only
  gates the turn lifecycle, it does not carry gesture content.

## Open work (current)

- Outbound observability EXISTS: structured JSON events (`envelope.*`,
  `chunk.*`, `rich.*`) in `~/.iapeer/logs/<peer>/telegram-<peer>.log` /
  stderr — see `logOutbound`. Disable with `TELEGRAM_OUTBOUND_LOG=0`.
- Rich messages (Bot API 10.1) adopted in v0.14.0: peer envelopes go out
  rich-first (`rich_message.markdown`, server-side GFM parsing, 32768-char
  limit replaces 4096 chunking); ANY rich failure falls back to the legacy
  chunked MarkdownV2→plain path. Kill switch: `TELEGRAM_RICH=0`. grammy has
  no 10.1 typings yet — the call rides `bot.api.raw` (name-keyed Proxy);
  when grammy ships them, drop the cast in `sendRichResilient`.
- After the soak: remove the transitional `interfaces.telegram.aliases`
  fallback + `TelegramInterface.aliases` in a dedicated release.

## Плагины Claude Code / MCP — факты (кратко)
- Плагин ставить только `--scope project`. Запись `enabledPlugins:true` в settings.json ≠ установка — без `claude plugin install --scope project` plugin-MCP не поднимается при старте.
- После релиза плагина — `/reload-plugins` (для npx-MCP может понадобиться свежий процесс/респавн, не только reload).
- Статус MCP проверять прямым `/mcp` (raw connected/failed) + реальным вызовом инструмента; не косвенной пробой через модель.
- macOS `/bin/bash` = 3.2: `case` в `$(…)` не парсится → использовать `[[ == glob ]]`; синтаксис проверять `/bin/bash -n` на СГЕНЕРИРОВАННОМ файле, не на источнике.
