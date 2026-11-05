# 05 — Commands

[Русский](ru/05-команды.md) · **English**

Commands are `telegram-runtime <command>`. Most bindings are easier to set through `iapeer connect telegram`, but the runtime offers direct commands too.

## For the operator

| Command | What it does |
|---|---|
| `bot add <bot-username> --token <token>` | Register a bot: check the token with Telegram (`getMe`), confirm its real `@username` (must match the username you pass), store it under `bots/<username>/`. |
| `bot list [--json]` | Show all bots: `@username`, whether configured. |
| `bot remove <bot-username>` | Remove a bot entirely. |
| `interface human --user-id <id>` | Write the person's Telegram account into the current directory's profile. |
| `interface bot <bot-username> --peer <agent>` | Bind a bot to an agent by its `@username` (write the binding into its profile). |
| `prepare [--user-id <id>]` | Initialize the peer profile in the current directory, optionally setting the Telegram account at once. |
| `doctor [--json]` | Configuration check from the **human peer's working directory**: profile, account, bot tokens and agent bindings. A `role=approval` service bot intentionally needs no agent binding. No network or polling liveness check. |
| `polling --log <runtime-log> [--max-age-ms <ms>] [--json]` | Read-only polling evidence for every configured bot, including bots that never reached `poll.start`. Exits 0 only if all have a fresh heartbeat; see [polling health](06-integration.md#polling-health). |

## Human approval

When a peer runs in `gated` mode (iapeer's `approval-mode`), its blocking approval requests are routed to a human through the daemon's approval broker. The bridge is the Telegram face of that broker: it renders each pending request as a card with **Allow / Deny** buttons and a tap resolves it. See [04 — Features](04-features.md#human-approval).

| Command | What it does |
|---|---|
| `approvals [--json]` | Face-side read of the daemon's pending approval queue (agrees with `iapeer approvals`). Read-only. |
| `notices [--json]` | Face-side read of the daemon's notice board — the peers currently muted by an API error. Read-only by contract: a notice has no resolution. See [04 — Features](04-features.md#mute-peer-notices). |
| `onboard-approval` | Show the offer for the shared approval bot (the single Telegram channel for **faceless** peers — those without their own bot). |
| `onboard-approval --token <token>` | Provision the approval bot from a `@BotFather` token: stores the credential with `role=approval`; faceless peers' cards are delivered there once the bridge restarts. |
| `onboard-approval --decline` / `--decline --yes` | Decline the approval bot. The two touches are a double warning: without it, faceless peers' approvals reach only the host bar (`iapeer approvals`) and CLI, never Telegram. Faced peers are unaffected. |
| `onboard-approval --status` | Whether the approval bot is provisioned, declined, or unset. |

## System

These are invoked by iapeer and launchd, not by the operator directly:

| Command | What it does |
|---|---|
| `run` | The bridge's main process: polls bots, receives inbound, reads outbound envelopes, routes. |
| `self-config` | Per-peer config hook at peer provisioning (invoked by iapeer core with the peer context). |
| `self-install` (run with no arguments, `npx @agfpd/telegram-runtime`) | Package install: binary in place + runtime manifest. |

## Through iapeer

In practice connecting is one core command that itself calls `bot add` + `interface bot` + a bridge restart:

```bash
iapeer connect telegram <agent> --token <token>
```
