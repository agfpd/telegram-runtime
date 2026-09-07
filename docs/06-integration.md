# 06 — Integration and install

[Русский](ru/06-интеграция.md) · **English**

## Place in iapeer

telegram-runtime is a `*-runtime` package of the [iapeer](https://github.com/agfpd/iapeer) ecosystem: a presence runtime for human peers, alongside the Claude and Codex agent runtimes. iapeer installs and onboards it like any runtime package.

The package registers itself with a runtime manifest (`runtime.json`), by which iapeer knows how to launch and configure it. The telegram runtime has **no pre-declared set of peers** — it's "operator-add" mode: people are added one at a time with `iapeer create <name> --runtime telegram`, unlike runtimes with a fixed set (the scheduler, for example).

## Install and update

```bash
npx @agfpd/telegram-runtime       # install (binary + manifest)
iapeer install-runtime telegram   # the same through iapeer
iapeer update-runtime telegram    # update, restarting the runtime's peers
```

Install is idempotent: it places the binary and writes the manifest atomically. When provisioning each peer, iapeer invokes the runtime's config hook (`self-config`), which writes the peer's Telegram bindings and, if any, the bot credentials.

## How the bridge fits into messaging

The bridge sits at the seam between two worlds:

- on the **Telegram** side it polls bots and sends them messages;
- on the **iapeer** side it receives outbound from peers (as messages to deliver) and delivers inbound to the recipient peer through iapeer.

So it doesn't route on its own — routing between peers is done by the iapeer daemon; the bridge only translates between Telegram and the iapeer protocol. Control commands from the chat it executes through iapeer's control commands: `/stop` via `iapeer interrupt` (interrupt the turn), `/new` and `/compact` via the same-named commands.

## Polling health and monitor contract

Process health and outbound delivery do not prove that inbound long polling is
advancing. The bridge therefore supervises every bot separately. A completed
`getUpdates` response is buffered inside a hard deadline (including its body),
and an over-deadline request causes only that bot's grammY generation to be
stopped and replaced. Other bot pollers and outbound delivery remain live.

Structured stderr lines start with `telegram-runtime polling `. Monitor the
JSON payload by `botKey` and `generation`:

| Event | Meaning |
|---|---|
| `poll.start` | a bot generation entered long polling |
| `poll.heartbeat` | healthy completed cycles; `emptyCycles` explicitly counts ordinary no-message long polls, while `updates` counts returned updates |
| `poll.error` | a non-stall transport failure (rate-limited to one line/minute per generation) |
| `poll.stalled` | one `getUpdates` exceeded `deadlineMs`; alert-worthy and followed by self-healing |
| `poll.restart` | the stalled generation was fenced and the next generation will start |
| `poll.failed` | a generation exited with an error and will be retried with backoff |

A monitor should alert immediately on `poll.stalled`, and require the matching
`poll.restart` followed by `poll.start` for the same `botKey`. It should also
alert if a started bot has no `poll.heartbeat` for longer than the configured
heartbeat interval plus the stall deadline. Lack of inbound user messages is
not a health signal: an idle bot reports healthy `emptyCycles`.

## Dependencies

| Dependency | Required | Without it |
|---|---|---|
| iapeer | required | the bridge doesn't run: nowhere to deliver inbound, nowhere to take outbound and bindings from |
| a Telegram bot (token from `@BotFather`) | required | no Telegram channel |
| a speech-recognition service | optional | voice arrives as a file, without transcription to text |

## Out of scope

The bridge deliberately doesn't: work through webhooks (polling only), edit or delete sent messages, serve group chats or store conversation history, or join several hosts. It's a "person ↔ their agent team" bridge on one host, not a platform for Telegram bots in general.
