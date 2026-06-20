# 01 — Overview

[Русский](ru/01-обзор.md) · **English**

telegram-runtime gives a person presence in a team of agents through Telegram. It's a presence runtime for a human peer — alongside the Claude and Codex agent runtimes, only for a person rather than an AI. The owner messages an agent from the messenger, and the agent replies in the same place.

## To the agent, the person is an ordinary peer

The key idea: the agent doesn't work with Telegram directly and gets no Telegram tools. To it, the person is an ordinary named peer it messages with the same `send_to_peer`:

```
send_to_peer(arthur, "…")
```

The bridge takes that message and sends it through the right Telegram bot into the right chat. The other way is the same: a person's message in Telegram is delivered to the recipient peer as an ordinary inbound message. The channel is transparent to the agent.

## Bindings are derived from passports

The bridge keeps no separate "who's bound to whom" database — every binding is derived from peer profiles (their passports):

- a **person** carries their Telegram identifier in their profile (`interfaces.telegram.user_id`) — so the bridge knows which account to message;
- an **agent** carries a bot binding (`interfaces.telegram.bot_username`) — the bot's `@username`, which bot is used to talk to it.

So there's one source of truth: the peer profiles; the bridge only reads them and builds the route. Connecting a bot to an agent writes these fields — no separate sync needed.

## How a message travels

**Person → agent.** The person messages the bot in Telegram. The bridge takes the message, works out who it's from (by Telegram account) and who it's for (by bot), transcribes voice and expands commands if needed, and delivers it to the recipient peer.

**Agent → person.** The agent calls `send_to_peer` on the person's name. The bridge picks up the message, finds the recipient's Telegram account and the sender's bot, and sends it into the chat — as text, with files and voice as the matching type.

## What the bridge adds to plain text exchange

On top of delivering text, the bridge makes the conversation feel alive:

- **voice** — transcribes voice messages from the person to text, sends voice files from the agent;
- **typing indicator** — shows that the agent is working on a reply;
- **activity stream** — optionally shows the owner what the agent is doing right now;
- **control commands** — lets you interrupt, restart, or compact the agent's session from the chat;
- **attachments** — carries files and images both ways.

## Relationship to iapeer

telegram-runtime is a `*-runtime` package of the [iapeer](https://github.com/agfpd/iapeer) ecosystem: a presence runtime that iapeer installs and onboards like any runtime package. So iapeer is a required dependency: the bridge relies on its messaging (delivery to a peer) and its registry (profiles with bindings). Details in [06 — Integration and install](06-integration.md).

## Next

- Install and connect — [02 — Quick start](02-quickstart.md).
- Understand bot management and bindings — [03 — Bots and bindings](03-bots-and-bindings.md).
- Walk through the features (voice, activity, commands) — [04 — Features](04-features.md).
