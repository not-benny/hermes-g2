# WhatsApp link-code regression investigation (2026-08-21)

## Conclusion

The April failure is reproducible from the embedded client configuration and Baileys source contract, but it is not evidence of an unfixable cryptographic protocol break. Hermes embeds `@whiskeysockets/baileys@7.0.0-rc13` and configures `browser: ['Hermes G2', 'Chrome', '120.0']`. Baileys rc13 constructs the stage-1 `companion_platform_display` as `${browser[1]} (${browser[0]})`, therefore Hermes sends `Chrome (Hermes G2)`. WhatsApp's stricter April 2026 `companion_hello` validation rejects non-canonical platform labels with `<iq type="error"><error code="400" text="bad-request"/></iq>`.

This is the exact failure signature recorded in Baileys issue [#2560](https://github.com/WhiskeySockets/Baileys/issues/2560) and the proposed fix in [PR #2559](https://github.com/WhiskeySockets/Baileys/pull/2559): normalize the pairing-only platform display (for example `Chrome (Mac OS)`), await the IQ response instead of using fire-and-forget `sendNode()`, and reject on a server error rather than returning a plausible but unregistered code. The current app's retry loop cannot repair this: it retries the same invalid stage-1 request up to 20 times.

## Evidence and affected versions

- Hermes source: `App_Resources/Android/whatsapp-node/main.js:62-72` uses the custom browser tuple; the installed package is confirmed by `node_modules/@whiskeysockets/baileys/package.json` as `7.0.0-rc13`.
- Installed rc13 source: `lib/Socket/socket.js:629-645` emits `companion_platform_display` as `Chrome (Hermes G2)`; `lib/Socket/socket.js:764-825` persists/returns the code immediately after `sendNode()` without waiting for the matching IQ result.
- Baileys [#2488](https://github.com/WhiskeySockets/Baileys/issues/2488) initially reported a missing `pair-success` after `companion_finish` against rc9/master, but its maintainer update says the reproducer was incomplete: a required `515 restartRequired` reconnect was omitted. The issue was closed `not planned`; it is not confirmation of the original claimed protocol regression.
- Baileys [#2559](https://github.com/WhiskeySockets/Baileys/pull/2559) documents the canonical-label/400 failure and includes tests and a downstream validation. At investigation time it remains an open PR, not a released fix.
- Baileys [#2737](https://github.com/WhiskeySockets/Baileys/issues/2737) reports a later July server-side pairing change (`companion_reg_refresh`) affecting QR and pairing flows, and separately confirms the same secondary 400/reporting bug. It states that rc13, rc14, and master contain no `companion_reg_refresh` handler. This is a distinct later blocker from Hermes's immediate April stage-1 rejection.
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
- Do not treat the later `companion_reg_refresh` report as solved by the canonical-label patch. If WhatsApp still sends that notification after stage 1 is fixed, upstream must implement the required refresh action; no confirmed Baileys fix or timeline was found.
- Confidence: **high** for the Hermes-specific stage-1 400 diagnosis; **high** that rc13 returns an optimistic code; **medium** for the later July protocol blocker and its eventual workaround because upstream issue #2737 remains open and explicitly unresolved.

**Answer to the roadmap question:** upstream provides a viable path to restore pairing for Hermes's April 400 (`canonicalize platform + await/reject the companion IQ`), but no released upstream fix was confirmed at this investigation date. Upstream does **not** yet provide a confirmed viable path for the separate later `companion_reg_refresh` pairing break; keep live-link batches gated and monitor #2559/#2737.

### Upstream links

- https://github.com/WhiskeySockets/Baileys/issues/2488
- https://github.com/WhiskeySockets/Baileys/issues/2560
- https://github.com/WhiskeySockets/Baileys/pull/2559
- https://github.com/WhiskeySockets/Baileys/issues/2737
- https://github.com/WhiskeySockets/Baileys/releases/tag/v7.0.0-rc14
- https://www.npmjs.com/package/@whiskeysockets/baileys
