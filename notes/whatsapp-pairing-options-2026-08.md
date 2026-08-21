# WhatsApp pairing options analysis (2026-08-21)

## Recommendation

**Shelve live WhatsApp pairing now, while retaining bridge QR as a separately gated fallback.** Do not resume live-link batches 3–6 and do not enable production pairing during this evaluation. The embedded client has a credible future repair path for the April link-code failure, but the existing Hermes Agent bridge is not a WhatsApp bridge and cannot be substituted by changing a URL or pairing screen.

A bridge QR path is technically feasible only as a new host-side service or an explicitly extended bridge deployment. It is not ready for implementation or operation because it moves the WhatsApp session and long-lived credentials off the phone, adds a network trust boundary, and the currently available sibling bridge is private evaluation infrastructure with plaintext WebSocket transport and unresolved server-authentication/licensing gates.

## Current architecture and failure boundary

- `App_Resources/Android/whatsapp-node/main.js` embeds Baileys in nodejs-mobile. It stores a multi-file auth session in the app-private directory, exposes only a bearer-token-guarded `127.0.0.1:8799` HTTP API, and currently requests an 8-character link code.
- `app/native/whatsapp-node.ts` is the NativeScript loopback adapter; `app/phone-ui/whatsapp-view-model.ts` owns E.164 validation, code countdown, status polling, and the user instruction to enter the code in WhatsApp.
- The known stage-1 failure is deterministic: Baileys rc13 formats Hermes's tuple as `Chrome (Hermes G2)`, which WhatsApp rejects with `400 bad-request`; rc13 can return an optimistic code before the asynchronous IQ error. The existing notes identify upstream PR #2559 as a possible canonical-display/await-and-reject repair, but no released fix was confirmed. Issue #2737 also leaves a post-QR `companion_reg_refresh` risk unresolved.
- `app/assistant/bridge-client.ts` speaks the separate Hermes Agent bridge protocol (`ctl`, `chat`, `mcp`) over outbound WSS. The sibling `hermes-faceclaw-agent-bridge` hosts an OpenClaw/glasses-tool server; it neither exposes WhatsApp pairing nor owns a WhatsApp auth session.

## Options

| Option | Effort | Session/security implications | Operational burden and rollback | Compatibility | Disposition |
|---|---|---|---|---|---|
| Shelve and monitor upstream | Low | Keeps WhatsApp credentials app-private; no new network boundary | Lowest burden; leave UI/engine disabled or clearly gated; rollback is simply retaining the current code and resuming only after proof | Preserves the planned phone-side companion identity and existing `515` reconnect handling | **Recommended immediate action** |
| Repair embedded link-code path | Medium | Same credential boundary; must ensure server IQ errors cannot surface dead codes | Requires a pinned released/frozen Baileys source, source-contract tests, one-at-a-time validation and rate-limit discipline; revert the dependency/source patch without touching any linked session | Best fit for current UI and batches, but `companion_reg_refresh` remains an unknown after stage 1 | **Next technical checkpoint, not yet authorized** |
| New host bridge with QR | High | Host stores WhatsApp multi-file credentials; QR/session secrets traverse a network; requires authenticated encrypted transport, pairing ownership, redaction and host backup/retention policy | Requires a daemon, host persistence/backup, phone relay, reachability and monitoring; rollback requires stopping relay and safely retaining or removing host auth without revoking an established phone session | A new host-owned companion is not automatically compatible with existing in-app sessions or batches; do not reuse/copy app auth state concurrently | **Fallback only after prerequisites** |
| Reuse existing Hermes Agent bridge for QR | Misleading/blocked | Existing bridge is a glasses-agent transport, not a WhatsApp protocol endpoint; current sibling deployment uses plaintext `ws://` and shared token, with server-proof/licensing concerns documented elsewhere | Cannot be safely rolled back as a WhatsApp feature because no WhatsApp interface exists; extending it would enlarge scope and couple unrelated outages | No existing QR UI/API/session contract; incompatible without a new protocol and host implementation | **Reject as a direct shortcut** |

## Minimal bridge design if later authorized

Keep WhatsApp ownership in one host process and never share the app's auth directory between embedded and bridge modes. Define a versioned, authenticated API with these interfaces:

1. `POST /v1/pair/qr` → `{attemptId, qrPayload, expiresAt}`; single active attempt, bounded expiry, redacted logs, explicit user confirmation.
2. `GET /v1/pair/:attemptId/events` (SSE or authenticated WebSocket) → `connecting | qr | connected | failed | logged_out`; no credential material in status events.
3. `GET /v1/status` → bounded state/user identity only; `POST /v1/session/stop` → stop/revoke relay without deleting credentials by default.
4. A phone-side adapter replacing only the current WhatsApp transport contract, plus a UI that displays a bounded QR bitmap/payload and clear host/session ownership. The existing `ctl/chat/mcp` Agent bridge protocol should not be overloaded with WhatsApp frames.

The host service would use the same Baileys connection/update and `creds.update` lifecycle as the embedded engine, but would require a confirmed current QR-compatible Baileys version, an explicit session-directory policy, and a relay for the eventual WhatsApp message/status API. A QR-only pairing proof is not sufficient to claim the full live-link batch contract works.

## Preconditions and validation gates

Before any implementation or production pairing:

- Human owner chooses bridge mode and approves host credential custody, retention, and network topology.
- Resolve the existing bridge's licensing/provenance and replace plaintext/shared-token transport with certificate-validated WSS or an equivalently authenticated tunnel with server proof; add replay, timeout, reconnect, and stolen-token tests.
- Select a released Baileys version or reviewed source commit whose QR flow is tested against current `companion_hello` and `companion_reg_refresh` behavior. Do not infer this from rc14's version number alone.
- Define one owner per WhatsApp session, prevent concurrent embedded/host sockets, and use a fresh test account/number. Never migrate or copy a live auth directory during evaluation.
- Validate in order: static protocol/source checks; fake host/phone relay; one controlled QR pairing; reconnect and restart persistence; message receive/send/status contract; then a single approved live-link batch. Record logs with phone numbers, QR payloads, tokens and message bodies redacted.
- Keep batches 3–6 paused until pairing, reconnect, message flow, and rollback have passed the above gates. A failed attempt must disable the bridge without deleting an established session or silently falling back to embedded pairing.

## Decision checkpoint

At the next upstream review, check Baileys PR #2559/release behavior and issue #2737. If a released embedded repair is verifiable, prefer that lower-risk path. If not, the owner must explicitly authorize the host-credential/network work before a narrowly scoped bridge design task is created. Until then the safe state is shelved pairing, no production QR, and no live-link batches.
