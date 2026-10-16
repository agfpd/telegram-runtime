# Isolated native installer acceptance (macOS)

The npm archive includes the probe and its runtime dependency tree. Bun and macOS
system tools are prerequisites; no checkout, npm cache, registry, core/helper,
Telegram credentials or IAP daemon is needed. The probe uses an allowlisted child
environment and never starts a Telegram poller or executes a lifecycle command.

After checking the delivered archive's SHA-256 against its external receipt:

```sh
mkdir /tmp/telegram-package-proof
tar -xzf /absolute/agfpd-telegram-runtime-0.28.4.tgz -C /tmp/telegram-package-proof
bun /tmp/telegram-package-proof/package/scripts/verify-install.ts \
  --output /absolute/new-evidence-directory --host-home /Users/macmini
```

Use a NEW evidence directory. All mutable installer targets are inside a fresh
temporary sandbox. `--host-home` opts into read-only inspection of the current
host: strict verification and copying of its Telegram binary, manifest and docs,
plus a plist reference if present. The proof never follows the copied manifest's
absolute self-config command back to the host. Backups and hashes remain under
the evidence directory; the transient sandbox is removed even on failure.

The script tests the actual bare and explicit CLI compile/install entry points,
idempotent update, compiled CLI copy-self, unchanged valid signature, repair of an
unsigned native copy, and rejection of a truncated Mach-O by real codesign. A
minimal fresh compile is accepted only if verified and executable, otherwise the
previous pair must remain intact. A real manifest-staging filesystem refusal
must also preserve the previous pair. No runner returns fabricated results.
Finally it stages and strictly verifies the captured current reserve, restores
its exact binary, manifest and documentation bytes/modes in isolation, and runs
the restored binary's `--help`. Host files and channel-process identities are
compared before/after. The original manifest and plist are preserved as reference
bytes; neither descriptor nor launchd job is activated in the sandbox.

Without `--host-home`, the reserve is a candidate-only fixture, suitable for CI;
that mode explicitly does **not** prove restoration of the current host reserve.
Neither mode proves Telegram inbound/outbound, polling heartbeat/recovery, STT,
approval/notice delivery, host restart, external HTTP or the original incident's
root cause. Those require a separately authorized behavioral acceptance window.

The installer stages its manifest before binary publication and retains the old
binary until the manifest rename succeeds. Catchable I/O errors roll back the
binary; a failed rollback reports the retained recovery path. This is not a
power-loss/SIGKILL-atomic transaction across two filesystem paths. No automatic
host activation or restoration is performed by this proof.
