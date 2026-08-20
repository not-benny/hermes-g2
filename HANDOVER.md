# Hermes G2 handover (2026-08-20)

A snapshot of project state, what was accomplished, what is pending, and how to
pick the work back up on a new machine. Pairs with `ROADMAP.md` (kept outside the
repo) and the private `DECODE-SPEC.md` (see "Out-of-repo data").

## 1. What this project is

Hermes G2 is an unofficial Android interface for the Even Realities G2 glasses
(NativeScript UI + Java BLE), plus a decoder for the Even R1 ring's health data.
It talks directly to the ring over BLE and renders a glasses UI, health cards, a
HUD, voice, notifications, navigation, and more.

## 2. Where things live (READ THIS BEFORE MOVING MACHINES)

The git repo is `hermes-faceclaw` (pushed to the private `not-benny/hermes-g2`).
Three important things live OUTSIDE the repo and do NOT travel via git clone:

- `../ground-truth-private/` — Even health-export CSVs, btsnoop captures, the R1
  ring firmware (zip + extracted `application.bin`), the RE harness `fwre.py`, and
  the full `DECODE-SPEC.md`. Personal health data + proprietary firmware. Copy by
  hand when moving machines.
- `../ROADMAP.md` — the living roadmap (a plan agent keeps it current).
- `secrets.local.md` — dev identifiers (device IP, BLE MACs, git identity, Even
  API token location). Gitignored; recreate on the new machine.

In-repo, the ring-health work is:
- `app/health/ring-parser.ts` — frame reassembly, CRC-32C transport, inner-frame
  unwrap, `decodeDailyData` (HR/SpO2/HRV records), `decodeRingBattery`.
- `app/health/ring-health-store.ts` — decodes pushes into a snapshot; activity is
  gated off (see below).
- `app/health/health-hourly.ts`, `health-insights.ts`, `health-history.ts`,
  `calories.ts` — hourly persistence, readiness/HR insights, Keytel calorie fallback.
- `app/apps/health/health-app.ts` — the glasses Health side card + HUD heart feed.
- `App_Resources/.../FaceclawBleCommunicator.java` — ring connection, `probeRingHealth`,
  `sendRingCommand`, `buildRingFrame` (CRC-32 correct; do not regress to random bytes).
- `notes/ring-wire-format-2026-08-20.md` — the confirmed BLE wire format (public-safe).
- `notes/ring-groundtruth-2026-08-20.md` — the ground-truth harness + CSV schemas.
- `tests/ring-parser.test.mjs`, `ring-health-store.test.mjs` — decoder regression tests.

## 3. What the ring-health/RE effort accomplished (this session)

- Ring health data DECODED and confirmed by reverse-engineering the ring firmware:
  frame envelope byte-verified (CRC-32C Castagnoli over the transport, inner
  CRC-16/MODBUS), command table confirmed (health module=2; HR=1/SpO2=2/temp=3/
  HRV=4/activity=5/sleep=6), HR/SpO2 = `[hour][avg][max][min]` u8, HRV = u16.
- Live HR resolved: the daily-frame header `current` field (offset 11) is the live
  current-hour reading, routed to `store.currentHr` and the HUD. Finest resolution
  is hourly; there is no per-beat stream. The old "no live HR" was a mix of an
  already-fixed CRC-32 write bug, Even-app ring contention, and a HUD wiring
  regression (all resolved).
- Ground truth captured: the Even app's own 7-CSV health export + a btsnoop of the
  Even<->ring traffic, now the validation harness for every decoder.
- R1 ring firmware extracted (Nordic DFU, nRF52840) and reverse-engineered with a
  capstone harness (`fwre.py`) using format-string anchoring. Full byte-level
  `DECODE-SPEC.md` written (private).
- Activity/steps/calories decoder GATED OFF: its byte layout was an unvalidated
  guess, so steps now render "--" honestly until `cmd=5` is properly decoded.

## 4. What is pending (see ROADMAP.md for the full list)

- `cmd=5` activity/steps/calories byte-layout RE. UNBLOCKED: we have the 10-minute
  ground truth (steps.csv, calories.csv with resting/active split, 144 slots/day).
- `cmd=6` sleep decode. Schema + stage map known (0=Wake/1=REM/2=Light/3=Deep, 30s
  epochs, total/wake/rem/light/deep seconds, body_temp_delta). Needs a real overnight
  capture correlated to a live DB session. `decodeSleep` stays a throwing stub.
- Request-layer: request MTU 247 before probing; implement the `packetAck` (0x7e)
  loop to pull multi-fragment batches.
- Even firmware auto-track cron: the check_firmware API accepts the account JWT
  (`x-token`) but returns 403 without the app's device-identifying params; finishing
  it needs a one-time TLS intercept (mitmproxy/frida) of the app's real request.

## 5. Resuming the firmware RE on a new machine

1. Copy `../ground-truth-private/` over (it holds the firmware + `fwre.py`).
2. `pip install capstone` (that is the only RE dependency; no Ghidra needed).
3. `cd ground-truth-private/firmware/re && python3 -c "import fwre; print(fwre.find_str('sleep'))"`.
   Technique: firmware log/format strings are referenced from the code that builds
   the matching record; `fwre.xrefs_to_str` -> `fwre.show(func)` reveals struct
   offsets (ldr/str Rx,[Ry,#off]). See `DECODE-SPEC.md` for the confirmed layouts.

## 6. Capturing fresh ground truth (needs the device + Even app)

Full method is in `notes/ring-groundtruth-2026-08-20.md`. Summary: enable full
btsnoop (Samsung path `/data/log/bt/btsnoop_hci.log`), briefly re-enable the Even
app (then re-disable + re-revoke BT per the standing rule), reproduce the metric,
pull the log + the Even app's built-in health-data export zip, and validate.

## 7. Conventions

- The repo is private now; commits use the trailers (Co-Authored-By + Claude-Session)
  and the `not-benny` identity. A fresh PUBLIC repo will be curated later, at which
  point the public scrubbing rules (no personal data, no MACs, no tokens) reapply.
- Even app: disable-don't-uninstall (it owns pairing/firmware/ground-truth). Keep its
  Bluetooth revoked; re-enable on demand only, then re-revoke.
- Never commit `ground-truth-private/`, the Even API JWT, or raw health captures.
