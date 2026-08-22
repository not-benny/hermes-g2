# Fixed-build independent review - Even G2 CFW 2.2.8.4

> **Historical static review.** A later owner report records one boot of the
> pinned candidate. It does not establish reproducibility, recovery, or broad
> compatibility; flashing/recovery experiments remain NO-GO without separate
> authorization and sacrificial recovery evidence.

**Review date:** 2026-08-18
**Candidate:** `firmware/g2_2.2.8.4_cfw_FIXED.bin`
**SHA-256:** `bf143aa220d634969fc7ea856716bfccd6cf197fe93f41bec2b87ebd8add7584`

## Verdict

**Static code and artifact review: PASS.**

**Hardware release/flash decision: NO-GO - DO NOT FLASH.**

The final adversarial review found no remaining concrete static memory-safety or
deadlock blocker in the reviewed source. This does not prove runtime safety: the
candidate has never booted on the glasses, and the RTOS hook context, display
handoff, OTA acceptance, both-lens behavior, watchdog behavior, and recovery
path remain unverified.

## Review history

The review was iterative and fail-closed. Candidate revisions were rejected
until all concrete static lifecycle findings were addressed, including:

- FIFO publication and eviction races permitting stale-pointer use, UAF, and
  double-free;
- truncated BMP out-of-bounds reads and signed-height overflow;
- unaligned zlib-stream typed access;
- settings append capacity risk;
- timer, buzzer, wake fallback, and launch-state races;
- settings-hook ambiguity;
- pending-direct ownership cleared without display quiescence;
- malformed/unknown inputs reaching the BMP loader without the display gate;
- container teardown re-registering a dead owner;
- teardown without a durable tombstone for previously unregistered containers;
- foreign tombstones being recycled before teardown finished;
- an unlocked `image_worker` fallback when context creation failed.

The final source uses generation-qualified owners, durable same-pointer
tombstones, RTOS mutexes for snapshot/worker/timer domains, explicit display
semaphore ownership, full slot clearing, fail-closed leak behavior when safe
quiescence cannot be established, and exactly one `image_worker` call site under
`worker_mutex`.

## Final verification evidence

The final package check reported:

- byte-exact rebuild match for
  `bf143aa220d634969fc7ea856716bfccd6cf197fe93f41bec2b87ebd8add7584`;
- both SHA-256 manifests valid;
- 18 exact injected branch targets;
- 100 changed stock-prefix bytes, all confined to declared operations;
- one 18,359-byte injected blob (17,138 text + 1,221 rodata);
- component CRC32C and main-app preamble CRC valid;
- clean source-generator execution;
- optimized-mode verifier remains fail-closed.

The package-wide manifest covers every delivered file except itself. The build
and verifier are self-contained around the pinned upstream helpers and pinned
Capstone dependency.

## Remaining mandatory hardware gates

Before the Android app's installation gate can be enabled:

1. demonstrate a stock recovery path on recoverable hardware;
2. trace every injected hook's task/ISR context;
3. validate semaphore ownership and queue handoff on both lenses;
4. exercise timer callback stop/start behavior;
5. prove OTA acceptance, boot, watchdog stability, and repeated restore;
6. stress rapid snapshot/container/BMP/direct-frame transitions;
7. test interruption and power-loss recovery.

No runtime-success or recovery percentage is assigned.

## Related files

- `../REPORT.md` - current reproducible-build report and hardware gates.
- `PEER-REVIEW.md` - original review of the superseded unsafe artifact.
- `citation-ledger.json` - external-source evidence ledger used by the original
  review and current report.
