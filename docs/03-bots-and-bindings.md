# 03 — Bots and bindings

[Русский](ru/03-боты-и-привязки.md) · **English**

## Bots

Each agent talks through its own Telegram bot. Bots are registered in the bridge under a short key and stored in the runtime directory (the token and the bot's real name live in its own settings file, plus a lock file so exactly one process holds the bot).

```bash
iapeer connect telegram <agent> --token <token>   # the usual path: bot + binding in one go
```

If you need to manage bots directly, the runtime has its own commands:

```bash
telegram-runtime bot add <key> --token <token> [--username <fallback-name>]   # register a bot
telegram-runtime bot list [--json]                 # show all bots
telegram-runtime bot remove <key>                  # remove a bot
```

On add, the bridge **checks the token with Telegram** and takes the bot's real name (`@username`) from there — the source of truth is Telegram, not what the operator typed. If there's no network, you can set the name by hand with the fallback flag. Remove deletes the bot entirely.

## Bindings

The bridge keeps no separate link database — it derives bindings from peer profiles:

- a **person** carries their Telegram identifier (`user_id`) in their profile — which account to message;
- an **agent** carries a bot binding (`bot`) — which bot is used to talk to it, with the bot's real name alongside.

Two commands write these fields (`iapeer connect telegram` calls them for you):

```bash
telegram-runtime interface human --user-id <id>          # set the person's Telegram account
telegram-runtime interface bot <key> --peer <agent>      # bind a bot to an agent
```

The commands edit the profile carefully: they write only their own binding fields, leaving the rest of the profile (name, description, nature, other plugins' config) untouched.

## Multiple bots under one process

Different agents have different bots, but **one process** of the bridge polls them all. Each bot is held by exactly one process (via a lock file): if the process restarts, the lock passes to the new one and a dead lock is cleared. So multiple bots run in parallel without interfering or duplicating.

## Integrity check

```bash
telegram-runtime doctor
```

Checks that the profile is in place, the person's Telegram identifier is set, every bot is configured and bound to an agent, and no bots are without an agent. A quick way to confirm the bindings are consistent.
