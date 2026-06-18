# 07 — Configuration

[Русский](ru/07-конфигурация.md) · **English**

telegram-runtime works out of the box with no configuration. Everything below is optional — environment variables that enable voice transcription, route through a proxy, or tune behavior. Set them in the bridge's launch environment.

## Voice transcription (STT)

Without an STT service, a voice message arrives at the agent as a file. To have it transcribed to text, point the bridge at an OpenAI-compatible transcription endpoint (for example a local `speaches` or `faster-whisper-server`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `TELEGRAM_STT_ENDPOINT` | — | base URL of an OpenAI-compatible `/v1/audio/transcriptions` service; empty disables the primary path |
| `TELEGRAM_STT_MODEL` | endpoint default | model name sent to the endpoint |
| `TELEGRAM_STT_LANGUAGE` | auto-detect | language hint (ISO-639-1: `en`, `ru`, …) |
| `TELEGRAM_STT_PROMPT` | — | optional decoder priming prompt |
| `TELEGRAM_STT_TIMEOUT_MS` | 30000 | timeout for the endpoint request |

A local fallback runs if the endpoint fails or isn't set:

| Variable | Default | Meaning |
|----------|---------|---------|
| `TELEGRAM_STT_FALLBACK_CMD` | `mlx_whisper` | local transcription command; set empty to disable |
| `TELEGRAM_STT_FALLBACK_MODEL` | command default | model flag for the fallback command |
| `TELEGRAM_STT_KEEP_FILE` | off | `1` attaches the raw audio file alongside the transcript |

If both the endpoint and the fallback fail, the voice arrives as a file. A transcript is delivered marked as speech.

## Indicators and rich text

All three are on by default; set the variable to `0` to turn one off:

| Variable | Default | Meaning |
|----------|---------|---------|
| `TELEGRAM_TYPING` | on | the typing indicator while the agent works |
| `TELEGRAM_ACTIVITY` | on | the activity stream, host-wide master switch (per-peer toggle is `/activity` in chat) |
| `TELEGRAM_ACTIVITY_DEFAULT` | on | the activity default for a peer that hasn't set it |
| `TELEGRAM_RICH` | on | rich-formatted messages (server-side markdown) |

## Proxy

If Telegram's API needs a proxy, the bridge honors the first of these that is set:

```
TELEGRAM_RUNTIME_PROXY  →  CLAUDE_TG_PROXY  →  HTTPS_PROXY  →  HTTP_PROXY
```

## Fine-tuning

You rarely need these — the defaults are tuned. They're listed so the behavior isn't a mystery.

| Variable | Default | Meaning |
|----------|---------|---------|
| `TELEGRAM_TYPING_POLL_MS` | 3000 | how often the agent's busy/idle state is polled |
| `TELEGRAM_TYPING_MIN_MS` | 5000 | minimum time the typing indicator stays up |
| `TELEGRAM_TYPING_CAP_MS` | 1800000 | hard cap on the typing indicator (30 min) |
| `TELEGRAM_PANELOG_BUSY_MS` | 4000 | activity-log age under which the agent counts as busy |
| `TELEGRAM_ACTIVITY_POLL_MS` | 500 | how often the transcript is read for new steps |
| `TELEGRAM_ACTIVITY_EDIT_MS` | 1000 | throttle on editing the activity message |
| `TELEGRAM_ACTIVITY_MAX_STEPS` | 30 | how many recent steps the stream shows |
| `TELEGRAM_OUTBOUND_TIMEOUT_MS` | 30000 | timeout for one send to Telegram |
| `TELEGRAM_OUTBOUND_RETRIES` | 2 | retries on a failed outbound send |
| `TELEGRAM_IAP_SEND_TIMEOUT_MS` | 60000 | timeout for delivering one inbound message to a peer |
| `TELEGRAM_NEW_TIMEOUT_MS` | 300000 | timeout for the `/new` command (5 min) |
| `TELEGRAM_COMPACT_TIMEOUT_MS` | 300000 | timeout for the `/compact` command (5 min) |

## What iapeer sets

These come from the launch environment iapeer provides; you don't set them by hand.

| Variable | Default | Meaning |
|----------|---------|---------|
| `IAPEER_ROOT` | `~/.iapeer` | the iapeer state root (bot store, manifest, logs) |
| `TELEGRAM_RUNTIME_IAPEER_BIN` | resolved | path to the `iapeer` binary for control commands |
| `IAP_BIN` | `iapeer` | the binary used to deliver messages to peers |

## Fixed values

These are compiled in, not configurable: a message is chunked at 4096 characters (32768 for rich messages), an attachment is capped at 50 MB, and voice files (`.ogg`/`.oga`) are sent as Telegram voice messages.
