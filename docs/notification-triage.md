# Local notification triage

Hermes G2 classifies mirrored Android notifications on the phone before deciding whether to interrupt the glasses. Observed notification title, body, sender and Android key remain volatile. A selector the user intentionally authors for a sender/channel/category rule is bounded local app-private configuration (at most 256 rules and 32 KiB); Hermes never infers observed senders into persisted rules. The policy engine does not call an assistant, upload notification data, or log notification content.

## Precedence and defaults

The first matching rule wins:

1. sender within an app
2. channel within an app
3. category
4. app
5. default

Calls and alarms default to Urgent; other accepted notifications default to Immediate. Phone-side Notification Apps settings retain the existing allow/block toggle and add a per-app priority cycle: Default, Immediate, Digest, Urgent, or Mute. “Reset app priorities” removes all per-app overrides. Advanced sender/channel/category rules use the same local settings store and are bounded to 256 entries.

## Interruption policy

- Urgent notifications may bypass quiet hours, but never bypass the global or per-app hard rate caps.
- Immediate notifications open the existing glasses detail modal.
- Digest notifications, quiet-hour notifications, updates inside cooldown, and rate-cap overflow enter the local digest queue.
- Exact duplicates are ignored; same-key updates replace their queued revision rather than creating another entry.
- The queue is capped globally and per app. Digest selection uses deterministic round-robin app ordering so one noisy app cannot monopolize a burst.
- Android group summaries and empty notifications remain excluded; children are authoritative.
- Removed Android notifications are deleted from active and queued Hermes state immediately. Dismiss and clear-all tombstones prevent late callbacks from resurfacing stale items.

Quiet hours default to 22:00–07:00. Digest wake-up is deliberately inexact: a one-minute in-process tick and every notification event opportunistically process due work. A late tick is allowed; elapsed-time deadlines prevent wall-clock or timezone changes from delivering early. No exact-alarm permission is required for digest behavior.

## Glasses UX

Immediate detail views include a “Why” line. A due digest opens one modal listing current items and their reasons. Scroll selects an item, click reviews it through the existing safe detail/actions UI, and double-click dismisses the digest modal. Removed items disappear because the layer resolves Android’s current active set on every paint.

## Persistence and privacy

Only a small aggregate JSON record is persisted: schema version, save time, active count, queued count and clear-operation count. It contains no Android key, package, app label, channel, sender, title, body, line, action, group or content fingerprint. Queue content is reconstructed only from currently active Android notifications; process restart deliberately does not wake the glasses or resurrect stale digest content. Android backup remains disabled.

The previous production icon-debug path has also been removed: notification icons are no longer written to external app files, and package/icon details are no longer logged.

## Verification

Pure reducer tests cover precedence, quiet-hour boundaries, exact duplicates, same-key updates, removal, dismiss tombstones, rate caps, per-app fairness, digest timing, empty content, group summaries, restart, bounded privacy-safe persistence, clear-all idempotency, wall-clock rollback and timezone changes. Android/source integration tests pin post/removal callback wiring, current-key snapshots, exposed policy metadata, phone controls, digest UX and reason display.
