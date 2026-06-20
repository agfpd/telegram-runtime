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
| `doctor [--json]` | Chain check: profile, person's account, bot configuration and bindings, no bots without an agent. |

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
