# Changelog

This changelog records user-visible work in the Hermes G2 1.0.0 development-preview release line. It describes verified capabilities and keeps experimental, hardware-blocked, and deliberately unavailable features explicit.

## [1.0.0] - Unreleased

### Highlights

- Hermes G2 is the Hermes-first Faceclaw fork/rebrand: an unofficial Android companion with four tabs for the G2 glasses, including multitasking, notifications, media, controls, and R1 health.
- A five-step onboarding flow explains the Even hand-off, permissions, and firmware choice honestly. Phone-only preview uses anonymous demo data, and its exit control deletes the demo state and returns to onboarding.
- The R1 health dashboard now presents persisted readiness, history, and charts alongside battery, hourly heart rate/SpO2/HRV, confirmed 10-minute steps, and active/total/resting-calorie buckets. JSON export, a glasses Health side card/HUD, and read-only R1 firmware display are included.
- Hermes Agent bridge is the preferred assistant backend, with direct-provider credentials as a separate fallback. The current bridge is suitable only for a trusted, private transport deployment; public MCP/skill publication remains blocked.

### Setup and compatibility

- This is unofficial development software, not an Even Realities product or supported release. First-time G2 and R1 pairing/provisioning and official firmware maintenance still require the official Even app.
- In Even, provision both devices and explicitly disconnect the glasses before using Hermes. Keep Even installed, but close it or remove/revoke its Bluetooth access during Hermes use: the apps compete for the devices, and the R1 permits only one central connection. Restore Even access only when returning to Even.
- Onboarding offers custom-firmware installation or phone-only preview. The full 640x480 glasses UI requires custom firmware.
- Source builds require Node.js 20+, JDK 21, Android SDK 35, NativeScript and Android build prerequisites, plus the required Android NDK and CMake components.
- Bridge setup requires a host and port reachable by the phone and a bridge token. Direct-provider credentials are a separate fallback path and are not used by the bridge.

### Added

- Android notification mirroring with direct reply/actions and configurable notification text sizing.
- Media-source filtering, resume-last behavior, and a now-playing card; configurable event beeps for notifications, replies, errors, timers, and connection events.
- Glasses and phone controls, dark-theme polish, connection-state feedback, and the persistent Health side card/HUD.
- Readiness and health history views, hourly persistence, JSON export, ring-native activity buckets, and anonymous preview health data.

### Changed and fixed

- Current-hour heart rate refreshes every 15 seconds, not per beat; the R1's finest supported resolution is an hourly aggregate. Full health polling remains separate and slower.
- Ring-native health/activity ingestion now requires the expected envelope, CRCs, current-day anchor, and valid shapes; malformed or stale data fails closed. Activity uses confirmed 10-minute steps and active/total calories, with resting calories derived from total minus active.
- Direct-ring reconnect and contention feedback now expose safe retry actions and Even hand-off guidance. MTU negotiation, packet polling, bridge status, reconnect behavior, and bounded lifecycle handling improve recovery without weakening safety gates.

### Security and safety gates

- Glasses flashing accepts only the pinned 2.2.8.4 stock image or its exact reviewed custom derivative. It is not recovery-validated, may void the warranty or brick hardware, requires both lenses powered and nearby, and requires Even to be disconnected.
- Hermes does not build or perform a standalone R1 firmware update: ring DFU is intentionally absent/NO-BUILD. Pairing, host, firmware, power, and destructive ring command families remain blocklisted; raw-frame replay is subject to the same fail-closed policy gate.
- MCP/skill publication is still NO-GO despite the first hardening pass. Remaining blockers are authenticated secure transport/server proof, unique per-turn generation authorization, and cancellation/idempotency for timed-out side effects.
- Do not place or link private health exports, btsnoop captures, proprietary firmware, MAC addresses, tokens, or `secrets.local.md` in public release documentation.

### Known limitations

- Even remains required for initial provisioning and official maintenance. Contention-recovery UX is implemented, but the real Even-release path remains hardware-validation blocked because the re-pair prompt was refused.
- Sleep decoding remains a throwing stub pending a real overnight capture. Skin temperature is sparse/daily, and heart rate is a current-hour aggregate rather than a per-beat stream.
- WhatsApp self-service pairing is blocked by the upstream Baileys `link_code_companion_reg` 400 regression; it is not an operational end-to-end client.
- “Hey Even” → bridge → agent has not completed end-to-end hardware validation.
- Public MCP/skill exposure and generic `glasses.render_view` are not available.
- The pinned custom-firmware candidate and the real flash/recovery flow have not completed hardware or recovery validation.
- Debug APK builds are not reproducible, so a build-instance hash is not a canonical release identity.
