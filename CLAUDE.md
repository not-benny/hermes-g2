# Repository instructions for coding assistants

Hermes G2 is a NativeScript/TypeScript and Java Android application for Even
Realities G2 glasses, with direct R1 ring-health support.

## Canonical source

Work from `main`. Historical `hermes-g2`, `integration/`, `work/`, `wt/`, `fix/`,
and dated cleanup branches are archival after the 21 August 2026 consolidation.
Create a focused branch from `main` for new work.

## Layout

- TypeScript/NativeScript: `app/`
- Android/Java/BLE: `App_Resources/Android/src/main/java/com/faceclaw/app/`
- Host tests: `tests/`
- Maintained public docs: `README.md`, `DEVELOPMENT.md`, `docs/`
- Detailed research and gates: `notes/`
- Source-only G2 firmware research: `firmware-research/`

## Validation

Use the declared dependencies and JDK 21:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Run focused tests while iterating, then the full suite. Keep protocol and
lifecycle helpers Android-free where practical so they can be exercised under
Node. Distinguish host tests, compilation, install, launch, and hardware evidence.

## Change discipline

- Inspect the exact diff and stage only intended paths.
- Do not overwrite a newer lifecycle or safety implementation with an older task
  branch merely to resolve a conflict.
- Preserve fail-closed validation, cancellation, ownership, generation, privacy,
  and destructive-command gates.
- Update user documentation and regression tests with behaviour changes.
- Run `git diff --check` before publishing.

## Safety and private data

Never perform or add R1 pairing ownership, NVM provisioning, DFU/OTA, reset,
wipe, pair-delete, host rebinding, power-control, or destructive raw commands
without a separately approved task that closes every documented gate.

Do not publish a public MCP skill or untrusted remote rendering surface while the
transport, server identity, licensing, credential, generic-client, privacy, and
real-device gates remain open.

Never commit credentials, device identifiers, private IPs, health exports,
Bluetooth captures, proprietary firmware binaries, pulled Android settings,
completed consent records, or anything from `ground-truth-private/`.