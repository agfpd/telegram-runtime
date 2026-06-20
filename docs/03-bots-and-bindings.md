# 03 — Bots and bindings

[Русский](ru/03-боты-и-привязки.md) · **English**

## Bots

Each agent talks through its own Telegram bot. A bot is identified by its **`@username`** — its real, globally-unique name in Telegram (for example `@mybot`). The bridge stores each bot's credentials in the runtime directory keyed by that username (`bots/<username>/`): the token, plus a lock file so exactly one process holds the bot. The `@username` is a natural key — it's unique across Telegram and can't be changed on an existing bot, so the binding never goes stale.

```bash
iapeer connect telegram <agent> --token <token>   # the usual path: bot + binding in one go
```

If you need to manage bots directly, the runtime has its own commands:

```bash
telegram-runtime bot add <bot-username> --token <token>   # register a bot
telegram-runtime bot list [--json]                        # show all bots
telegram-runtime bot remove <bot-username>                # remove a bot
```

On add, the bridge **checks the token with Telegram** (`getMe`) and confirms the bot's real `@username` — the source of truth is Telegram, not what the operator typed. The username you pass must match the bot the token belongs to; a mismatch is refused (naming a credential after the wrong bot would mis-route). With no network the username you pass is trusted as-is. Remove deletes the bot entirely.

## Bindings

The bridge keeps no separate link database — it derives bindings from peer profiles:

- a **person** carries their Telegram identifier (`user_id`) in their profile — which account to message;
- an **agent** carries a bot binding (`bot_username`) — the `@username` of the bot used to talk to it.

Two commands write these fields (`iapeer connect telegram` calls them for you):

```bash
telegram-runtime interface human --user-id <id>                 # set the person's Telegram account
telegram-runtime interface bot <bot-username> --peer <agent>    # bind a bot to an agent
```

The commands edit the profile carefully: they write only their own binding fields, leaving the rest of the profile (name, description, nature, other plugins' config) untouched.

## Multiple bots under one process

Different agents have different bots, but **one process** of the bridge polls them all. Each bot is held by exactly one process (via a lock file): if the process restarts, the lock passes to the new one and a dead lock is cleared. So multiple bots run in parallel without interfering or duplicating.

## Integrity check

```bash
telegram-runtime doctor
```

Checks that the profile is in place, the person's Telegram identifier is set, every bot is configured and bound to an agent, and no bots are without an agent. A quick way to confirm the bindings are consistent.
