# Changelog

All notable changes to **telegram-runtime** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Granular history begins at the initial public release (0.16.5); earlier work
predates the public repository.

## [Unreleased]

## [0.27.2] - 2026-07-15

### Fixed

- **Notice seeding now keys on the notice's `createdMs` vs this face's start time,
  as iapeer's docs/19 obligation 6 prescribes** — not on "whatever happened to be on
  the board when I first managed to read it". 0.27.1 shipped a hand-rolled
  approximation of a rule the contract had not yet written down; the contract has
  since been written (iapeer e5a625a), so the local guess is replaced by the canon
  mechanism rather than left to drift.
  - The two agree only when the first board read is instant. They DIVERGE exactly
    where it hurts: when the daemon is not yet listening at boot the face backs off
    for seconds or minutes, and a mute raised inside that window is news the owner
    must receive — but a first-read seed buries it as history. Now delivered.
  - Simpler as well as more correct: a stateless timestamp comparison, so the seed
    flag and its "don't burn the seed on a failed read" subtlety are both gone.
    Correct across a daemon restart too — a restarted board re-detects and stamps a
    NEWER `createdMs`, so live conditions are delivered rather than suppressed.
  - The same rule now gates BOTH delivery paths (reconcile and the live SSE raise),
    so no future replay/backfill can sneak history through.
  - Approvals remain un-seeded. Per docs/19 the discriminator is not which surface
    you are but **whether anything is blocked waiting on a human**: a notice blocks
    nothing; an approval holds a peer's tool call against a ≤300 s default-deny.

## [0.27.1] - 2026-07-15

### Fixed

- **A runtime restart no longer re-notifies the owner about mutes he has already
  read.** The notice face's connect-time reconcile treated everything on the board
  as "raised while I was disconnected — tell the owner late rather than never".
  True for a mid-life SSE reconnect; wrong at process start, where the board holds
  notices a PREVIOUS instance already delivered. Caught by the 0.27.0 deploy
  itself: the restart re-sent all five live cards, so the owner was notified by
  OUR deploy about mutes he had read 15 minutes earlier.
  - The first SUCCESSFUL board read now SEEDS the dedup guard silently
    (`notice.face.seeded`); only notices raised while the face is running are sent.
    Gated on success, so a failed first read cannot burn the seed and let the retry
    mistake a pre-existing board for fresh news.
  - Bounded by design: a notice is one-way and nobody waits on it, so staying quiet
    costs at most one TTL — if the peer is still mute the daemon raises a fresh
    notice, and if it recovered there was nothing to say.
  - **Approvals are deliberately NOT seeded**: a request carries a 300 s deadline
    and a blocked human, so a restart must re-render the pending queue. The
    asymmetry is the point, and matches web-runtime's face.

## [0.27.0] - 2026-07-15

### Added

- **Peer-mute notices reach the owner in Telegram** (iapeer docs/19, daemon
  ≥ 0.4.94). An API error — an exhausted model limit, an overload, an expired
  auth — leaves a peer alive, green by every daemon health signal, and unable to
  say a word; nobody inside that session can report it. The daemon now raises a
  `peer-mute` notice and this runtime fans it out to the owner: **who / which
  runtime / which error type / which model / when the wall lifts**.
  - Routed exactly like an approval card, which is the point: a **faceless**
    Implementer has no Telegram dialog of its own, so its muting was reportable
    by nobody. Faced peer → its own bot; faceless → the shared `role=approval`
    service bot.
  - **No buttons.** A notice is one-way information (docs/19 §1): nothing to
    decide, nothing to resolve, no card edit, no lifecycle.
  - **Absent fields are rendered as unstated, never guessed.** claude states no
    reset for a per-model bucket, so the message says *"время сброса
    неизвестно — рантайм его не сообщил"*. The 5h/7d reset in the statusline
    belongs to a DIFFERENT limit and is never substituted (measured live
    15.07.2026: 5h at 11 %, 7d at 66 % while fable was fully exhausted). Same
    for an unstated `model` (always so on codex).
  - `kind` and `errorType` are growth seams: rendered verbatim, never switched
    on exhaustively, so an unknown value still reaches the owner.
  - Repeats do not spam: the daemon folds re-occurrences into one notice with a
    count, rendered `×N`. The face never counts for itself.
  - New `notices [--json]` command — the face-side read of the board, agreeing
    with the daemon. Read-only by contract.
  - Kill switch `TELEGRAM_NOTICES=0`, gated INDEPENDENTLY of `TELEGRAM_APPROVAL`:
    silencing cards must never silence mute reporting. Log switch
    `TELEGRAM_NOTICE_LOG=0`.
  - Inert against a daemon that does not serve the board: `fleet:1` only says the
    Fleet API exists, so each surface is additionally live-probed at start
    (a pre-0.4.94 daemon serves approvals and 404s notices).

### Changed

- `approvalFleet.ts` → **`fleetClient.ts`**, `approvalFace.ts` → **`fleetFace.ts`**
  (`ApprovalFace` → `FleetFace`), via `git mv` so history follows. Both modules
  were always the generic fleet HTTP client and the generic fleet SSE loop —
  approvals were merely their first surface. Notices ride the SAME connection and
  transport rather than a second near-copy of the reconnect/backoff/parse loop,
  which is how a divergent copy starts (the lesson the IAP parser already taught
  this repo). Handlers are now per-surface (`approval` / `notice`), either
  optional. Internal module names; no packaged contract changed.
- The shared-connection log events are renamed `approval.face.{start,stop,
  connected,stream.error}` → **`fleet.face.*`** (they describe one connection
  serving two surfaces, not the approval surface). Surface-specific events keep
  their `approval.*` prefix and notices use `notice.*`.

## [0.26.0] - 2026-07-14

### Fixed
- IAP envelope parser synchronized with the core codec's decoder (iapeer
  `src/codec/index.ts`, envelope-compaction F, 0.4.86) — near-verbatim port, closing two
  inherited defect classes the core had already fixed (В37) plus one latent mine:
  - **В37, open-tag scan is now CDATA-aware** (`readTagContent` replaces `tagContent`): the
    opening `<attachments>`/`<message>` was located with a bare `indexOf`, so a message whose
    CDATA body *quoted* `<attachments>…</attachments>` minted phantom attachments, and an
    attachment path quoting `<message>fake</message>` hijacked the real message body.
    Realistic trigger: a peer forwarding an example envelope to the owner.
  - **Name-anchored attribute lookup** (`attrValue`): the unanchored regex let `runtime="`
    match the tail of `from-runtime="…"` — coincidentally correct today, a mine under
    attribute reordering and under the read-both decode below.
- CDATA-section handling in the tag reader now concatenates adjacent sections (reversing the
  sender's `]]>` split) and treats an unterminated section as raw remainder instead of
  failing the whole tag.

### Added
- **В38 open-tag validation** in `extractIapEnvelopes` (`openTagVerdict` + one-char resync):
  prose that merely contains `<iap ` (e.g. a quoted tool description) no longer swallows the
  next real envelope into an undecodable blob nor parks the stdin buffer forever; a '>'-less
  run is released once it exceeds the 1 KiB open-tag bound, while a genuinely chunk-split
  open tag still waits for the next chunk.
- **Read-both decode** (`parseIapEnvelope`): accepts the compact presentation names
  (`from`/`runtime`/`intelligence`, `<msg>`) alongside the legacy wire names, short names
  winning — a future wire flip to short names lands as a no-op. The additive `ts` attribute
  is decoded into the new optional `sentAt` envelope field; legacy `from-intelligence`
  values normalize read-compat (`human`→`natural`, `scripted`→`absent`, unknown dropped).
- Adversarial test suite ported from the core's `codec.test.ts` (quoted-tags-in-CDATA,
  attribute-order anchor case, false-start/resync/parking, compact-format decode); each
  case reproduced red on the pre-port parser.

One deliberate divergence from the core codec is kept: the CR→LF fold stays in
`parseIapEnvelope` — the core moved it out as a transport concern, and this parser IS the
telegram transport adapter (raw pty stdin surfaces bare CRs).

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
