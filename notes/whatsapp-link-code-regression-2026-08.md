# WhatsApp link-code regression investigation (2026-08-21)

## Re-audit on 25 August 2026

The embedded linked-device design is still not ready to enable. The original
failure is narrower than a general multi-device incompatibility, but none of its
required fixes is available as a supported app dependency today:

- Baileys PR [#2559](https://github.com/WhiskeySockets/Baileys/pull/2559)
  remains open. Its canonical platform label, awaited `companion_hello` IQ, and
  expected `515` reconnect were validated downstream through a registered,
  open, send/receive session, but the patch is absent from the latest
  `7.0.0-rc14` release.
- Baileys issue [#2737](https://github.com/WhiskeySockets/Baileys/issues/2737)
  remains open for WhatsApp's newer `companion_reg_refresh` notification. The
  demonstrated failure is on QR linking. Its link-code attempt never passed the
  separate stage-1 `400`, so a patched link-code flow is neither proven broken
  nor proven unaffected. The earlier successful downstream validation predates
  the late-July server change.
- Baileys PR [#2765](https://github.com/WhiskeySockets/Baileys/pull/2765)
  is an open, unmerged attempt to implement that refresh stage. It is not a
  dependency Hermes can treat as released behavior.
- The app embeds nodejs-mobile `18.20.4`, while current Baileys declares Node
  `>=20`. The upstream 16 KiB Android build changes are merged, but an official
  compatible nodejs-mobile release remains unavailable through release PR
  [#155](https://github.com/nodejs-mobile/nodejs-mobile/pull/155). The owner Fold must not
  ship an unverified 4 KiB `libnode.so` or an unsupported Node/Baileys pairing.

The only responsible next experiment is an isolated, one-at-a-time proof with
a disposable account and a frozen reviewed source commit. It must prove
stage-1 acceptance, registration persistence, the expected `515` reconnect,
post-July refresh behavior, reconnect after process death, and bounded
send/receive before any app UI or production flag is enabled. It must never copy
or share a live auth directory. The owner's personal number remains out of the
experiment.

WhatsApp Cloud API is not an equivalent fallback: it is a supported business
API and does not link to or mirror the owner's personal chat account. The safe
near-term glasses path is the existing Android notification listener and exact
`RemoteInput` reply action. That covers notification-delivered messages and
replies, not chat history, arbitrary sends, media sync, or a native WhatsApp
replacement.

The embedded engine is also only a pairing prototype today: it exposes health,
status, pair, connect, and event endpoints, not a durable chat list, arbitrary
send, media, or reaction API. A future full client needs a transactional local
message store and Android Keystore-backed credential design before any glasses
or Hermes workflow can depend on it. Baileys is unofficial, and WhatsApp's
[Terms](https://www.whatsapp.com/legal/terms-of-service) make public release an
explicit product/legal risk decision even if the technical proof succeeds.

## Conclusion

The April failure is reproducible from the embedded client configuration and Baileys source contract, but it is not evidence of an unfixable cryptographic protocol break. Hermes embeds `@whiskeysockets/baileys@7.0.0-rc13` and configures `browser: ['Hermes G2', 'Chrome', '120.0']`. Baileys rc13 constructs the stage-1 `companion_platform_display` as `${browser[1]} (${browser[0]})`, therefore Hermes sends `Chrome (Hermes G2)`. WhatsApp's stricter April 2026 `companion_hello` validation rejects non-canonical platform labels with `<iq type="error"><error code="400" text="bad-request"/></iq>`.

This is the exact failure signature recorded in Baileys issue [#2560](https://github.com/WhiskeySockets/Baileys/issues/2560) and the proposed fix in [PR #2559](https://github.com/WhiskeySockets/Baileys/pull/2559): normalize the pairing-only platform display (for example `Chrome (Mac OS)`), await the IQ response instead of using fire-and-forget `sendNode()`, and reject on a server error rather than returning a plausible but unregistered code. The current app's `for` loop cannot repair this asynchronous failure: rc13's first `requestPairingCode()` call returns the generated code before the later IQ 400 is observed, so the normal result is one dead code, not 20 retries. If the call rejects synchronously, the loop can retry the same invalid request, but that does not observe or repair the later server rejection.

## Evidence and affected versions

- Hermes source: `App_Resources/Android/whatsapp-node/main.js:62-72` uses the custom browser tuple; the installed package is confirmed by `node_modules/@whiskeysockets/baileys/package.json` as `7.0.0-rc13`.
- Installed rc13 source: `App_Resources/Android/whatsapp-node/node_modules/@whiskeysockets/baileys/lib/Socket/socket.js:637-639` emits `companion_platform_display` as `Chrome (Hermes G2)`; `:604-650` calls `sendNode()` and returns the code immediately, without waiting for the matching IQ result.
- Baileys [#2488](https://github.com/WhiskeySockets/Baileys/issues/2488) initially reported a missing `pair-success` after `companion_finish` against rc9/master, but its maintainer update says the reproducer was incomplete: a required `515 restartRequired` reconnect was omitted. The issue was closed `not planned`; it is not confirmation of the original claimed protocol regression.
- Baileys [#2559](https://github.com/WhiskeySockets/Baileys/pull/2559) documents the canonical-label/400 failure and includes tests and a downstream validation. At investigation time it remains an open PR, not a released fix.
- Baileys [#2737](https://github.com/WhiskeySockets/Baileys/issues/2737) reports a later July server-side `companion_reg_refresh` change observed after QR scans, and separately confirms the same secondary 400/reporting bug. It states that rc13, rc14, and master contain no refresh handler. The issue's link-code attempt never gets past the separate stage-1 400, so it establishes a current QR-path blocker but does not prove that refresh is required or broken after a canonicalized link-code flow.
- npm registry/API evidence: `7.0.0-rc14` is the latest tag (`2026-07-29`), while Hermes remains pinned to rc13. No release note or merged commit found in the queried upstream release/tag data states that rc14 fixes canonical pairing labels, the 400 response handling, or `companion_reg_refresh`.

## Reproducible diagnosis (without a live link batch)

1. Inspect Hermes's `makeWASocket` tuple: `['Hermes G2', 'Chrome', '120.0']`.
2. Apply rc13's source expression: `browser[1] + ' (' + browser[0] + ')'` => `Chrome (Hermes G2)`.
3. The stage-1 node is `link_code_companion_reg` with `stage='companion_hello'` and that display value.
4. Current upstream evidence records WhatsApp's response as HTTP-like protocol error `400 bad-request`; rc13's `sendNode()` only writes the frame, so `requestPairingCode()` can return/display a code before the error arrives.

No live-link batch was started. This source-level reproduction is sufficient to identify the deterministic client defect and avoids additional WhatsApp pairing/rate-limit churn.

## Recommended path and confidence

- Immediate patch: use a canonical pairing platform tuple/display (e.g. `['Mac OS', 'Chrome', '120.0']`, or the upstream pairing helper once released), and change the dependency to a released version containing the PR #2559 behavior only after verifying its changelog/source. Do not claim that merely bumping rc13 to rc14 fixes it.
- Preserve the existing `515` reconnect handling; it is required after successful pairing and is already present in Hermes.
- Do not treat the later `companion_reg_refresh` report as solved by the canonical-label patch. It is a confirmed QR-path issue and an unresolved risk/unknown for link-code pairing; if WhatsApp sends that notification after stage 1 is fixed, upstream may need to implement the refresh action. No confirmed Baileys fix or timeline was found.
- Confidence: **high** for the Hermes-specific stage-1 400 diagnosis; **high** that rc13 returns an optimistic code; **medium** for the later July protocol blocker and its eventual workaround because upstream issue #2737 remains open and explicitly unresolved.

**Answer to the roadmap question:** upstream provides a viable path to restore pairing for Hermes's April 400 (`canonicalize platform + await/reject the companion IQ`), but no released upstream fix was confirmed at this investigation date. The separate `companion_reg_refresh` issue is confirmed for the QR path and remains an unresolved risk for link-code pairing, not a demonstrated link-code blocker; keep live-link batches gated pending safe validation and monitor #2559/#2737.

## Three-stage proof gate

1. On a no-network host harness, pin and review the exact #2559 commit. Test
   canonical platform generation, awaited IQ rejection, pair-device readiness,
   single-flight pairing, cooldown, credential rollback, and the expected `515`
   reconnect transcript. Remove the twenty-attempt loop.
2. Before account contact, resolve Node 20 and 16 KiB packaging. On Android,
   exercise only a fake engine through cold start, background/foreground,
   process death, corrupt state, restart, and logout cleanup. Production flags
   and release-asset exclusion remain unchanged.
3. Only after explicit approval, make one link-code request for a disposable
   account. Require registered state, `515`, authenticated reconnect, one text
   received, one text sent, process restart, unlink/revoke, and secure cleanup.
   Stop without retry on refresh, `400`, `408`, or `1006`; retain only sanitised
   structural diagnostics. Never use the owner's main account in this proof.

### Upstream links

- https://github.com/WhiskeySockets/Baileys/issues/2488
- https://github.com/WhiskeySockets/Baileys/issues/2560
- https://github.com/WhiskeySockets/Baileys/pull/2559
- https://github.com/WhiskeySockets/Baileys/issues/2737
- https://github.com/WhiskeySockets/Baileys/releases/tag/v7.0.0-rc14
- https://www.npmjs.com/package/@whiskeysockets/baileys
