# Independent peer review - Even G2 CFW 2.2.8.4 port

**Review date:** 2026-08-18  
**Reviewed package:** `even-g2-cfw-8.4-verification`  
**Artifact under review:** `firmware/g2_2.2.8.4_cfw_OURS.bin`  
**Reviewed SHA-256:** `4cacea57802d69ccd8619b060b4a156434070c327ac0b9ce1e5552a70e055c2d`

## Verdict

**Do not flash this build yet.**

The static relocation and container work is substantially stronger than the package's weaknesses might suggest: I independently reproduced the 8.4 binary byte-for-byte after restoring omitted upstream build files, verified every declared patch location and exact injected-function target, reproduced the relocation results, and found no unexplained binary modifications.

However, static correctness is not runtime safety. Two concrete C-level hazards remain in the inherited injected code, one of them a high-severity producer/consumer race. The package is also not reproducible as delivered, and the report's 80–90% runtime/recovery confidence has no defensible statistical basis. I would require the high-risk code issues to be fixed, a complete pinned build bundle, and a hardware test with a proven recovery path before using the target glasses.

## What independently passed

### Integrity and provenance

- Both checksum files pass for every file they list.
- Fresh downloads from the two Even CDN URLs in `REPORT.md:44-45` were byte-identical to the packaged stock images:
  - 2.2.6.10: `f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa`
  - 2.2.8.4: `df7b8bd18727765eba73be5ab836e0ee4cfd17b5e680046003b8d608d2fbfda7`
- The four files under `sources/original-6.10/` are byte-identical to upstream `jimrandomh/g2flash` commit `877c8d9490db0d3717ca012dd0f54556af3701bd`.
- Applying that commit's committed `cfw_patches.json` to the packaged 6.10 stock image reproduced the packaged official CFW byte-for-byte at `20cba937…55107d1f`. Upstream documents the pinned-hash patch workflow, and its committed patch set pins that output hash.[1][2]

### Firmware-container structure

Independent parsing of the stock and custom containers confirmed:

- Six components in each container.
- Every component satisfies `TOC size == payload size + 128`.
- Every stored component CRC32C agrees between the TOC and subheader and recomputes correctly.
- The main-app preamble zlib CRC32 recomputes correctly.
- The extracted `ota_s200_firmware_ota_*.bin` files are byte-identical to their corresponding main-app payloads.
- The main app is the final component in both stock images and in the custom image.
- In the custom image, codec, BLE, touch, box, and bootloader components are byte-identical to 8.4 stock.

The 8.4 mapping is correct when `0xbde33` is understood as the **main-app payload start**:

```text
main-app subheader:      0x0bddb3
main-app payload start:  0x0bde33
code/XIP start:          payload + 0x20 -> VA 0x00438000
DELTA:                   0x00438000 - 0x20 - 0x0bde33 = 0x0037a1ad
```

### Binary-difference confinement

Comparing 8.4 stock to the custom image found:

- Stock size: `4,342,507` bytes
- Custom size: `4,361,874` bytes
- Appended tail: `19,367` bytes
- Exactly 23 changed runs in the stock-sized prefix, covering:
  - the 18 declared code patch sites; and
  - six required metadata/checksum fields. Two adjacent code sites merge into one run, while unchanged bytes can split a four-byte field into shorter runs.
- Zero changed bytes outside the declared code sites and required metadata fields.
- One appended range only: `0x4242eb..0x428e92` (end-exclusive).

All 15 branch/trampoline hooks decode to the **exact intended injected function entry**, not merely somewhere inside the blob:

```text
snapshot_side                    0x7a003c  (two hooks)
image_deferred                   0x7a0044
settings_send_wrapper            0x7a0e90
settings_decode_wrapper          0x7a0938
faceclaw_display_start           0x7a0770  (two hooks)
evenhub_longpress                0x7a0f54
ring_release                     0x7a0f8c
faceclaw_evenai_display_entry    0x7a0e6c  (B.W)
display_copy_hook                0x79e5dc  (two hooks)
faceclaw_send_wear_event         0x7a0588  (two hooks)
compass_event_forward            0x79e55c
```

The generated blob is `19,367` bytes: `18,146` bytes of text plus `1,221` bytes of read-only data. Its MRAM range is `0x79e498..0x7a303f` **end-exclusive**.

### Rebuild and source generation

The report's rebuild command fails as shipped because required files are absent. In an isolated directory I restored only these files from upstream commit `877c8d9`:

- `build.py`
- `apply_patches.py`
- `patches_main.c`

Using packaged ported sources and clang `22.1.8`, the documented build then produced:

```text
4cacea57802d69ccd8619b060b4a156434070c327ac0b9ce1e5552a70e055c2d
```

and was byte-identical to `g2_2.2.8.4_cfw_OURS.bin`.

I also reconstructed the generator's expected workspace, ran `gen_8.4_sources.py`, and obtained byte-identical copies of all four packaged ported source files.

### Relocation evidence

With Capstone 5.0.9 and the expected input paths reconstructed:

- Anchor matcher: `18/18` reported locations reproduced.
- Shared-target groups reproduced for snapshot, display-copy, wear, and ring/compass hooks.
- `reloc_full.py`: 37 of 38 code mappings reproduced directly; the remaining `0x474066 -> 0x4748a2` is manual.
- RAM mappings reproduced except `EVT_SRC`, which is recovered through the separate pool analysis; `0x20000000` is a fixed base constant.
- Call-edge check reproduced 12 useful cases; `display_copy` reports `0/0 MISMATCH` because it is a leaf.
- I independently found all four old direct callers of `0x474066`, relocated their local instruction contexts, and confirmed that all four new calls target `0x4748a2`.
- Every compiled old→new source literal substitution is justified by `PORT-MAP-8.4.json`; no changed executable literal was unexplained.
- The 8.4 stock references to the relocated BLE-RX context base showed the same observed `+0x8`/`+0xc` access pattern as 6.10, which supports-but does not fully prove-the claim that `+0x0` is spare.

## Prioritized findings

### High - Snapshot FIFO publication is race-prone

`cfw_snapshot()` and `image_deferred()` implement an asynchronous producer/consumer queue, but there is no lock, critical section, atomic state, or interrupt exclusion around the shared slots.

The producer publishes `state` first:

- `sources/zlib_glue.c:1460` - writes `state`
- `sources/zlib_glue.c:1461-1463` - only afterwards writes `buf`, `len`, and `seq`

The consumer treats `state != 0` as a valid committed slot:

- `sources/zlib_glue.c:1498-1504`

The consumer clears only `state` at `zlib_glue.c:1505`, leaving stale `buf`, `len`, and `seq`. On slot reuse, a task switch or interrupt after the producer writes `state` but before it replaces the other fields can make the consumer process and free stale data, potentially including an already-freed pointer. Cortex-M being single-core does not prevent RTOS/interrupt preemption between stores.

There is also a full-ring race: the producer can select and free the oldest slot at `zlib_glue.c:1451-1453` after the consumer has selected the same slot at `1496-1504` but before the consumer clears its validity marker. That permits use-after-free or double-free even if publication order alone is corrected.

**Required fix:** synchronize producer and consumer; populate all fields before publishing a validity marker; clear or version slots on consumption; and use an RTOS-safe critical section or a correctly ordered single-producer/single-consumer design. This should be stress-tested with forced preemption and queue overflow.

### Medium (safety-blocking) - Malformed/truncated BMP can cause an out-of-bounds read

`load_bmp_fast()` checks that `dataoff < len`, but never proves that the complete pixel array fits:

- `sources/zlib_glue.c:1008-1027`

It should validate, with overflow-safe arithmetic:

```c
dataoff + stride * h <= len
```

Without that check, a short message beginning with `BM`, declaring the expected carrier dimensions and a valid in-range `dataoff`, reaches `unpack4bpp()`, which reads `stride * h` bytes past the received buffer. This can crash the main app or disclose adjacent memory into the display path.

There is a second malformed-BMP defect at `sources/zlib_glue.c:1014-1016`: negating a height of `INT32_MIN` is signed-overflow undefined behavior. Reject that value before taking the absolute height.

This defect exists in the upstream 6.10 source too; it is not introduced by the address port, but it remains relevant to whether this firmware is safe to flash.

### High - Runtime and recovery confidence is unsupported

`REPORT.md:8-10` and `142-152` correctly disclose that the build has never run on hardware. The numeric estimates at `REPORT.md:154-155` nevertheless imply a calibration that the evidence does not contain.

Static analysis cannot establish:

- OTA acceptance on 8.4 hardware;
- ABI compatibility for every hard-coded function pointer;
- scheduling, lock, timer, queue, and callback behavior;
- whether both lenses stay synchronized;
- whether a main-app boot loop leaves the BLE flashing path reachable; or
- recovery after interruption during flash.

Upstream itself warns that custom flashing can brick the glasses.[1] Its statement that an official OTA restores stock behavior is useful evidence for a healthy running app, not proof that a crashing custom main app remains reachable for recovery.[1]

**Conclusion:** no defensible runtime-success or recoverability percentage can be assigned from this package alone.

### High - The verification package is not reproducible as delivered

The exact commands in `REPORT.md:124-127` and `168-173` do not run from the package:

- `sources/patch_compress.py:179-187, 222, 413` requires missing `build.py`, `patches_main.c`, and `apply_patches.py`.
- Relocation scripts import undeclared `capstone`.
- They hard-code nonexistent `g2fw/fw/ota_6.10.bin` and `g2fw/fw/ota_8.4.bin` instead of using the packaged firmware paths.
- `reloc_full.py:43` requires missing `addr_set.json`.
- Other scripts require missing `reloc_result.json` and `reloc_full_result.json`.
- No requirements file, pinned Capstone version, upstream commit, compiler version, or one-command verifier is included.
- Source comments cite supporting materials such as `notes/fw-2.2.6.10-cfw-rebase.md` and related reverse-engineering notes, but those notes are absent from the review package.

The omission does not invalidate the custom binary-I reconstructed it exactly-but it prevents an independent reviewer from reproducing the advertised workflow without guessing and fetching mutable upstream content.

A related toolchain issue: applying upstream's committed JSON reproduces the official 6.10 CFW, but recompiling the current 6.10 sources with clang 22.1.8 produced a different `c62b8c4a…` image and a 19,367-byte blob instead of the committed official image's 20,127-byte blob. Thus the baseline proves the committed byte patch set, not compiler-level determinism.

### Medium - Settings response append has no capacity check

`settings_send_wrapper()` trusts the claim that its hooked buffer is 256 bytes and currently uses about 40 bytes:

- assumption: `sources/settings_ext.c:14-19`
- write: `sources/settings_ext.c:323-332`

The capability text is 80 bytes. The function transmits 83 additional bytes and `strlcpy()` also writes a terminating NUL, so it writes 84 bytes beyond `buf + len`. The operation is safe only when the incoming `len <= 172`, but no capacity or length check exists.

The current static call site may make the assumption true, but the port's evidence does not establish a hard upper bound for every 8.4 response state. Add an explicit capacity guard or use a known bounded output structure.

### Medium - Several ABI/layout assumptions remain unresolved

Examples:

- `settings_decode_wrapper()` treats the stock stream as four 32-bit words (`sources/settings_ext.c:271-280`). A focused 8.4 disassembly check found the constructor at `0x490c10` initializes callback at `+0`, state at `+4`, bytes-left at `+8`, and error pointer at `+0xc`, so this particular layout assumption is supported.
- `CFW_CTX_SLOT` writes a private heap pointer into stock RAM offset `+0x0` (`sources/zlib_glue.c:233-244, 315, 1032-1060`). Normal BLE-task code uses `+0x8/+0xc`, but stock startup code also reads and indirectly calls the first word at `0x200043b8`. No post-initialization stock use of `+0` was established, so reuse may be valid after startup, but “spare/never used” is too strong and lifetime/ownership still require proof.
- `cfw_snapshot()` trusts `state+0x20` as an allocation-safe message length and copies that many bytes from `state+0xc` (`sources/zlib_glue.c:1442-1459`) without independently knowing the reconstruction-buffer capacity.
- `EVT_SRC` byte layout remains acknowledged but unaudited (`REPORT.md:150-152`).
- The claimed `set_image_data` 50/53 struct-offset audit in `REPORT.md:113-118` has no script, listing, disassembly, or intermediate evidence in the package.

The nanopb stream layout is positively supported; the remaining items should be promoted from “minor assumptions” to explicit pre-flash gates.

### High - Timer callbacks share mutable state without synchronization

`seq_tick()` runs on the RTOS timer thread and reads or changes `seq_count`, `seq_cursor`, and `seq_steps` (`sources/zlib_glue.c:328-355`). The image-handler path can stop and replace the same sequence fields at `sources/zlib_glue.c:523-568` without a lock, critical section, atomics, or a publish-last generation marker. The callback can therefore observe a partially replaced sequence or race a stop/restart.

Wake fallback callbacks similarly share the singleton context with settings/display handlers (`sources/settings_ext.c:87-114, 159-239`). These need an explicit concurrency model and RTOS-safe synchronization, not just a valid magic value.

### Medium - Display-gate ownership is inferred rather than returned

`FW_DISPLAY_WAIT` is typed as a `void` function (`sources/zlib_glue.c:143, 175`). `image_worker()` calls it and, if `direct_pending` remains set, returns without signalling the gate (`sources/zlib_glue.c:481-487`). The comment assumes this means the wait timed out and the caller never acquired ownership, but no return value establishes that. If the gate was acquired while the flag remained set, this path leaks the gate and can deadlock display processing. The wrapper must use a verified return status or a separately proven ownership rule.

### Medium - Container lifecycle can leave stale snapshot records

Snapshot records are keyed only by the raw image-state pointer and allocate independent buffers (`sources/zlib_glue.c:249-268, 1438-1508`). No teardown hook removes snapshots for a destroyed container. Pending records can leak, and allocator reuse of the same state address can make stale data appear to belong to a new container. Add teardown cleanup or a generation-qualified owner identity.

### Medium - Rejected messages can still mutate protocol/display state

- Mode 3 records a frame ID through `cfw_diag()` before decompression succeeds (`sources/zlib_glue.c:747-765`). A malformed frame can poison duplicate tracking so a valid retry with the same ID is discarded.
- Mode 8 applies submessages incrementally (`sources/zlib_glue.c:630-654`). If a later segment fails, earlier shadow mutations are not rolled back even though the overall operation returns failure.

These are logic-integrity defects rather than direct memory corruption, but they undermine the claimed atomic/retry behavior.

### Medium–High - The settings-send hook has a second near-duplicate 8.4 candidate

The old settings-send site `0x49bb68` does not have a uniquely identified 8.4 counterpart under the package's normalized matcher. A focused comparison found two exact normalized 41-instruction candidates:

- `0x49d184` (`+5660`), inside a function entered at `0x49d074` and called from `0x466f68`;
- `0x49d2dc` (`+6004`), inside a function entered at `0x49d1cc` and called from `0x467002`.

Both candidate instructions call the same relocated stock sender, `0x4768d8`. The port patches only `0x49d2dc`, selected using the expected regional delta. The second function is plausibly the correct structural successor, but static shape and delta do not establish which duplicate handles every relevant settings-response path or why the first should remain unpatched.

This is primarily a feature-coverage risk: capability advertisement or private control may silently fail on traffic routed through the unpatched duplicate. Resolve both functions' callers and message semantics in decompilation, then document why one or both sites must be patched.

### Medium - The “five independent ways” are correlated and are not test gates

`REPORT.md:97-118` overstates independence:

- instruction matching, RAM load-site relocation, and call-edge relocation reuse the same normalized linear Capstone matcher;
- normalized operands mask values that can carry semantic differences;
- `reloc_match2.py:92-97` can select an ambiguous site using a manually expected regional delta;
- `reloc_strag2.py:40-47` searches for an already expected new RAM value;
- `gen_8.4_sources.py:6-10` hard-codes manual RAM and pool maps;
- `verify_cg2.py:40` hard-codes the manual display-queue mapping;
- `verify_cg2.py` prints `SOME EDGE MISMATCH` for `display_copy 0/0` yet exits successfully;
- the scripts generally print warnings/counts rather than returning nonzero when required claims fail.

The results remain useful corroboration. They are not five statistically or methodologically independent proofs.

### Medium - Source contains alignment-dependent C behavior

`zlib_glue.c` stores a zlib stream in `uint8_t strm[ZS_SIZE]` and repeatedly casts offsets in that byte array to pointer and `uint32_t` lvalues (`sources/zlib_glue.c:686-692, 929-946`). C only gives that array byte alignment, so the typed dereferences are formally undefined if the compiler does not happen to align the stack object. `copy_panel()` similarly casts byte pointers to `uint32_t *` (`sources/zlib_glue.c:1097-1100`).

The reviewed clang build placed the current artifact consistently and the target likely supplies aligned stack/heap/framebuffer addresses, so this is not evidence of an actual misaligned instruction in this exact binary. It is still a compiler-sensitive source hazard and should be fixed with an explicitly aligned structure or byte-wise access.

## Documentation and packaging corrections

1. `REPORT.md:60-62` calls `0xbde67`/`0xbde33` component offsets. They are payload starts; the component subheaders are 128 bytes earlier.
2. The whole extracted payload entropies are `6.379094` and `6.390382` bits/byte, not approximately 6.9 (`REPORT.md:63`). If 6.9 refers to a selected code range, identify the range and method.
3. `PORT-MAP-8.4.json` contains 38 unique code mappings, 10 RAM mappings, and three pool mappings. The “45 stock-function addresses” count at `REPORT.md:91-93` needs its counting basis documented.
4. The MRAM end `0x7a303f` is exclusive, not an inclusive final byte (`REPORT.md:135`).
5. `REPORT.md:134-135` describes all 18 edits as patched `bl`/`b.w` instructions. The binary contains 15 branch/trampoline redirects plus three geometry instruction edits.
6. The claimed monotonically increasing code deltas have at least one global decrease (`+23700` near `0x54566c`, then `+22432` at `0x58705c`). “Per-region” must be defined before this can be used as evidence.
7. `MANIFEST-SHA256SUMS` omits the four `sources/original-6.10/*` files, all firmware files, and even `firmware/SHA256SUMS`. Include every review input in one top-level manifest. A hash manifest still provides integrity, not authenticity, unless it is signed or anchored externally.
8. Pin upstream commit `877c8d9490db0d3717ca012dd0f54556af3701bd`, clang `22.1.8` or an exact container image, Capstone `5.0.9`, and all build helper hashes.

## Recommended go/no-go gates

Do not flash until all of these are satisfied:

- [ ] Fix and stress-test snapshot FIFO synchronization/publication.
- [ ] Add complete BMP pixel-data bounds validation and malformed-input tests.
- [ ] Synchronize timer callbacks with handler-side sequence/wake state updates.
- [ ] Prove display-gate ownership/timeout semantics and make failure paths release correctly.
- [ ] Clean pending snapshot allocations on container teardown and prevent pointer-reuse aliasing.
- [ ] Bound the settings response append and verify the 8.4 stream/buffer ABI.
- [ ] Resolve the two duplicated settings-send candidates and prove all required settings paths are hooked.
- [ ] Include every build helper, generated prerequisite, dependency pin, and source input.
- [ ] Provide one clean-room command that rebuilds and checks the exact 8.4 SHA-256.
- [ ] Turn every verification script into a fail-closed test with nonzero exits.
- [ ] Add reproducible evidence for image-state, event-record, nanopb-stream, and BLE-context layouts.
- [ ] Test OTA acceptance, boot, idle wake, stock Even AI, image modes, compass, wear events, timers, and both-lens synchronization on hardware.
- [ ] Demonstrate recovery from a deliberately crashing main app or have a verified SWD/hardware recovery path.
- [ ] Perform the first test on hardware whose loss is acceptable-not the only target pair.

## Bottom line

The **address port and binary assembly are credible and mostly verified**. The artifact is not a random or obviously malformed patch: its provenance, container checksums, change confinement, source generation, branch destinations, and most relocation relationships hold up.

The remaining problem is not primarily relocation. It is the gap between static equivalence and a safe embedded runtime, amplified by two concrete memory/concurrency hazards and an incomplete review bundle. Until those are addressed, this review remains a **no-go for flashing**.

## Sources

[1] https://github.com/jimrandomh/g2flash/blob/877c8d9490db0d3717ca012dd0f54556af3701bd/README.md - g2flash README at reviewed commit
    > "This repository contains patches applied to firmware, but does not contain the Even Realities firmware itself. The build_cfw.sh script will download the base firmware from Even's CDN, apply patches, and verify that the resulting firmware has the expected hash for you."
    > "WARNING - this voids your warranty and can brick the glasses."
    > "Installing an OTA update using the official Even app will fully remove the custom firmware and restore it to stock behavior."
[2] https://github.com/jimrandomh/g2flash/blob/877c8d9490db0d3717ca012dd0f54556af3701bd/patches/cfw_patches.json - g2flash committed 2.2.6.10 patch set
    > ""base": "g2_2.2.6.10.bin", "base_sha256": "f4dfb0b49ad3de3c2daf17f8a27a157c3dc98411d6a0d3ab2cfd0918f41b9afa", "output_sha256": "20cba9377ea207c8c0a6fd936f32db9ecaf23da023cdf43a770b22b355107d1f""
