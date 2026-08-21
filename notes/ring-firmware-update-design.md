# Even R1 Ring Firmware Update - Design Doc / Feasibility Assessment

**VERDICT: BLOCKED - do not build standalone ring firmware update.**

Standalone custom ring firmware is not realistic soon, and even replaying Even's
own signed image is uncertain and not recommended. Date: 2026-08-19. Synthesis of
four investigator reports, all grounded in `notes/ring-capture-2026-08-19/even-sync-full.log`,
the ring GATT dump, and `FaceclawBleCommunicator.java` / `BleProtocol.java`.

---

## 1. Bottom line

Standalone R1 ring firmware update is not realistic soon, and it is qualitatively
different from (and far more dangerous than) the glasses CFW flow that already ships.

One hard wall drives the verdict: the ring's real reflash entry point is a standard
**Nordic Secure DFU service (`0000fe59`, buttonless char `8ec90003`)** on an nRF-class
part. Nordic Secure DFU bootloaders verify an **ECDSA-P256 signature** over the init
packet against a public key baked into the immutable bootloader. Without Even's
**private** signing key, Hermes cannot build, patch, or forge any image the ring will
accept. The "custom firmware" premise that makes the glasses story work (an unsigned,
CRC-only container Hermes byte-patches on-device) does not transfer. The most Hermes
could ever achieve is re-pushing Even's own genuine signed image, which delivers zero
custom-firmware value while carrying an unrecoverable-brick downside.

Three unsolved prerequisites sit in front of even that limited outcome:

1. **No approved image source.** The private archive contains only an unverified ring-firmware
   candidate; no provenance-verified, compatible, vendor-signed, usable image is approved.
   The image path remains auth-walled behind Even's cloud (`api.evenrealities.com/v2/g/check_firmware`),
   whose auth Hermes has only partially reversed and never gotten working.
2. **No bond ownership.** Hermes piggybacks on the Even app's existing ring bond and
   never creates one. Ring pairing/provisioning is unreversed and hard-blocklisted.
3. **No captured DFU flow.** Zero OTA/DFU bytes were ever captured; the trigger payload,
   signing requirement, and the entire Secure DFU state machine are unobserved guesses.

**Recommendation:** do not build standalone ring firmware update. If any effort goes to
the ring, put it into the far safer HEALTH read path, not firmware writes.

---

## 2. Feasibility reasoning (grounded facts)

- **The ring is a Nordic (nRF) BLE device.** Its full GATT was captured from Hermes' own
  service discovery (`even-sync-full.log` line 31): exactly four services - Generic Access
  `0x1800`, Generic Attribute `0x1801`, the vendor **Ring1** service
  `bae80001-4f05-4503-8e65-3af1f7329d1f`, and the **Nordic Secure DFU** service `0000fe59`.
- The ring does **not** expose Device Information Service (`0x180A`) or Battery Service
  (`0x180F` / `0x2A19`); a `0x2A19` read failed with "Characteristic not found." All
  health/status/version/OTA rides the vendor Ring1 protocol.
- **The Ring1 command protocol is fully reversed and byte-verified** against `com.even.sg`'s
  `BleRing1Model`: a CRC-32-framed binary envelope over `bae80012` (write-no-response) /
  `bae80013` (notify).
- **Firmware version** is read via the vendor `deviceInfo` frame (module=1 / cmd=0 /
  subCmd `0x02`), a bare status=req GET whose ~32-byte ack carries the version string.
  Observed ring version **2.2.8.0002**, MAC `DC:BE:DA:94:20:B8`, bonded, LE, MTU 247.
  `deviceInfo(0x02)` is not currently read by Hermes but is **not** blocklisted.
- **The capture contains ZERO firmware/OTA/DFU/provisioning traffic.** It is a logcat TEXT
  log of a live health sync against an already-bonded, already-provisioned ring. grep counts:
  ota=0, dfu=0, bootloader=0, otaStart(0x09)=0, provision=0. The ring was already up-to-date,
  so `check_firmware` presumably returned "up to date" and no OTA fired.
- **The update decision is cloud-driven.** The Even app calls
  `api.evenrealities.com/v2/g/check_firmware` repeatedly (15x), each right after a
  `deviceInfo` / `nvRecover` read. Only the request URL is logged, never a response body
  or download URL.

---

## 3. GATT / protocol map (ring)

| Service | UUID | Key characteristics | Role |
|---|---|---|---|
| Generic Access | `0x1800` | `2A00` name, `2A01` appearance | standard |
| Generic Attribute | `0x1801` | `2A05` service-changed | standard |
| **Ring1 (vendor)** | `bae80001-4f05-4503-8e65-3af1f7329d1f` | **`bae80012` write-no-resp = command WRITE**; **`bae80013` notify = data/health responses** | app-mode command + health channel |
| **Nordic Secure DFU** | `0000fe59` | **`8ec90003-f315-4f60-9fb8-838830daea50` props=0x28 (WRITE+INDICATE)** = Buttonless DFU without bond sharing | firmware/bootloader entry point |

**system subCmd enum (module=1, cmd=0):** deviceStatus `0x01` (battery), deviceInfo `0x02`
(version), wearStatus `0x03`, userInfo `0x04`, systemTime `0x05`, pairAuth `0x08`,
**otaStart `0x09`**, **advStart `0x0a`** (carries host MAC), getAlgoKeyStatus `0x0b`,
**setAlgoKey `0x0c`**, healthSettingsStatus `0x0e`, systemSettingsStatus `0x0f`,
deviceSn `0x10`, **nvRecover `0x11`**, **powerControl `0x12`**, **pairDelete `0x13`**,
packetAck `0x7e`, heartbeatPack `0x7f`. (Bold = blocklisted.)

Only the `8ec90003` buttonless (without-bonds) char is visible in application mode. The
DFU-mode Control Point `8ec90001` and Packet `8ec90002` appear only **after** the ring
reboots into bootloader mode under a shifted, unbonded address, which never happened in
the capture.

---

## 4. SECURITY: close the sendRawRingFrame() bypass

The blocklist (`isBlocklistedRingSubCmd()`, `FaceclawBleCommunicator.java` lines 1726-1736)
refuses the six system mutators - otaStart `0x09`, advStart `0x0a`, setAlgoKey `0x0c`,
nvRecover `0x11`, powerControl `0x12`, pairDelete `0x13` - by returning null from
`buildRingFrame()`.

**The blocklist is enforced only at frame-BUILD time.** The `sendRawRingFrame()` path
(line 1650, used today only for the benign pairAuth golden frame) has **no** blocklist
check and writes any bytes directly to `bae80012`. A raw captured otaStart frame could be
replayed through it, bypassing `isBlocklistedRingSubCmd` entirely. This is a latent safety
gap.

**Action (safe, do now):** apply blocklist inspection to the raw path too, or otherwise
ensure no captured otaStart/mutator frame can be replayed through `sendRawRingFrame()`.

---

## 5. Top risks (ranked)

1. **BRICK-WITHOUT-RECOVERY (severe, gating).** The ring is a buttonless, screenless,
   USB-less nRF part, likely single-bank (erase-before-write; unconfirmed). Writing the
   buttonless char reboots it into bootloader mode advertising unbonded under a shifted
   address. If Hermes triggers the jump but cannot complete a valid signed DFU (no genuine
   image, lost the shifted-address peripheral, or interrupted transfer), the ring is left
   in bootloader mode with **no manual recovery**. Recovery without the Even app is possible
   ONLY if Hermes already holds a genuine signed image and a full working Secure DFU client.
   Far worse than the glasses (dual-lens, powered, reflashable).
2. **Signature wall.** Nordic Secure DFU enforces ECDSA-P256 against a key in the immutable
   bootloader; without Even's private key Hermes cannot build/patch/forge any accepted image.
3. **No approved image source** (the private archive's candidate is unverified; the auth-walled cloud
   and `app/native/even-api.ts` are flagged EXPERIMENTAL/UNVALIDATED and have never produced an approved
   image; signing constants remain unavailable).
4. **Pairing dependency (hard prerequisite).** The trigger rides the encrypted app-mode link,
   which needs the bond Hermes does not own. Ring update cannot precede ring pairing.
5. **Entire DFU wire flow is unobserved.** The otaStart payload, buttonless trigger bytes,
   signing requirement, and bootloader banking/rediscovery are all unverified guesses.
6. **Large, mostly-wasted RE cost.** Even a successful replay only reinstalls Even's own
   firmware, with no custom-firmware upside.

---

## 6. Safe near-term win

- **Add a `deviceInfo(0x02)` version read.** It is not blocklisted, is read-only, and lets
  Hermes display the ring firmware version (observed **2.2.8.0002**). Small, safe change.
- **Close the `sendRawRingFrame()` blocklist gap** (see section 4).
- **Redirect ring effort to the HEALTH read path,** not firmware writes.

---

## 7. If ever pursued: phased, gated plan (STOP if any gate fails)

Before any future phase is reconsidered, complete `notes/ring-firmware-consent-gate.md`. It defines two
separate records: a phase approval and a per-run GO/NO-GO record. Both are scope-, time-, device-,
artifact-, operator-, and procedure-bound; missing, ambiguous, stale, expanded, or revoked approval fails
closed. Consent is necessary but never sufficient: the protocol, authentic-image, pairing/authority, and
independent recovery gates below remain separate prerequisites. The current consent status is
**BLOCKED/UNSATISFIED** and the operational decision remains **NO-GO / DO NOT BUILD**.

- **Phase 0 - Do not build (current recommendation).** Redirect ring effort to the safe
  HEALTH read path. Optionally add the `deviceInfo(0x02)` version read. Close the
  `sendRawRingFrame()` gap defensively.
- **Phase 1 - Intelligence only (no writes).** Re-establish Even cloud auth from a fresh APK
  pull; capture a genuine ring firmware update via Even-app logcat to observe the otaStart
  payload and full DFU sequence; capture the `check_firmware` response to find the ring
  image URL/format. **GATE:** if the captured package is ECDSA-signed against an Even key,
  STOP. Custom firmware is impossible, and re-pushing Even's image is not worth the brick risk.
- **Phase 2 - Pairing workstream (independent, safer, higher value).** Reverse
  `advStart(0x0a)` host-MAC bind and `setAlgoKey(0x0c)` provisioning to own the bond
  standalone. Prerequisite for update AND independently useful for onboarding. Does not risk
  bricking, so prioritize it over update regardless.
- **Phase 3 - Recovery harness on a sacrificial ring.** Only with a genuine signed image in
  hand: build and prove the Secure DFU client, shifted-address rediscovery, and
  interrupted-transfer retry to completion. **GATE:** no recovery demonstrated, never ship
  writes.
- **Phase 4 - Guarded replay feature (only if Phases 1-3 all pass).** Hash-pinned,
  consent-gated re-push of Even's genuine image, mirroring the glasses'
  `requireCanonicalImageDigest()` precheck. Accept that this delivers no CFW upside.

**Non-negotiable gates if pursued:** keep the six mutators blocklisted; never write
`8ec90003` (nor otaStart) unless a genuine, signature-valid, hash-pinned image is verified
on-device first; prove bootloader recovery on a sacrificial ring before any write; require the
completed, separately signed consent records in `notes/ring-firmware-consent-gate.md`, including
the owner, operator, Benny as safety approver, and independent recovery lead/witness for destructive
work; solve ring pairing (own the bond) before ring update. No consent record can authorize signature
forgery, key extraction, validation disabling, bootloader patching, downgrade/exploit paths, or any
other secure-update bypass. Any failed gate is a STOP result.

---

## 8. Why the glasses CFW is not a template

Glasses images come from Even's public CDN as a raw `.bin`, SHA-256 hash-pinned, CRC-32C
per segment, with **no signature** - which is exactly why Hermes can byte-patch them
(`firmware-builder.ts`, `FaceclawFirmwareFlasher.java`, EVENOTA container over
`00002760-...-0001/0002`). The ring is the opposite on every axis: signed Nordic Secure DFU,
auth-walled cloud, buttonless/unrecoverable device. Reusing the glasses posture (hash-pin
plus consent) is right; reusing its code or its "we can patch it" premise is not.

> Note: the older g2-kit-unofficial/decompile enum uses different **indices** (e.g. otaStart
> as an index into a firmware lookup table) and is a **mis-parse**. Do not trust it for wire
> bytes; shipping code uses the `BleRing1Model` wire-byte values. Also, the ring appears to
> ignore the inner crc16 (captured values do not match CRC-16/CCITT-FALSE); confirm before
> hand-crafting frames rather than replaying captures.
