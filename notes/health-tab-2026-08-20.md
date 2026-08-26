# Rich Health tab (2026-08-20)

> **Historical pre-implementation snapshot.** Current HR/current-hour refresh,
> hourly history, anchored timestamps, activity, calories, and persistence are
> implemented. Complete type-1 sleep is now implemented; type 2 remains
> fail-closed. See `ROADMAP.md` and
> `docs/audit-remediation-2026-08-21.md`.

The Health tab is a direct-BLE ring dashboard: it reads the R1 ring's health
frames (no Even cloud), computes insights locally, logs a rolling history, and
can export / share it. Everything renders with plain NativeScript core views
(no chart plugin).

## Files

- `app/health/health-insights.ts` — pure insight math: `heartRateInsights`,
  `sleepInsights`, `temperatureInsights`, `readinessScore`. Graceful
  degradation: a contributor that has no data drops out and the readiness
  weights renormalise over what remains.
- `app/health/health-history.ts` — pure `DailyHealthSummary` logging:
  `summarizeDay`, `upsertSummary` (merge, never erase with nulls),
  `computeBaselines` (14-day, min n=3), `historyToCsv`.
- `app/health/health-store.ts` — pure validation, exact local-calendar retention,
  merge, bounded query, and privacy projection for the v1 document.
- `app/native/health-store.ts` — sole persistence owner. It stores one app-private
  `health.store.v1` JSON document shaped `{ version: 1, updatedAtMs,
  retentionDays: 90, history, hourly, activity, sleep, battery }`; consent remains separately at
  `health.hermes.consent.v1` and defaults off.
- `app/native/health-export.ts` — explicit user file export through Android
  ACTION_SEND/FileProvider. The file contains the full canonical document plus
  `exportedAtMs`; this user action may include local activity slots.
- `app/health/ring-health-store.ts` — live snapshot assembled from notify
  frames; exposes latest-per-metric plus the day's `heartRateSeries` /
  `spo2Series` / `hrvSeries` for the charts. Framework-agnostic (runs under Node).
- `app/phone-ui/health-chart-data.ts` — **pure** chart math (`frac`, `clamp01`,
  `hrZoneColor`, `readinessColor`, `buildHrDayBars`, `buildTrendBars`).
- `app/phone-ui/health-charts.ts` — `renderColumnChart(host, bars, opts)`:
  draws range/column charts as positioned `StackLayout` rects inside an
  `AbsoluteLayout`, reading its own laid-out size (no-op until measured).
- `app/phone-ui/even-health-view-model.ts` — the tab VM. Builds the readiness
  ring gauge + charts on `loaded`, recomputes on every ring-store change, logs
  the day, and repaints. Kept alive across tab-unload (see below).
- `app/phone-ui/even-health-page.{xml,ts}` — layout + `loaded` -> `buildRing`.

## UI

- Connection strip (dot + status + "updated" + battery chip).
- Readiness hero: a 40-dot segmented ring gauge (lit = round(score/100*40)),
  band-coloured, with verdict / confidence / driver chips.
- Readiness trend card: up to 14 days of readiness as band-coloured columns;
  friendly empty state until >= 2 days are logged.
- Heart rate card: current (latest-hour avg until a live stream is wired),
  resting / range / trend, and a **24h range chart** (min..max per hour, hourly
  average marked, resting-HR baseline).
- Sleep card: for a current complete type-1 night, shows the authoritative ring
  score, duration, efficiency, and awake/REM/light/deep totals; otherwise it
  truthfully asks for a recent sync.
- Supporting tiles: SpO2, HRV, Temperature (nightly variation vs baseline),
  Battery.
- Export JSON button + "Allow assistant health access" consent toggle.

## Persistence, retention, migration, and assistant access

The canonical store retains today plus the previous 89 **local calendar dates**.
Validation and pruning run on every read and write: future, stale, malformed,
non-finite, or out-of-range rows are dropped; same-day/hour partial updates merge
without null/absence erasing an existing metric. Data is durable across process
death and app relaunch, but not uninstall or Android app-data clear.

On first load, the adapter independently parses the former
`health.history.v1`, `health.hourly.v1`, and `health.activity.v1` fragments,
normalizes them into `health.store.v1`, and removes the old keys only after an
exact write/read-back verification. Failed or unverifiable writes leave every
legacy key intact. Once a canonical value exists it is authoritative.

Assistant access is off by default. Enabling it exposes the conversation-only,
read-only `health.get_ring_data` phone tool to the configured assistant; there
is no immediate, timer-driven, or background health upload. The defaults are an
inclusive seven-day range ending today with hourly detail omitted. Callers may
request 1–31 days, an end date inside the retained 90-day window, and explicit
hourly detail. MCP activity output contains current-day totals only—never slots,
day-base/timezone metadata, raw frames, device/account identifiers, settings, or
credentials. Revocation immediately removes/rejects the tool and does **not**
delete local history.

This private configured pull path does not close the repository-wide MCP
publication gates. The external bridge still lacks the required secure
transport/server and turn-generation proof, so public MCP/skill publication
remains **NO-GO**.

## Lifecycle note

The bottom `TabView` unloads offscreen tabs and does **not** re-fire
`navigatingTo` on return, so the VM is created once and deliberately never
disposed while the tab lives — disposing would kill the ring-store subscription
permanently. `unloaded` is a no-op; `buildRing`/`buildCharts` are idempotent.

## Known limitations (need worn-ring ground truth)

- **HR record byte layout is unverified.** The record's `.latest` field decodes
  OUT of its own hour's min..max envelope on real data (e.g. 112 vs a 59-88
  range), so the "current" HR uses the hour's `.avg` (always in range) until the
  offsets are validated on worn-ring capture. SpO2/HRV use `.latest` (sane).
- **Only ~1 hour of HR reaches the app** despite all-day wear — most likely ring
  contention with the Even app (`com.even.sg`); the poller logs "NEEDS exclusive
  ring". Full-day history probably needs the Even app disconnected.
- **Sleep (cmd=6) + live-HR point-push** decoders are stubs; the sleep card
  stays locked until validated.
