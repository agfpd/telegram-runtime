# Isolated live polling acceptance

```sh
bun scripts/verify-polling-recovery.ts --mode after --output /absolute/new-proof.jsonl
```

Requires Bun; uses the packaged grammY dependency. No credentials, host state,
Telegram API, IAP daemon, network configuration changes or lifecycle commands.
It starts a local HTTP Bot API fixture and a real grammY poller using production
polling-supervisor functions. It delivers a pre-outage message, hangs an actual
`getUpdates` request for the default 45 s deadline, rejects the final offset
confirmation and the replacement's bootstrap with HTTP 503, then restores the
fixture. Outbound remains usable. An injected message crosses HTTP getUpdates,
grammY middleware and a separate HTTP inbound sink; heartbeat and delivery prove
automatic recovery. The proof is socket-level isolation, NOT a real Telegram
user message or the complete production CLI/IAP/STT/approval pipeline.

Compare against the original implementation, with the same fixture/protocol:

```sh
git show f1df693:src/pollingSupervisor.ts > /tmp/polling-before.ts
bun scripts/verify-polling-recovery.ts --mode before \
  --supervisor /tmp/polling-before.ts --output /absolute/new-before-proof.jsonl
```

The before run takes ~145 s. After restoration, it first proves no progress for
30 s despite successful outbound, then records actual recovery after ~100 s.
No timers are accelerated: in grammY 1.44.0 `withRetries` passes its millisecond
backoff (100, 200, 400, …) to `sleep(seconds)`. A longer outage grows that blind
interval to hours and eventually ~13.9 days. This is not proof of a literally
permanent hang; the overnight incident's exact sleeping stack was lost when
the operator restarted the process. Its logs prove the pre-poll blind spot,
while source inspection and this reproduction identify a sufficient mechanism.

Expected after evidence: `poll.stalled` → `poll.stop.error` (`stopOk=false` on
`poll.restart`) → `poll.bootstrap.error`/`poll.failed` with bounded retry delay →
`poll.start` → `poll.heartbeat` and `inbound.ok` for `after`, without a process
restart. `probe.recovered.recoveryMs` is measured from fixture restoration.
The default after run takes ~48 s. Evidence output must not already exist.

Since 0.28.10 all replacement paths back off (including stalls); this adds the
supervisor's jittered delay to recovery time. `poll.start` does not reset this
delay. Only at least three valid polls spanning 120 seconds without errors do.

Flapping acceptance against a real local HTTP fixture, without Telegram tokens:

```sh
git show 6ee6374:src/pollingSupervisor.ts > /tmp/polling-before-backoff.ts
bun scripts/verify-polling-backoff.ts --supervisor /tmp/polling-before-backoff.ts --output /tmp/backoff-before.jsonl
bun scripts/verify-polling-backoff.ts --output /tmp/backoff-after.jsonl
```

Both runs fence three hanging generations, then stop at the fourth startup.
Before: no delay between fencing and the next boot. After: `poll.degraded` states
the failure streak and actual retry delay (4–5, 8–10, 16–20 seconds). Production
delays keep growing to a 48–60 second cap. The fixture uses a 100 ms stall
deadline to avoid spending 135 seconds reproducing the already-tested timeout;
retry delays are real, not accelerated. Neither run proves healthy host networking.

Unit tests additionally exercise bootstrap transport errors and body hangs,
startup-watchdog/fatal fencing, unexpected clean exits and API-error isolation.
