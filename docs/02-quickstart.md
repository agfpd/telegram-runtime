# 02 — Quick start

[Русский](ru/02-быстрый-старт.md) · **English**

From install to the first message. Under each step, what it does.

## Requirements

- **macOS** and a working [iapeer](https://github.com/agfpd/iapeer) install. The bridge relies on iapeer's messaging and peer registry — without iapeer it doesn't run.
- **A Telegram bot** — a token from `@BotFather` (free, takes a minute to create inside Telegram).

## Install the package

```bash
npx @agfpd/telegram-runtime
```

Install places the `telegram-runtime` binary and writes the runtime manifest, by which iapeer knows about it. `iapeer install-runtime telegram` does the same. Install is idempotent.

## A person's presence

For a person to be present in Telegram, they need a human peer with a Telegram identifier set. Usually iapeer's onboarding creates it (`iapeer onboard` sets up the owner peer in Telegram). To add a person separately:

```bash
iapeer create <person-name> --runtime telegram
```

Unlike agents, the telegram runtime has no pre-declared set of peers — the operator adds people one at a time.

## Connect a bot to an agent

```bash
iapeer connect telegram <agent> --token <bot-token>
```

One command does everything: it registers the bot (checking the token with Telegram and taking its real name), writes the bot binding into the agent's profile, and restarts the bridge so it picks up the new bot. All you supply is the token.

## First message

After connecting, **send the bot its first message from Telegram**. This is required: by Telegram's rules a bot can't message a person first — the person must start the chat. After the first inbound message the channel comes alive, and from then on it flows both ways.

## Check

```bash
telegram-runtime doctor
```

The command checks the chain: the profile is in place, the Telegram identifier is set, every bot is configured and bound, and no bots are orphaned without an agent. Add `--json` for machine-readable output.

## Next

- Bot and binding management — [03 — Bots and bindings](03-bots-and-bindings.md).
- Voice, indicator, activity, chat commands — [04 — Features](04-features.md).
