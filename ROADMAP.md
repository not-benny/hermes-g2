# Hermes G2 — ROADMAP

Living planning doc (Now / Next / Later). Canonical for planning as of 2026-08-20.
Full session history lives in `HERMES-G2-MASTER-PLAN.md` (archive).

**Status key:** DONE · IN-PROGRESS · BLOCKED · TODO · RESEARCH
**Branch:** hermes-g2 · on-device target: see secrets.local.md

---

## Operational notes

- **Even app Bluetooth is revoked by default.** The Even app (com.even.sg) has BLUETOOTH_CONNECT +
  BLUETOOTH_SCAN revoked so Hermes holds exclusive access to the R1 ring (the two apps compete for the ring;
  only one holds live data at a time). Standing rule: leave Even's BT disabled by default; re-enable on demand
  ONLY when a task needs the Even app (ring pairing, firmware updates, or syncing the Even DB for ground-truth
  validation of sleep/calorie decode), and re-revoke it immediately afterward. While disabled Even cannot sync,
  so obtaining a FRESH ground-truth capture requires temporarily re-granting Even's BT (see the harness below);
  an initial capture already exists.
- **Ground-truth validation harness (ring decoders).** Repeatable method: enable full btsnoop
  (Samsung: `settings global bluetooth_hci_log 1` + `persist.bluetooth.btsnooplogmode full`, log at
  `/data/log/bt/btsnoop_hci.log`), briefly re-enable the Even app to capture its ring traffic, and pull the
  Even app's built-in health-data export (7 CSVs). Together these give ground truth for validating every ring
  decoder (HR, sleep, calories, steps, temperature). The Even-BT re-enable MUST be reverted afterward per the
  standing rule above.
- **Private ground-truth data is repo-excluded.** The Even export CSVs and btsnoop captures live at
  `/home/benny/Documents/hermes-g2/ground-truth-private/`, the captured R1 ring firmware zip under
  `ground-truth-private/firmware/`, and the byte-verified decode spec at
  `ground-truth-private/firmware/re/DECODE-SPEC.md`. None of it may EVER be committed to the public repo
  (personal health data and the proprietary firmware binary).

---

## NOW — active / next to land

### Health (ring) — session largely CLOSED
- **CONFIRMED (firmware RE, 2026-08-20)** — Ring protocol byte-verified against the captured firmware and real
  notifies. Frame envelope on the 0x0015 / 0x0017 rich channel = [0x00][CRC-32C u32 over bytes 5:][12-byte
  inner FRAME][inner CRC16/MODBUS][payload]; both CRCs reproduced independently (CRC-32C Castagnoli 0x1EDC6F41
  init 0; CRC16/MODBUS 0xC0C1 init 0xFFFF), which VALIDATES the existing buildRingFrame CRC-32 work (the old
  "random bytes in the CRC" write-drop bug was already fixed in a prior session; the RE confirms the fix is
  correct, it is NOT an open root cause). Command table confirmed: module system=1 / health=2 / sport=3;
  health cmd HR=1 / SpO2=2 / temp=3 / HRV=4 / activity=5 / sleep=6, subCmd daily=1; battery = deviceStatus
  data[0]. HR/SpO2 hourly record = [hourIdx u8][avg u8][max u8][min u8]; HRV record = [hourIdx u8][avg u16 LE]
  [max u16 LE][min u16 LE]; header count@0, base/timestamp@7, live current@11. Matches Hermes' current decoder
  and is regression-tested, so HR / HRV / SpO2 decode is CONFIRMED-by-RE. Full byte-verified spec lives
  privately at `ground-truth-private/firmware/re/DECODE-SPEC.md` (repo-excluded).
- **TODO** (unblocked, awaiting capture) — Sleep (cmd=6) decode. Schema and stage map fully known: 0=Wake,
  1=REM, 2=Light, 3=Deep at 30s epochs; total/wake/rem/light/deep seconds; body_temp_delta. Remaining work: a
  real overnight worn-ring capture correlated to a ring1Notify DB session (Ben will signal when he has sleep
  data), then map cmd=6 frame bytes onto the schema. `decodeSleep` stays a throwing stub until then; do NOT
  guess-and-ship the layout. See `notes/ring-sleep-frames-2026-08-20.md`.
- **NOTE** — Skin temperature is a daily, sparse metric (frequently absent or zero), consistent with the
  earlier nightly/reserved read. Low priority; there is no per-epoch temperature stream beyond the sleep
  record's body_temp_delta field.
- **DONE** — Ring-native **calories + steps** decode (cmd=5, activity). Confirmed
  header `[count][UTC offset i16][local-midnight epoch u32]` and stride-7 records
  `[slot][steps u16][active kcal u16][total kcal u16]` against the captured frame,
  firmware struct accesses, and matching 11:50 CSV rows. Resting kcal is
  `total-active`. Buckets merge and persist by day/slot; ring-native active kcal
  is primary in phone/glasses UI, with Keytel retained as the marked fallback.
  The ingestion boundary requires the exact daily push envelope, verified inner
  MODBUS CRC, and current local day; persistence rebuilds canonical derived fields.
- **DONE (headline health feature)** — **Live heart rate.** RE resolves the core unknown:
  the R1 ring has NO per-beat stream; its finest granularity is the hourly aggregate, and the frame header's
  live current@11 IS the live current-hour reading. That value is already routed to `store.currentHr` and the
  glasses HUD (re-wired this session). The frame envelope for this path is byte-verified (see CONFIRMED above),
  which closes the earlier "finish the frame-format decode" sub-item. A worker-thread HR-only GET now refreshes
  the current-hour value every 15s (NOT per-beat), while heavier full-health polling stays at 60s.
- **DONE** (2026-08-20) — Request-layer MTU + packetAck: direct-ring connect requests MTU 247 after
  service discovery and before notify subscription/probing, logging `ok` or safe `fallback`; the captured
  system/packetAck (0x7e) cursor loop uses CRC/shape validation, a bounded callback queue, generation tags,
  comprehensive reset clearing, and worker-thread writes.
  The same worker runs an HR-only 15s current refresh without re-polling all metrics.

### Security
- **DONE** (2026-08-20) — Closed the raw-frame bypass. `sendRawRingFrame()` now fails closed before writing
  to bae80012: it accepts only a complete canonical single-frame envelope with a valid length and transport
  CRC, then applies the same pairing/host/firmware subCmd blocklist used by `buildRingFrame()`. A captured
  otaStart (or other blocklisted command) can no longer bypass the policy gate.

### Release / repo
- **DONE** (2026-08-20) — Honest **README** now documents first-time setup in Even, the explicit glasses
  disconnect and Bluetooth handoff, single-central ring contention, and the disable-don't-uninstall rule.
  This completes gate **T4** alongside the onboarding wizard.

---

## NEXT — queued, unblocked

### Standalone from the Even app (community-publish gates)
Even is currently a HARD dependency (first-time ring pairing/provisioning, glasses onboarding routes through
Even's disconnect step, ring firmware). Guidance to users: **disable, don't uninstall.** The pairAuth
session-open frame is hardcoded/universal (not per-device).
- **TODO** — **T2 Ring pairing independence** — reverse advStart (0x0a host-MAC bind) + setAlgoKey (0x0c
  provisioning) so Hermes can do first-time ring pairing/provisioning itself (currently blocklisted,
  FaceclawBleCommunicator.java ~1700–1746). Prerequisite to T1 and independently valuable. RE work.
- **TODO** — **T3 Non-Even glasses onboarding** — a glasses pair/flash path that doesn't route through
  Even's disconnect step.
- **DONE** (2026-08-20, on-device verified) — Ring firmware **version display**: Hermes sends the safe,
  non-blocklisted `deviceInfo(0x02)` GET after session open, decodes the first NUL-padded 16-byte ASCII field,
  and displays the live version in Glasses Controls. Verified on the A32 against the connected R1 (`2.2.8.0002`);
  the captured response was CRC-valid and no firmware-write behavior was added.

### Platform / vision groundwork
- **AUDIT DONE / PUBLICATION BLOCKED** (2026-08-20) — **MCP / skill review** inventoried 24 phone-served
  tools and designed a bounded shell-owned `glasses.render_view` v1. Publication is NO-GO until the external
  bridge has authenticated transport/peer proof, pre-auth and stale-connection rejection, turn-generation
  authorization, enforced JSON Schemas, correct MCP lifecycle/errors, window-owned registrations, and
  cancellation/idempotency for side effects. Tool-specific holds include proactive alert/timer mutation,
  over-broad Roam reads, and disconnected-success paths. Full report:
  `notes/mcp-skill-publish-audit-2026-08-20.md`. Do not publish a `hermes-g2-glasses` skill before these gates.

### Smaller backlog (do not lose)
- **TODO** — S5 Ring pair/unpair + direct phone-to-ring link management UI (ties to T2).
- **IMPLEMENTED / HARDWARE VALIDATION BLOCKED** (2026-08-20) — S6 Ring-health contention UX: direct R1 failures and glasses write failures surface
  an Even-app warning on Main, Controls, and Health with Open settings + Retry R1 actions. Opening settings
  starts a bounded release poll; once Even releases Bluetooth, the warning clears and R1 retries automatically.
  Static review passed, but real contention/release could not be exercised because launching Even immediately
  requested glasses re-pairing; that prompt was refused and Even was re-disabled/revoked. Operational GO remains open.
- **TODO** — S7 Voice-assistant bridge validate end-to-end ("Hey Even" → bridge → agent); bridge now works,
  path was never hardware-tested.
- **DEFER** — S3 `foregroundServiceType` refinement (FaceclawForegroundService.java ~110) — current
  over-claim is SAFE; a wrong gate could UNDER-claim and break voice capture. Leave until exercisable on-device.

### Release / repo
- **TODO** — Q: Debug preview APK (from the excised staging tree) + GitHub Release + CHANGELOG; then the held
  awesome-list PRs. Keep the public repo evolving (currently at 6f8556b).

---

## LATER — blocked, gated, or visionary

### T1 Ring firmware update — **BLOCKED (do not build)**
- **BLOCKED** — Ring uses **Nordic Secure DFU** (service 0000fe59, buttonless char 8ec90003) enforcing
  ECDSA-P256 signature verification. Custom/patched images are impossible without Even's private key; the
  most achievable action is re-pushing Even's OWN signed image (zero custom value, unrecoverable-brick risk).
  No image source (auth-walled Even cloud check_firmware) and no captured DFU flow. **DO NOT build standalone
  ring firmware update.** Feasibility design doc: `notes/ring-firmware-update-design.md` (commit 00f9940).
  Two actionable follow-ups it surfaced live as their own items: firmware-version display (NEXT) and the
  `sendRawRingFrame` blocklist-bypass fix (NOW / Security).

### BLE-command features — GATED track (need blutter + proto extraction)
Semantics known, wire bytes not. Everything else ships without new BLE bytes; these wait.
- **RESEARCH** — Ring reboot (powerControl 0x12): payload = BleRing1PowerCtlType ordinal (enum also has
  powerOff / factoryReset / dfu) — LOW confidence, MUST NOT guess. Get the byte via a Dart-AOT disassembler
  (blutter on libapp.so) or a btsnoop sniff (Knox-blocked on A32). Build UI gated, defer the send.
- **RESEARCH** — Glasses reboot (DeviceSettings proto `quickRestart`) + screen distance/depth
  (G2Setting `setGlassGridDistance` / `setGlassGridHeight`): need G2 protobuf field numbers (dump proto
  descriptors from the APK) **and** a BleG2 Proto transport in Hermes (Hermes drives glasses via EvenHub,
  not the Proto DeviceSettings/G2Setting service). Bigger lift = a "G2 Proto transport" sub-project that
  also unlocks many other glasses settings.
- **RESEARCH** — O2 Hotword-in-firmware: custom hotword on reflash? "Hey Even" is a NationalChip GX8002B NPU
  model outside CFW scope; custom PHRASE = phone-side sherpa KWS only (deferred XL). Custom ACTION already ships.

### Vision — MCP-driven glasses display
- **DESIGNED / BLOCKED ON MCP HARDENING** — Hermes renders dynamic cards/dashboards to the glasses via MCP (e.g. Home Assistant
  "what's on in the living room" → a control dashboard; Starling "recent transactions" → a compact statement).
  V1 is specified as one shell-owned in-process window with opaque identity, revision checks, TTL, strict bounded
  text/key-value/progress/divider blocks, no raw pixels/coordinates/URLs/scripts, and no proactive wake/focus.
  Gesture events remain a later extension. Do not implement/publish until the audit's bridge/registry blockers close.

### Other deferred
- **RESEARCH** — **Automate Even firmware tracking + CFW re-patching.** Even ships new glasses firmware
  periodically (e.g. a release the morning of 2026-08-20); each stock release likely needs decompile/patch
  to regenerate an up-to-date Hermes CFW, else CFW drifts behind stock. Idea: an automated Hermes job that
  watches for new Even firmware, fetches + decompiles/patches, re-applies the CFW patch set, and emits an
  updated CFW image (with a verify/diff step before publish). Candidate for the automated-agent (cron) track;
  future, not scheduled. **API RE (2026-08-20):** the Even app downloads updates as an MD5-named zip to
  `/sdcard/Android/data/com.even.sg/files/evenTemp/` (pull it before flashing). The backend is gin-vue-admin
  (JWT `iss=qmPlus`, `aud=GVA`); auth is an `x-token: <jwt>` header. Endpoints
  `https://api.evenrealities.com/v2/g/check_firmware` and `/v2/g/list_devices` accept the JWT but return
  403 "Your device went wrong" without the app's extra device-identifying params/headers. Concrete next step:
  a one-time TLS intercept (mitmproxy or frida) of the app's real check_firmware request to capture those
  params before a headless cron can poll for new firmware.
- **RESEARCH** (high value) — **Reverse-engineer the R1 ring firmware (Ghidra).** Captured the Even OTA
  artifact today (2026-08-20): a Nordic nRF DFU zip (application.bin + application.dat + manifest.json),
  nRF52 ARM Cortex-M, build Aug 14 2026, version banner 603MV1.9.3. Confirmed it is the R1 RING firmware
  (397 ring-specific strings vs ~0 glasses). It carries the actual sleep/activity/HR algorithms and frame
  formats: a leaked format-string literal names the 10-minute activity record layout verbatim,
  "activity span multi 10min bucket, ts,dur,st,et,steps,act". Disassembling in Ghidra is the DEFINITIVE way to
  crack the remaining decoders (sleep cmd=6, calories, activity/steps, HR/HRV/SpO2 record layouts) rather than
  inferring from ground truth. Recommended path to close out the NOW / Health decode items. Binary stored
  privately outside the repo (see Operational notes); never commit it.
- **TODO** — Consolidate health data into a **persistent MCP store** (not per-push sessions).
- **BLOCKED** — WhatsApp in-app client. Engine, pairing UI, and plumbing all DONE (nodejs-mobile + Baileys 7
  embedded, verified in-app), but pairing is blocked by an upstream **April-2026 WhatsApp/Baileys protocol
  regression** (`link_code_companion_reg` → 400 bad-request; Baileys #2488, closed "not planned", no fix).
  Batches 3–6 (need a live link) on hold. Options: shelve until upstream adapts / route via the existing
  agent-bridge QR link (reintroduces the laptop bridge) / monitor Baileys for a fix.
- **DEFER** — R: Latency deeper — move ring link off the display worker thread; non-blocking wake barrier;
  shorter waitForFrameFinished. (Quick wins already landed.)

---

## Recently landed (this session — full detail in the archive)
- **Read-only R1 firmware-version display — DONE** (2026-08-20, verified on-device): added the safe
  `system/deviceInfo(0x02)` GET after session open, decoded its first NUL-padded 16-byte ASCII field, and surfaced
  it in phone Glasses Controls. The A32 received a CRC-valid ack and rendered `R1 firmware: 2.2.8.0002`; 119 tests,
  TypeScript typechecking, and the Android debug build pass. No firmware/DFU write path was added.
- **Honest setup README / T4 — DONE** (2026-08-20): first-time users are told to provision in Even, disconnect
  the glasses, release Even's Bluetooth access, keep the app installed for maintenance, and then onboard in
  Hermes. The README and in-app wizard now tell the same story.
- **Raw ring-frame security gate — DONE** (2026-08-20): raw captured-frame replays now validate the envelope,
  inner length, and transport CRC and consult the shared system-command blocklist before any BLE write.
  Regression coverage, all 114 tests, typecheck, and a debug Android build pass.
- **Ring protocol byte-verified by firmware RE — DONE** (2026-08-20): frame envelope + both CRCs (CRC-32C and
  CRC16/MODBUS), the command table, and the HR/HRV/SpO2 record layouts were reproduced against real ring
  notifies, confirming the existing decoder and the buildRingFrame CRC-32 work. Byte-verified spec captured
  privately (see NOW / Health).
- **Activity decoder fail-closed gate — SUPERSEDED by confirmed cmd=5 decode** (2026-08-20): the earlier
  unvalidated stride-7 interpretation was correctly gated off; the now-verified slot/steps/active/total layout
  replaced it before values were re-enabled.
- **HUD heart re-wired — DONE** (2026-08-20): the glasses HUD top-bar heart had lost its data wiring in an
  earlier "-- unless a live value exists" revert (the revert removed the only code feeding it). Re-wired in
  `app/apps/health/health-app.ts` to push `ringHealthStore.snapshot().currentHr` (the live spot value; "--"
  when null) on every ring-store change. No hourly-average fallback, since that is not a live reading.
- Health: R1 ring HR/HRV/SpO2 daily-record DECODER fixed (ae9a4e0); hourly persistence/accumulation
  `app/health/health-hourly.ts` (cb5d5f2); rich Health tab — readiness hero ring, 24h HR + trend charts,
  consent-gated 3h Hermes sync, real-file JSON export via FileProvider (003ee43, ac28d5e). Golden-vector tests.
- 4-tab shell (e6f1b04), Even Health dashboard (147fa0d).
- **Onboarding wizard — DONE** (52f6d16): 5 steps (welcome · disclaimer · honest "How Hermes works" Even
  hand-off · permissions [BLE / notification-access / battery, live Granted ticks] · firmware choice) with
  progress dots; reuses flash/config/unpair. Verified on-device via a reversible onboarding-flag flip; 100
  tests pass. Delivers gate **T4 (honest onboarding)** — only the truthful README remains under T4.
- **Preview mode: exit path + anonymous mock data — DONE** (e788adc, verified on-device in a fresh preview
  install): was a one-way door with an empty UI. Settings now has an "Exit preview mode" control (deletes all
  demo data, clears the flag, re-onboards); preview mode seeds anonymous demo health (readiness / HR / 24h
  chart / trend + a mock ring snapshot for the HUD), wiped on exit.
- **Double-tab-bar fix + wizard visual polish — DONE** (52c2d1b, verified on-device): exit-preview now resets
  the ROOT frame, so onboarding is full-screen and Finish lands a single shell; wizard cards centred, per-step
  icons, softer text, em-dashes scrubbed from onboarding/firmware strings.
- **Sibling first-run pages carded — DONE** (63e070e): onboarding-firmware-check, onboarding-unpair, and
  onboarding-flash now use the same card+icon treatment as the wizard. Caveat: their on-device render still
  needs confirming on a real flash flow (they require a glasses connection to reach).
- **Persistent Health side card (glasses) — DONE** (185bf6d): pinned under the Apps/launcher card, shows a
  live ring-vitals summary (HR / ring battery / SpO2 / HRV / steps); long-press → "Hide health tab", and the
  Apps card's long-press offers "Unhide health tab" when hidden; hidden state persists (health-tab.json).
  Typecheck clean, 109 tests pass, window:health surface renders live on the connected glasses; Ben now
  driving the on-glasses UX check.
- **Health side card redesign — DONE** (770a1b8, verified rendering on the glasses): regular 288px band
  filled with a readiness hero (score + verdict + confidence + filled bar), a large HR readout with pulse
  icon and resting/range context, a 24h HR range chart (reuses the phone's buildHrDayBars, fills as hourly
  data accumulates), and a bottom metric strip (ring % / SpO2 / HRV / steps).
- **Algorithmic calorie estimator — DONE** (a5fa8bc, 9ef956c): HR-based Keytel (2005) estimate summed over
  accumulated hourly HR, reporting **ACTIVE** calories (burn above the resting-HR baseline) — the earlier
  total-EE version over-read (~1324 kcal on a sedentary day). Persisted weight/age/sex profile (Settings >
  Health profile, key `health.profile.v1`, generic-adult default) and an "Active kcal *" tile (the * flags it
  as an estimate). **Phone-tab parity:** the phone Health tab now shows the same Active kcal + Steps tiles as
  the glasses card. New files: app/health/calories.ts (pure, tested), app/native/calorie-profile.ts,
  app/phone-ui/health-profile-{page,view-model,page.ts}. Docs: notes/calorie-estimation.md. NOTE: a stand-in
  estimate, not the ring's own calories value (that decode path stays open under NOW → Health).
