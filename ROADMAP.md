# Hermes G2 roadmap

Current as of 23 August 2026. The current product state is defined only in
[`STATUS.md`](STATUS.md).

## The one active milestone

### v1.0.0-preview.3 — Owner Hermes Loop

**Goal:** prove the existing private Hermes product, without adding features, on
the owner's Fold7, already-provisioned G2, optional R1, and one real licensed
Hermes gateway.

[Issue #59](https://github.com/not-benny/hermes-g2/issues/59) is the sole tracker.
Until it closes, new work is limited to a failed acceptance item or a P0/P1
security, privacy, data-loss, or hardware-safety finding.

#### Acceptance checklist

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
- [ ] Confirm G2 optical readability and R1 battery/health polling during the
  same run; R1 sleep is not part of this milestone.
- [ ] Check Fold7 cover and unfolded layouts and the critical TalkBack path. Do
  not expand this into a general phone matrix.
- [ ] Review package-filtered logs and app storage for credentials, prompts, raw
  tool payloads, transcripts, health samples, or device identifiers. None may be
  retained or exposed by the companion path.
- [ ] Put one concise pass/fail evidence report on issue #59, update
  `STATUS.md`, and tag the exact source only after every item above passes.

#### Exit state

Preview 3 remains an internal owner artifact. Its completion does not enable the
protected publication job, authorize a new signing identity, or claim public
support.

## Deferred, not active backlog

- Production signing, package/data migration, Play Store or public distribution.
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
