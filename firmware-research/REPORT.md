# Even Realities G2 CFW 2.2.8.4 - verification report

**Prepared:** 2026-08-18
**Upstream baseline:** `jimrandomh/g2flash` commit `877c8d9490db0d3717ca012dd0f54556af3701bd`
**Current candidate:** `firmware/g2_2.2.8.4_cfw_FIXED.bin`
**Candidate SHA-256:** `bf143aa220d634969fc7ea856716bfccd6cf197fe93f41bec2b87ebd8add7584`

> **NO-GO: DO NOT FLASH.** The current artifact is reproducible and passes the
> static checks described below, but it has never booted on hardware and the
> thread/ISR legality, RTOS behavior, display handoff, OTA acceptance, both-lens
> behavior, and recovery path remain unverified.

Upstream itself warns that custom firmware can void the warranty and brick the
glasses.[1] Static verification is not a substitute for a known recovery path.

## 1. Artifact status

| Artifact | Status | SHA-256 |
|---|---|---|
| `g2_2.2.8.4_cfw_FIXED.bin` | **Current statically reviewed candidate** | `bf143aa2…add7584` |
| `g2_2.2.8.4_cfw_OURS.bin` | Superseded unsafe research artifact; retain only for comparison | `4cacea57…a70e055c2d` |
| `g2_2.2.8.4_stock.bin` | Verified stock base from Even's CDN | `df7b8bd1…d2fbfda7` |
| `g2_2.2.6.10_cfw_g2flash-official.bin` | Upstream reference replay | `20cba937…55107d1f` |

The upstream committed patch set pins stock 2.2.6.10 and its expected custom
output hashes.[2] This package vendors the reviewed build helpers and records
the exact upstream commit in `UPSTREAM-G2FLASH-COMMIT`.

## 2. What changed in the fixed candidate

The current source addresses the confirmed defects from the first independent
review:

- snapshot producer, consumer, eviction, purge, and teardown metadata share an
  RTOS mutex;
- detached snapshot buffers are freed only after slot ownership is cleared;
- container owners carry generations so pointer reuse cannot revive stale work;
- constructor/destructor wrappers register owners, purge snapshots, quiesce the
  worker, and fail closed rather than free memory still owned by display work;
- pending direct-frame ownership is not cleared by settings lease traffic;
- legacy BMP presentation now takes the display semaphore before retiring a
  prior direct job or rewriting the state-owned framebuffer;
- BMP pixel ranges and `INT32_MIN` heights are rejected safely;
- zlib stream backing is explicitly aligned and framebuffer copies are bytewise;
- settings capability appends include a destination-capacity check;
- tone, wake fallback, timer, buzzer, and launch state are serialized;
- direct display work uses the verified raw semaphore-take return value;
- capability contract is `EVENCFW/9`, with context magic `0xC0FFEE64`.

## 3. Hook scope

The current candidate has **18 injected branch targets**:

- 2 snapshot hooks;
- 1 deferred image worker;
- 1 settings send wrapper;
- 1 settings decode wrapper;
- 2 display-start hooks;
- 1 long-press hook;
- 1 ring-release hook;
- 1 Even-AI entry trampoline;
- 2 display-copy hooks;
- 2 wear-event hooks;
- 1 compass hook;
- 2 container-constructor wrappers;
- 1 container-destructor wrapper.

Three additional in-place edits raise image-container geometry. Container
length/CRC metadata is then recomputed, and one injected blob is appended.

Only settings send site `0x49d2dc` is hooked. `0x49d184` remains byte-identical
to stock: it is command-ID 1's acknowledgement path, whereas `0x49d2dc` is the
command-ID 2 full local-settings response corresponding to the upstream hook.

## 4. Reproducible build

Create an isolated verifier environment and install the pinned dependency:

```bash
python3 -m venv .venv-verification
.venv-verification/bin/pip install --require-hashes -r requirements-verification.txt
```

Run the fail-closed one-command check:

```bash
.venv-verification/bin/python scripts/verify_package.py
```

It performs all release-evidence checks for the **current source and artifact**:

1. rebuilds the candidate with the vendored compiler/patch helpers;
2. byte-compares the rebuild with `g2_2.2.8.4_cfw_FIXED.bin`;
3. validates `firmware/SHA256SUMS` and the package-wide manifest;
4. checks every declared branch target by Thumb disassembly;
5. checks stock-prefix diff confinement and the single append operation;
6. recomputes component CRC32C and main-app preamble CRC.

The relocation scripts are research aids for reconstructing the 6.10→8.4 map;
they are not silently treated as release evidence by the build verifier. The
current `PORT-MAP-8.4.json` is the explicit reviewed map. `gen_8.4_sources.py`
can be executed in a clean output directory and is covered by a regression test.

Run the source/test suite separately:

```bash
python3 -m unittest discover -s tests -v
```

## 5. Current static verification results

For candidate `bf143aa2…add7584`:

- stock size: `4,342,507` bytes;
- candidate size: `4,360,866` bytes;
- injected blob: `18,359` bytes (`17,138` text + `1,221` rodata);
- blob range starts at MRAM `0x0079e498` and ends at `0x007a2c4f`;
- conservative headroom below `0x007f0000`: about 308 KiB;
- exact injected branch targets: 18;
- changed stock-prefix bytes: 100, all inside declared patch/metadata operations;
- command-ID 1 settings acknowledgement: unchanged from stock;
- component CRC32C and main-app preamble CRC: valid;
- optimized-mode (`python -O`) verifier: still fail-closed; release checks do
  not rely on removable Python assertions.

These results establish binary construction and static consistency only.

## 6. Provenance and package contents

- Stock 2.2.6.10 CDN object:
  `https://cdn.evenreal.co/firmware/e28738432d7b612d625331b00383149b.bin`
- Stock 2.2.8.4 CDN object:
  `https://cdn.evenreal.co/firmware/d495a1dffb919795e95135e144345f04.bin`
- Upstream commit:
  `877c8d9490db0d3717ca012dd0f54556af3701bd`
- Package-wide file hashes: `MANIFEST-SHA256SUMS`
- Firmware hashes: `firmware/SHA256SUMS`
- Original independent review: `peer-review/PEER-REVIEW.md`

The package-wide manifest covers every delivered file except the manifest
itself. The tests enforce that coverage.

## 7. Residual hardware blockers

The following are explicit release blockers and cannot be closed by static
analysis:

1. **Thread versus ISR context.** Hooks that allocate, take mutexes, or call RTOS
   services need on-device task/ISR tracing.
2. **Display handoff.** The semaphore ABI is statically identified, but queue,
   display-task ownership, timeout behavior, and both-lens scheduling need traces.
3. **Pending-direct teardown.** Timeout deliberately leaks rather than risking
   UAF; hardware behavior must show whether a bounded or unbounded handoff is safe.
4. **`CFW_CTX_SLOT`.** Post-startup availability of RAM word `0x200043b8` remains
   runtime-unproven.
5. **Timer reentrancy.** Timer stop/start behavior from callbacks requires device
   exercise.
6. **OTA/boot.** Acceptance, boot, watchdog behavior, and both lenses are untested.
7. **Recovery.** No demonstrated recovery from a crashing main app or interrupted
   OTA write exists for the target device.

No numeric runtime-success or recoverability estimate is defensible from this
evidence.

## 8. Required next hardware stage

Do not start this stage until an independent source review passes and a concrete
recovery route is demonstrated on sacrificial or recoverable hardware.

Minimum staged plan:

1. prove stock reflash/recovery independently;
2. capture task/ISR identity for every injected hook;
3. test OTA acceptance with power-loss controls;
4. boot one lens at a time and capture watchdog/crash logs;
5. stress snapshot eviction, container destruction, legacy BMP/direct-frame
   transitions, settings lease changes, timers, and rapid reconnects;
6. test both-lens synchronization and repeated stock restore;
7. only then decide whether to enable firmware installation in Hermes G2.

The Android app intentionally keeps installation disabled until those gates are
closed.

## Sources

[1] https://github.com/jimrandomh/g2flash/blob/877c8d9490db0d3717ca012dd0f54556af3701bd/README.md

[2] https://github.com/jimrandomh/g2flash/blob/877c8d9490db0d3717ca012dd0f54556af3701bd/patches/cfw_patches.json
