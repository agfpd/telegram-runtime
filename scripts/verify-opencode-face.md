# Isolated native OpenCode face proof

Prerequisites: macOS, Bun, an iapeer source checkout with dependencies, native
OpenCode and an OpenCode config directory with its installed plugin dependencies.
Only `node_modules`, `package.json` and Bun lockfiles are copied from that seed;
provider configuration and authentication are not copied. Core schema 1 is the
consumer contract (`iapeer` docs/20).

```sh
bun scripts/verify-opencode-face.ts \
  --core /absolute/iapeer-checkout \
  --opencode /absolute/native/opencode \
  --seed /absolute/config/opencode \
  --output /absolute/new-evidence-directory
```

The probe runs its own daemon and registered peer in a disposable root, with
an allowlisted environment and the core's sandbox guard. A loopback scripted
provider drives the **real native OpenCode** bash tool and a non-retryable HTTP
401. The actual core broker, journal producer and mute watch feed real Fleet
HTTP/SSE into Telegram's `FleetFace` and card renderers. Allow/deny decisions
round-trip from rendered keyboard data through Telegram's Fleet HTTP client;
timeout is the broker's real default-deny. No journal lines or notices are
fabricated. Approval/notice feature independence and replay dedup are checked.

Evidence includes captured HTML/keyboards, provider requests, the native journal,
state, core logs, face logs, versions/hashes and checks. The root/process is
removed after the behavioral run, including failures; evidence is retained.
Production runtime binary/manifest bytes and metadata, and channel process
identities, must be unchanged. Core start/end SHAs identify concurrent checkout
changes; this is source-core proof, not installed-core acceptance.

This deliberately does **not** prove real Telegram API delivery, owner callback
authorization, chat UI/typing, polling, STT, cloud-model behavior or production
activation. Those require a separate authorized live window. The probe contains
no host install, restart or launchd activation command.
