# 04 — Features

[Русский](ru/04-возможности.md) · **English**

On top of plain text delivery, the bridge makes talking to an agent from Telegram feel alive.

## Voice

A voice message from the person is **transcribed to text** (through a speech-recognition service) and delivered to the agent as an ordinary message, marked as having been speech. If transcription isn't available, the file itself goes to the agent. The other way: when the agent sends a voice file, the bridge delivers it to the chat as a voice message with a player.

Speech recognition is wired up with the address of an external service; without it, voice arrives as a file. There's also a local fallback transcriber. See [07 — Configuration](07-configuration.md).

## Typing indicator

While the agent works on a reply, the chat shows a typing indicator — as in a conversation with a person. The bridge watches the agent's session and shows the indicator while it's busy, clearing it when the agent is done. So you can see the request was received and is being processed, not lost.

## Activity stream

Optionally the bridge shows what the agent is doing right now — which tools it's using, what step it's on. It's toggled straight from the chat with `/activity` (`on` / `off` / `status`). It's on by default; turn it off if you don't want it.

## Control commands from the chat

You can manage the agent's session straight from Telegram:

- **`/stop`** (or the word "стоп"/"stop") — interrupt the agent's current turn without losing context;
- **`/new`** — restart the agent with a fresh session;
- **`/compact`** — compact the conversation context.

The bridge intercepts these commands and executes them through iapeer, without delivering them to the agent as text. They're also published as the bot's **command menu** in Telegram (the `/` list), so they're discoverable without memorizing them — the menu is re-synced when the agent's profile changes, no restart needed.

## Runtime switch

An agent can be declared on more than one runtime (Claude and Codex). When it is, the bridge offers a switch straight from the chat: `/claude` or `/codex` moves that agent onto the named runtime for its next turns. The option appears only when the agent actually declares two or more runtimes — otherwise there's nothing to switch to.

## Alias shortcuts

Beyond the control commands, the owner can set up **aliases** — short shortcuts that expand into preset text before delivery to the agent. For example `/alias-new` might expand to "Save your state to memory and restart fresh." Aliases are set in the peer profile and re-read on every message, so editing an alias takes effect at once, with no restart.

## Attachments

Files and images travel both ways. Inbound from the person (photos, documents, audio, video) the bridge downloads and passes to the agent; outbound from the agent it sends to the chat, picking the type by extension — a voice message, an audio track, an image, or a document. The size limit is 50 MB per file.

## Text formatting

The agent's replies arrive formatted — headings, lists, code, links render as they should in Telegram. The agent writes plain markdown; the bridge converts it to what Telegram displays correctly, splitting long messages into parts when needed.

## Human approval

A peer can run in `gated` mode (iapeer's `approval-mode`): instead of acting autonomously, its blocking approval requests — a dangerous command, a file edit, a plan — are routed to a human before they run. The bridge is the Telegram face of the daemon's approval broker.

Each pending request arrives as a **card** showing the exact action content (the full command, the diff, the plan text) with **Allow** and **Deny** buttons. Only the owner can resolve it. A tap posts the decision back to the broker: Allow lets the tool proceed, Deny blocks it with a reason delivered to the model. The card is then edited in place to show the outcome — and because the broker is one shared queue, a resolution from any channel (the button, `iapeer approve` on the CLI, the tray) resolves the request everywhere.

A **faced** peer (one with its own bot) gets its card in its own dialog with the owner. **Faceless** peers (Implementers, infra — no bot of their own) share one approval bot, provisioned with `onboard-approval`; if the owner declines it, their approvals surface only on the host bar and CLI. The whole feature is inert unless the daemon advertises the approval broker; a peer left in the default `yolo` mode behaves exactly as before.
