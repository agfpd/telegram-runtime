# telegram-runtime

**A Telegram bridge for a team of AI agents — the human-presence runtime of [iapeer](https://github.com/agfpd/iapeer).**

[![CI](https://github.com/agfpd/telegram-runtime/actions/workflows/ci.yml/badge.svg)](https://github.com/agfpd/telegram-runtime/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@agfpd/telegram-runtime)](https://www.npmjs.com/package/@agfpd/telegram-runtime)
[![license](https://img.shields.io/npm/l/@agfpd/telegram-runtime)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS-lightgrey)](#quick-start)

telegram-runtime lets a person live inside an [iapeer](https://github.com/agfpd/iapeer) agent team through Telegram: the owner messages an agent from the messenger and gets replies in the same chat. To the agent, the person is an ordinary peer it messages with `send_to_peer` — the bridge turns that into a Telegram message in the right chat, and turns the person's reply back into an ordinary inbound message. It carries voice, attachments, a typing indicator, an activity stream, and control commands.

> **Built for iapeer.** It isn't a standalone bot framework — it runs only inside [iapeer](https://github.com/agfpd/iapeer), alongside `iapeer-memory` and `notifier-runtime`. It's a presence runtime, the human counterpart to the Claude and Codex agent runtimes, that iapeer provisions and launches and whose messages travel over iapeer's own routing.

## How it works

```text
   person in Telegram                          agent (Claude/Codex)
        │  messages the bot                         │  send_to_peer(arthur, "…")
        ▼                                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │  telegram-runtime — the bridge                             │
   │  inbound:  Telegram → recipient peer (voice → text)        │
   │  outbound: peer → Telegram chat (text, files, voice)       │
   │  typing indicator · activity stream · chat commands        │
   └──────────────────────────────────────────────────────────┘
```

## Quick start

You need a working iapeer install and a Telegram bot token from `@BotFather`.

```bash
npx @agfpd/telegram-runtime                       # install: binary + manifest
iapeer connect telegram <agent> --token <token>   # bind a bot to the agent
# then send the bot its first message from Telegram (a bot can't start a chat)
```

Check the chain:

```bash
telegram-runtime doctor
```

## What makes it different

- **Transparent channel.** Agents get no Telegram tools — to an agent, the person is just a named peer. The same `send_to_peer` reaches a human and an AI alike.
- **Bindings from passports, no separate database.** A person carries their Telegram id, an agent carries its bot binding — both in their peer profiles. The bridge reads them and builds the route.
- **Voice both ways.** Voice in is transcribed to text (with a local fallback); voice out is delivered as a Telegram voice message.
- **Live presence.** A typing indicator while the agent works, and an optional activity stream showing which tools it's using right now.
- **Control from the chat.** `/stop`, `/new`, `/compact`, and operator-defined alias shortcuts — intercepted and run through iapeer, never delivered to the agent as text.
- **Multiple bots, one process.** Each agent has its own bot; the bridge polls them all in a single process, one lock per bot.

## Documentation

[`docs/`](docs/README.md) — what it is and how to use it (English; Russian in [`docs/ru/`](docs/ru/README.md)). This repository is the implementation.

## License

Apache-2.0. Platform: macOS. telegram-runtime is the human-presence runtime for the [iapeer](https://github.com/agfpd/iapeer) ecosystem — a component of iapeer, not a standalone system.
