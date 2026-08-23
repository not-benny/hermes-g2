# Audit remediation — 21 August 2026

Baseline: `f37168cf007450cb2a58513b1f2624aee0b6d6af` on canonical `main`.

## Remediated release boundaries

- Log sentinels prohibit credential prefixes/lengths, WebSocket header values, pairing codes, phone/JID/account identifiers, message/transcript/tool payloads, raw R1 frames, and sensitive exception text. WebSocket diagnostics retain only host/path and header names/presence.
- WhatsApp uses Android `SecureRandom`, discards Baileys protocol logging, and is absent from startup and pairing navigation. Its disabled status and unresolved 16 KiB runtime gate are visible in Settings.
- Credential-bearing settings use Keystore AES-GCM storage with verified migration and physical clear actions. Terminal records, including token-bearing URLs, are encrypted as a unit.
- Calendar reads return `success`, `permission_denied`, `provider_unavailable`, or `query_failed`; only genuine success is cached and empty success is no longer confused with failure. Permission transitions invalidate cache and callers receive defensive copies.
- Foreground-service type claims are driven by explicit active-operation flags. `connectedDevice`, phone `microphone`, and `location` are claimed only for active work, with runtime permission checks for microphone/location; null/empty restarts stop and the service is non-sticky.
- Terminal non-loopback transport is TLS-only. Delayed terminal launch calls revalidate authorization before remote launch and before local window/focus handoff.
- The R1 raw boundary now requires an exact positive allowlist for the known health-session commands and payload shapes in addition to canonical envelope, CRC, lifecycle/generation, and destructive-command denial.
- Permanent CI, CodeQL, Dependabot, SBOM/provenance, hash-verified native inputs, pinned NDK/CMake/NativeScript, monotonic Android metadata, ZIP/private-path checks, and native-alignment checks protect PRs and `main`. PR validation receives no signing secrets and cannot publish an APK; protected signing occurs only after a secret-free `main` build in a separate job that executes no repository source.

## Corrected stale findings

Exact-turn ownership, authenticated app-side WSS enforcement, cancellation, duplicate rejection, and the bounded inert `glasses.render_view` implementation already existed at the baseline. Historical MCP documents that describe those app controls as proposed or missing are superseded for implementation status. A private hostname-verified WSS deployment now closes the private server-identity setup gap, but adapter licensing, generic-client, privacy, credentials, public deployment and real-G2 publication gates remain open.

Current R1 heart-rate/history/activity decoding is implemented. Historical health notes remain snapshots of the pre-implementation investigation. Sleep is still fail-closed pending a correlated type-1 stage/summary frame and absolute timebase.

One owner-unit G2 custom-firmware boot report exists. Installation is
release-disabled because that does not provide recovery or broad compatibility
assurance; flashing and destructive recovery tests remain prohibited without a
separately authorized sacrificial plan.

## Honest limits

- WhatsApp live pairing/reconnect/session ownership was not authorized and remains disabled.
- A 16 KiB device was not available; no hardware compatibility claim is made for stock Node.
- A compatible private WSS bridge endpoint now has server-identity and hello/ack proof, but no generic-client or exact-candidate wakeword → remote agent/MCP → real-G2 execution evidence exists yet.
- R1 provisioning/ownership/NVM/DFU and G2 firmware flash/recovery were not performed.
- Public MCP/skill publication remains NO-GO.

See [`release-security.md`](release-security.md) for the permanent release
contract and [`STATUS.md`](../STATUS.md) for the current operational state. This
dated audit remains evidence, not a roadmap.
