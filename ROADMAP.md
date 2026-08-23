# Hermes G2 roadmap

Current as of 23 August 2026. The current product state is defined only in
[`STATUS.md`](STATUS.md).

## The one active milestone

### v1.0.0-preview.3 — Owner Hermes Loop

**Goal:** prove the existing private Hermes product, without adding features, on
the owner's Fold7, already-provisioned G2 already running the reviewed owner
custom firmware, optional R1, and one real licensed Hermes gateway. Stock
firmware remains phone-preview-only; this milestone authorises no flash or
recovery action.

[Issue #59](https://github.com/not-benny/hermes-g2/issues/59) is the sole tracker.
Until it closes, new work is limited to a failed acceptance item or a P0/P1
security, privacy, data-loss, or hardware-safety finding.

#### Acceptance checklist

- [ ] Before any connected service or device action, complete the two-stage
  authorization gate in
  [`notes/direct-assistant-app-tools-hardware-test-matrix.md`](notes/direct-assistant-app-tools-hardware-test-matrix.md):
  record build-only GO, then re-confirm operational GO for the exact clean source
  SHA, APK SHA-256/package, named Fold7 and USB serial, G2 firmware, and every
  permitted action. Obtain explicit owner approval for microphone, optional R1
  health, and evidence capture. Exclude pairing, provisioning, firmware,
  recovery, reset, wipe, data clear, permission changes, and unrelated data.
- [ ] Configure one certificate-validated, authenticated, licensed private
  Hermes gateway. Record versions and capabilities without recording secrets.
- [ ] Build the exact current `main`, pass CI/typecheck/release-surface checks,
  record the source commit and APK SHA-256, and upgrade-install on the Fold7
  without clearing app data or changing signing identity.
- [ ] Prove the phone companion against that gateway: truthful status, session
  list and refresh, resume, cancel, new voice session, and usage/cost only when
  the provider advertises those capabilities.
- [ ] Prove the glasses cockpit against the same gateway: projected session,
  streamed response, one bounded tool result, reviewed answer/deny, steering,
  interrupt, and terminal state.
- [ ] Prove the core voice loop: wearer capture, remote response, background tool
  work, overlay restoration, and honest empty/error outcomes.
- [ ] Prove exact ownership through screen-off, G2 reconnect, gateway restart,
  app restart, stale reply, duplicate operation, and offline recovery.
- [ ] Confirm G2 optical readability. If the optional R1 and health access were
  explicitly authorised for this run, also confirm battery/health polling; R1
  sleep is not part of this milestone.
- [ ] Check Fold7 cover and unfolded layouts and the critical TalkBack path. Do
  not expand this into a general phone matrix.
- [ ] Review package-filtered logs plus companion traffic, operation journal,
  and cache for credentials, prompts, raw tool payloads, transcripts, health
  samples, or device identifiers. None may be retained or exposed by the
  companion path. If R1 access was authorised, separately confirm decoded health
  samples exist only in the declared ring-health store and are not duplicated
  into companion storage.
- [ ] Put one concise pass/fail evidence report on issue #59, update
  `STATUS.md`, and tag the exact source only after every item above passes.

#### Exit state

Preview 3 remains an internal owner artifact. Its completion does not enable the
protected publication job, authorize a new signing identity, or claim public
support.

## Deferred, not active backlog

- Production signing, package/data migration, Play Store or public distribution
  ([issue #69](https://github.com/not-benny/hermes-g2/issues/69)).
- Public MCP/skill publication or untrusted remote rendering.
- Home Assistant mutation, WhatsApp, new integrations, and new applications.
- G2 firmware/recovery, R1 provisioning/ownership/DFU, and R1 sleep decoding.
- Broader phone, firmware, or user support.
- Further visual redesign or feature expansion that is not required by a failed
  Preview 3 acceptance item.

There is intentionally no milestone after Preview 3 yet. Choose it only from
evidence gathered during the owner loop, rather than reopening the historical
branch backlog.

## Working rule

`main` is the only development base. Use one short-lived branch and one pull
request at a time. Put validation evidence on issue #59 instead of creating new
dated handovers or competing roadmap sections. Historical detail remains in Git
history, merged pull requests, component documentation, and research notes.
