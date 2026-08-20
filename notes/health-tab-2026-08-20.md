# Rich Health tab (2026-08-20)

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
- `app/native/health-export.ts` — the only IO adapter: load/record history
  (ApplicationSettings `health.history.v1`, 90-day cap), write+share CSV
  (Android ACTION_SEND), push to the Hermes bridge, and the Hermes **consent**
  flag (`health.hermes.consent.v1`, off by default).
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
- Sleep card: gated behind a lock until the cmd=6 sleep decoder is validated.
- Supporting tiles: SpO2, HRV, Temperature (nightly variation vs baseline),
  Battery.
- Export CSV button + "Send to Hermes" consent toggle.

## Consent / Hermes sync

Off by default. When enabled it pushes the consolidated history as a full-state
upsert on enable and every **3 hours** (not per-minute). The push is a
best-effort HTTP POST today; the intended end state is a **pull** model — expose
ring health as an MCP tool on the phone that Hermes reads on demand, so no
per-push agent sessions. See the `hermes-g2-mcp-skill-review` memory.

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
