# telegram-runtime

[Русский](ru/README.md) · **English**

telegram-runtime is a bridge between Telegram and a team of [iapeer](https://github.com/agfpd/iapeer) agents. It gives a person presence in the system through Telegram: the owner messages an agent from the messenger and gets replies in the same chat. To the agent, the person is an ordinary peer it messages with `send_to_peer`; the bridge turns that into a message in the right Telegram chat and back.

```text
   person in Telegram                          agent (Claude/Codex)
        │  messages the bot                         │  send_to_peer(arthur, "…")
        ▼                                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │  telegram-runtime — the bridge                             │
   │  inbound:  Telegram → recipient peer                       │
   │  outbound: peer → Telegram chat                            │
   │  voice · typing indicator · attachments · commands         │
   └──────────────────────────────────────────────────────────┘
```

It's an iapeer runtime: the human counterpart to the Claude and Codex agent runtimes. Agents get no Telegram tools — the channel is transparent to them, they just message a peer by name.

## What it does

- **Two-way exchange** — a person's message reaches the recipient peer; the peer's replies go to its Telegram chat.
- **Voice both ways** — voice in is transcribed to text (with a local fallback); voice out is delivered as a Telegram voice message.
- **Typing indicator** — while the agent works on a reply, the chat shows a typing indicator.
- **Activity stream** — an optional stream showing which tools the agent is using right now.
- **Attachments** — files and images travel both ways.
- **Control from the chat** — `/stop`, `/new`, `/compact`, and alias shortcuts, run through iapeer and never delivered to the agent as text.
- **Multiple bots, one process** — each agent has its own bot; the bridge polls them all in a single process.

## Quick start

You need a working [iapeer](https://github.com/agfpd/iapeer) install.

```bash
npx @agfpd/telegram-runtime                       # install the package
iapeer connect telegram <agent> --token <token>   # bind a bot to the agent
# then — send the bot its first message from Telegram (a bot cannot start a chat)
```

Details in [02 — Quick start](02-quickstart.md).

## Documentation

- [01 — Overview](01-overview.md) — what the bridge is and how the model works
- [02 — Quick start](02-quickstart.md) — install, bot, binding, first message
- [03 — Bots and bindings](03-bots-and-bindings.md) — managing bots, who's bound to whom
- [04 — Features](04-features.md) — voice, indicator, activity, commands, attachments
- [05 — Commands](05-commands.md) — CLI reference
- [06 — Integration and install](06-integration.md) — place in iapeer, install, dependencies
- [07 — Configuration](07-configuration.md) — environment variables: voice (STT), indicators, proxy

## Status

Published to npm — [`@agfpd/telegram-runtime`](https://www.npmjs.com/package/@agfpd/telegram-runtime). Working: Telegram polling, two-way delivery, voice transcription, typing indicator, activity stream, attachments, control commands, multiple bots under one process. Platform: macOS, like iapeer.
