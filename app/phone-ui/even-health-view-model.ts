import { AbsoluteLayout, Application, Color, Label, Observable, Page } from "@nativescript/core";

import { ringHealthStore, type RingHealthSnapshot } from "../health/ring-health-store";
import { dashboardController, type DashboardSnapshot } from "../g2/dashboard-controller";
import type { RingConnectionState } from "../native/faceclaw-communicator";
import {
  heartRateInsights,
  readinessScore,
  sleepSessionFromRing,
  sleepInsights,
  temperatureInsights,
  type InsightInputs,
} from "../health/health-insights";
import { computeBaselines, dateKeyOf } from "../health/health-history";
import { hourlyForDay, type HourlyPoint } from "../health/health-hourly";
import {
  renderColumnChart,
  buildHrDayBars,
  buildTrendBars,
  readinessColor,
  type HourHr,
} from "./health-charts";
import {
  loadHealthHistory,
  loadHourly,
  getHermesConsent,
  setHermesConsent,
} from "../native/health-store";
import { shareHealthJson } from "../native/health-export";
import { toolRegistry } from "../assistant/tool-registry";
import { estimateActiveCalories } from "../health/calories";
import { loadCalorieProfile } from "../native/calorie-profile";

/** Minimal per-hour shape (hourIdx + avg/max/min) the insights + charts consume. */
type RingHour = { hourIdx: number; avg: number; max: number; min: number; timestampSec: number | null; timezoneOffsetMinutes: number | null };

const RING_STATUS_LABELS: Record<RingConnectionState, string> = {
  "not-configured": "Ring: no address configured",
  idle: "Ring: waiting for glasses session",
  retrying: "Ring: reconnecting…",
  subscribing: "Ring: subscribing…",
  ready: "Ring: connected",
};

// Readiness band -> colour + words.
const BAND = {
  optimal: { color: "#57D8A6", verdict: "Primed" },
  good: { color: "#57D8A6", verdict: "Ready" },
  moderate: { color: "#F5C542", verdict: "Take it easy" },
  low: { color: "#E5484D", verdict: "Recover" },
} as const;

// Ring gauge geometry (matches the AbsoluteLayout box in the XML).
const RING_N = 40;
const RING_BOX = 168;
const RING_R = 72;
const DOT = 9;
const TRACK = "#24312A";
const DISPLAY_FRESHNESS_INTERVAL_MS = 60_000;

export class EvenHealthViewModel extends Observable {
  private health: RingHealthSnapshot = ringHealthStore.snapshot();
  private ringState: RingConnectionState = "not-configured";
  private evenAppConflictMessageState = "";
  private offHealth: (() => void) | null = null;
  private offDashboard: (() => void) | null = null;
  private freshnessTimer: ReturnType<typeof setInterval> | null = null;
  private resumeListening = false;
  private ringDots: Label[] = [];
  private readinessRaw: number | null = null;
  private readinessColor = TRACK;

  private hrChartHost: AbsoluteLayout | null = null;
  private trendChartHost: AbsoluteLayout | null = null;
  /** Today's accumulated hourly history (survives empty polls + relaunches). */
  private hourlyToday: HourlyPoint[] = hourlyForDay(loadHourly(), dateKeyOf(Date.now()));

  constructor() {
    super();
    // Render whatever we've already accumulated before the first live poll.
    this.refresh();
    this.offHealth = ringHealthStore.onChange((snapshot) => {
      this.health = snapshot;
      this.refresh();
    });
    this.offDashboard = dashboardController.subscribe((snapshot: DashboardSnapshot) => {
      if (
        snapshot.ringConnectionState === this.ringState &&
        snapshot.evenAppConflictMessage === this.evenAppConflictMessageState
      ) return;
      this.ringState = snapshot.ringConnectionState;
      this.evenAppConflictMessageState = snapshot.evenAppConflictMessage;
      this.refresh();
    });
  }

  dispose(): void {
    this.deactivate();
    this.offHealth?.(); this.offHealth = null;
    this.offDashboard?.(); this.offDashboard = null;
  }

  /**
   * Refresh retained tab state on every visible entry and app resume. The ring
   * may be quiet (or Bluetooth may be off) across local midnight and the 36 h
   * sleep-readiness boundary, so store emissions alone are not a clock.
   */
  activate(page: Page): void {
    this.refreshForDisplay();
    this.buildRing(page);
    if (!this.freshnessTimer) {
      this.freshnessTimer = setInterval(() => this.refreshForDisplay(), DISPLAY_FRESHNESS_INTERVAL_MS);
    }
    if (!this.resumeListening) {
      Application.on(Application.resumeEvent, this.onApplicationResume);
      this.resumeListening = true;
    }
  }

  deactivate(): void {
    if (this.freshnessTimer) clearInterval(this.freshnessTimer);
    this.freshnessTimer = null;
    if (this.resumeListening) Application.off(Application.resumeEvent, this.onApplicationResume);
    this.resumeListening = false;
  }

  refreshForDisplay(): void {
    // snapshot() also applies the store's same-process local-day pruning.
    this.health = ringHealthStore.snapshot();
    this.refresh();
  }

  private readonly onApplicationResume = (): void => this.refreshForDisplay();

  /** Build the ring gauge + charts once the page views exist (page 'loaded'). */
  buildRing(page: Page): void {
    this.buildReadinessRing(page);
    this.buildCharts(page);
  }

  /** Segmented readiness ring gauge, built once. */
  private buildReadinessRing(page: Page): void {
    const host = page.getViewById("readinessRing") as AbsoluteLayout | undefined;
    if (!host || this.ringDots.length) return;
    const cx = RING_BOX / 2, cy = RING_BOX / 2;
    const track = new Color(TRACK);
    for (let i = 0; i < RING_N; i++) {
      const theta = (-90 + (i * 360) / RING_N) * (Math.PI / 180);
      const dot = new Label();
      dot.width = DOT; dot.height = DOT; dot.borderRadius = DOT / 2;
      dot.backgroundColor = track;
      AbsoluteLayout.setLeft(dot, Math.round(cx + RING_R * Math.cos(theta) - DOT / 2));
      AbsoluteLayout.setTop(dot, Math.round(cy + RING_R * Math.sin(theta) - DOT / 2));
      host.addChild(dot);
      this.ringDots.push(dot);
    }
    this.paintRing();
  }

  /** Grab the chart mounts, repaint them on (re)layout, and draw once now. */
  private buildCharts(page: Page): void {
    if (!this.hrChartHost) {
      this.hrChartHost = (page.getViewById("hrChart") as AbsoluteLayout | undefined) ?? null;
      this.hrChartHost?.on("layoutChanged", () => this.paintHrChart());
    }
    if (!this.trendChartHost) {
      this.trendChartHost = (page.getViewById("trendChart") as AbsoluteLayout | undefined) ?? null;
      this.trendChartHost?.on("layoutChanged", () => this.paintTrendChart());
    }
    this.paintCharts();
  }

  private paintRing(): void {
    if (!this.ringDots.length) return;
    const lit = this.readinessRaw === null ? 0 : Math.round((this.readinessRaw / 100) * RING_N);
    const glow = new Color(this.readinessColor);
    const track = new Color(TRACK);
    this.ringDots.forEach((d, i) => { d.backgroundColor = i < lit ? glow : track; });
  }

  private paintCharts(): void {
    this.paintHrChart();
    this.paintTrendChart();
  }

  /** Today's 24-hour heart-rate range chart, zone-coloured, resting baseline. */
  private paintHrChart(): void {
    const host = this.hrChartHost;
    if (!host) return;
    const hours: HourHr[] = this.hrHours().map((h) => ({ hourIdx: h.hourIdx, min: h.min, max: h.max, avg: h.avg }));
    const { bars, baselineFrac } = buildHrDayBars(hours, this.hrI.restingHr);
    renderColumnChart(host, bars, { midColor: "#EAF2EC", baselineFrac, baselineColor: "#3A4A40" });
  }

  /** Up to 14 days of readiness as band-coloured columns (a growing trend). */
  private paintTrendChart(): void {
    const host = this.trendChartHost;
    if (!host) return;
    const recent = [...loadHealthHistory()]
      .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1))
      .slice(-14);
    const bars = buildTrendBars(recent.map((d) => d.readinessScore), readinessColor);
    renderColumnChart(host, bars, { minBarHeight: 4 });
  }

  // --- accumulated-hourly accessors ------------------------------------------
  private hrHours(): RingHour[] { return this.hourlyToday.filter((p) => p.hr).map((p) => ({ hourIdx: p.hourIdx, timestampSec: p.timestampSec ?? null, timezoneOffsetMinutes: p.timezoneOffsetMinutes ?? null, ...p.hr! })); }
  private spo2Hours(): RingHour[] { return this.hourlyToday.filter((p) => p.spo2).map((p) => ({ hourIdx: p.hourIdx, timestampSec: p.timestampSec ?? null, timezoneOffsetMinutes: p.timezoneOffsetMinutes ?? null, ...p.spo2! })); }
  private hrvHours(): RingHour[] { return this.hourlyToday.filter((p) => p.hrv).map((p) => ({ hourIdx: p.hourIdx, timestampSec: p.timestampSec ?? null, timezoneOffsetMinutes: p.timezoneOffsetMinutes ?? null, ...p.hrv! })); }
  private latestHour(hours: RingHour[]): RingHour | null {
    let n: RingHour | null = null;
    for (const h of hours) if (!n || h.hourIdx >= n.hourIdx) n = h;
    return n;
  }
  private spo2Latest: RingHour | null = null;
  private hrvLatest: RingHour | null = null;

  // --- insight computation ---------------------------------------------------
  private inputs(): InsightInputs {
    const nowMs = Date.now();
    const sleep = sleepSessionFromRing(this.health.sleep, nowMs);
    const bodyTempC = sleep && this.health.sleep?.bodyTemperatureDeciC !== null
      ? this.health.sleep!.bodyTemperatureDeciC / 10
      : null;
    const baselines = computeBaselines(loadHealthHistory(), nowMs);
    return {
      heartRate: this.hrHours(),
      hrv: this.hrvHours(),
      sleep,
      liveHr: this.health.currentHr,
      bodyTempC,
      baselines,
      nowMs,
    };
  }

  private refresh(): void {
    // Persistence is process-wide; this optional view only reads the accumulated
    // day, so never opening the Health tab cannot discard an overnight sync.
    this.hourlyToday = hourlyForDay(loadHourly(), dateKeyOf(Date.now()));

    const i = this.inputs();
    const hr = heartRateInsights(i);
    const sleep = sleepInsights(i);
    const temp = temperatureInsights(i);
    const readiness = readinessScore(i);
    this.readinessRaw = readiness.score;
    const band = BAND[readiness.band];
    this.readinessColor = readiness.score === null ? TRACK : band.color;

    this.spo2Latest = this.latestHour(this.spo2Hours());
    this.hrvLatest = this.latestHour(this.hrvHours());

    // Stash the computed values for the getters, then notify everything.
    this.hrI = hr; this.sleepI = sleep; this.tempI = temp; this.readinessI = readiness;
    this.trendDayCount = loadHealthHistory().filter((d) => d.readinessScore !== null).length;
    this.paintRing();
    this.paintCharts();
    for (const p of NOTIFY) this.notifyPropertyChange(p, (this as any)[p]);
  }

  private trendDayCount = 0;

  private hrI = heartRateInsights({});
  private sleepI = sleepInsights({});
  private tempI = temperatureInsights({});
  private readinessI = readinessScore({});

  // --- connection strip ------------------------------------------------------
  get ringStatusLabel(): string { return RING_STATUS_LABELS[this.ringState]; }
  get lastUpdatedLabel(): string {
    const updatedAtMs = Math.max(this.health.updatedAtMs ?? -1, this.health.batteryUpdatedAtMs ?? -1);
    if (updatedAtMs >= 0) return `Updated ${relativeTime(updatedAtMs)}`;
    return this.hourlyToday.length > 0 ? "Showing saved data" : "No ring data yet";
  }
  get ringDotClass(): string { return this.ringState === "ready" ? "dot-on" : "dot-off"; }
  get batteryChipLabel(): string {
    return this.health.batteryPercent === null ? "" : `${this.health.batteryPercent}%`;
  }
  get batteryChipVisibility(): "visible" | "collapse" {
    return this.health.batteryPercent === null ? "collapse" : "visible";
  }
  get evenAppConflictMessage(): string { return this.evenAppConflictMessageState; }
  get evenAppConflictWarningVisibility(): "visible" | "collapse" {
    return this.evenAppConflictMessageState ? "visible" : "collapse";
  }
  onOpenEvenAppSettingsTap(): void { dashboardController.openEvenAppSettings(); }
  async onRetryRingTap(): Promise<void> {
    const queued = await dashboardController.retryRingAfterEvenAppStop();
    if (!queued) console.log("[health] R1 retry blocked until Even is stopped");
  }
  private get hasData(): boolean {
    return this.health.updatedAtMs !== null || this.health.batteryUpdatedAtMs !== null ||
      this.hourlyToday.length > 0 || sleepSessionFromRing(this.health.sleep) !== null;
  }
  get emptyStateVisibility(): "visible" | "collapse" {
    return this.hasData ? "collapse" : "visible";
  }

  // --- readiness hero --------------------------------------------------------
  get readinessValue(): string { return this.readinessI.score === null ? "--" : String(this.readinessI.score); }
  get readinessOutOf(): string { return this.readinessI.score === null ? "" : "/ 100"; }
  get readinessVerdict(): string {
    return this.readinessI.score === null ? "Not enough data" : BAND[this.readinessI.band].verdict;
  }
  get readinessBlurb(): string {
    if (this.readinessI.score !== null) {
      return `${this.readinessI.confidence[0].toUpperCase()}${this.readinessI.confidence.slice(1)} confidence · estimated from ring vitals`;
    }
    return this.ringState === "ready"
      ? "Wear the ring a few minutes to build your first score."
      : "Connect and wear the ring to see readiness.";
  }
  get driverChips(): string { return this.readinessI.contributors.filter((c) => c.available).map((c) => c.label).join("   ·   "); }
  get driverChipsVisibility(): "visible" | "collapse" {
    return this.readinessI.contributors.some((c) => c.available) ? "visible" : "collapse";
  }

  // --- heart rate ------------------------------------------------------------
  get currentHrValue(): string { return this.hrI.current === null ? "--" : String(this.hrI.current); }
  get currentHrSource(): string { return this.hrI.source === "live" ? "live" : this.hrI.source === "hourly" ? "latest hour" : ""; }
  get restingHrLabel(): string { return this.hrI.restingHr === null ? "Resting --" : `Resting ${this.hrI.restingHr} bpm`; }
  get hrRangeLabel(): string {
    return this.hrI.min === null || this.hrI.max === null ? "" : `Range ${this.hrI.min}-${this.hrI.max} bpm`;
  }
  get hrTrendLabel(): string {
    const t = this.hrI.trend;
    if (!t) return "";
    const arrow = t.direction === "down" ? "↓" : t.direction === "up" ? "↑" : "→";
    return `${arrow} ${Math.abs(t.deltaBpm)} vs baseline`;
  }
  /** Hide the 24h chart until there's at least one hourly record to plot. */
  get hrChartVisibility(): "visible" | "collapse" {
    return this.hrHours().length ? "visible" : "collapse";
  }

  // --- readiness trend (grows with history) ----------------------------------
  get trendChartVisibility(): "visible" | "collapse" { return this.trendDayCount >= 2 ? "visible" : "collapse"; }
  get trendEmptyVisibility(): "visible" | "collapse" { return this.trendDayCount >= 2 ? "collapse" : "visible"; }
  get trendEmptyLabel(): string {
    return this.trendDayCount === 1
      ? "One day logged. Your readiness trend fills in over the next few days."
      : "Your readiness trend fills in over the next few days.";
  }

  // --- sleep -----------------------------------------------------------------
  get sleepAvailable(): boolean { return this.sleepI.available === "full"; }
  get sleepLockedVisibility(): "visible" | "collapse" { return this.sleepI.available === "full" ? "collapse" : "visible"; }
  get sleepFullVisibility(): "visible" | "collapse" { return this.sleepI.available === "full" ? "visible" : "collapse"; }
  get sleepHint(): string {
    return this.ringState === "ready"
      ? "No complete sleep summary from the last 36 hours. Wear the ring overnight."
      : "Connect the ring to sync last night's sleep.";
  }
  get sleepScoreLabel(): string { return this.sleepI.score === null ? "--" : String(this.sleepI.score); }
  get sleepScoreSourceLabel(): string {
    return this.sleepI.scoreSource === "ring" ? "Ring score" : this.sleepI.scoreSource === "derived" ? "Estimated score" : "";
  }
  get sleepDurationLabel(): string {
    return formatMinutes(this.sleepI.totalSleepMin);
  }
  get sleepEfficiencyLabel(): string {
    return this.sleepI.efficiencyPct === null ? "" : `Efficiency ${this.sleepI.efficiencyPct}%`;
  }
  get sleepAwakeLabel(): string { return `Awake ${formatMinutes(this.sleepI.stages?.awakeMin ?? null)}`; }
  get sleepRemLabel(): string { return `REM ${formatMinutes(this.sleepI.stages?.remMin ?? null)}`; }
  get sleepLightLabel(): string { return `Light ${formatMinutes(this.sleepI.stages?.lightMin ?? null)}`; }
  get sleepDeepLabel(): string { return `Deep ${formatMinutes(this.sleepI.stages?.deepMin ?? null)}`; }

  // --- supporting tiles ------------------------------------------------------
  get spo2Value(): string { return this.spo2Latest ? String(this.spo2Latest.avg) : "--"; }
  get hrvValue(): string { return this.hrvLatest ? String(this.hrvLatest.avg) : "--"; }
  get temperatureValue(): string {
    return this.tempI.deviationC === null
      ? (this.tempI.currentC === null ? "--" : this.tempI.currentC.toFixed(1))
      : `${this.tempI.deviationC > 0 ? "+" : ""}${this.tempI.deviationC.toFixed(1)}`;
  }
  get temperatureUnit(): string { return this.tempI.deviationC === null ? (this.tempI.currentC === null ? "" : "°C") : "°C"; }
  get temperatureSub(): string {
    return this.tempI.currentC === null ? "nightly" : this.tempI.deviationC === null ? "baseline building" : "vs baseline";
  }
  get batteryValue(): string { return this.health.batteryPercent === null ? "--" : String(this.health.batteryPercent); }
  get caloriesValue(): string {
    const nativeActiveCalories = this.health.activity?.activeCalories;
    if (nativeActiveCalories !== undefined) return String(nativeActiveCalories);
    const hrs = this.hrHours();
    return hrs.length ? String(estimateActiveCalories(hrs, loadCalorieProfile(), this.hrI.restingHr)) : "--";
  }
  get caloriesMetricLabel(): string { return this.health.activity ? "Active kcal" : "Active kcal *"; }
  get caloriesSourceLabel(): string { return this.health.activity ? "from R1 ring" : "estimated from HR"; }
  get stepsValue(): string { return this.health.activity ? String(this.health.activity.totalSteps) : "--"; }

  // --- export + sharing ------------------------------------------------------
  onExportJsonTap(): void {
    try { shareHealthJson(); } catch (e) { console.error(`[health] json export failed: ${e}`); }
  }

  /** Consent gates on-demand assistant reads; revocation never deletes local data. */
  get hermesConsent(): boolean { return getHermesConsent(); }
  set hermesConsent(on: boolean) {
    if (on === getHermesConsent()) return; // guard the notify->write loop
    setHermesConsent(on);
    toolRegistry.fireToolsChanged();
    this.notifyPropertyChange("hermesConsent", on);
    this.notifyPropertyChange("hermesConsentSub", this.hermesConsentSub);
  }
  get hermesConsentSub(): string {
    return getHermesConsent()
      ? "On · your configured assistant can read up to 90 days on demand; no background uploads"
      : "Off · assistant reads are blocked; stored locally for up to 90 days";
  }
}

const NOTIFY = [
  "ringStatusLabel", "lastUpdatedLabel", "ringDotClass", "batteryChipLabel", "batteryChipVisibility", "emptyStateVisibility",
  "evenAppConflictMessage", "evenAppConflictWarningVisibility",
  "readinessValue", "readinessOutOf", "readinessVerdict", "readinessBlurb", "driverChips", "driverChipsVisibility",
  "currentHrValue", "currentHrSource", "restingHrLabel", "hrRangeLabel", "hrTrendLabel", "hrChartVisibility",
  "trendChartVisibility", "trendEmptyVisibility", "trendEmptyLabel",
  "sleepLockedVisibility", "sleepFullVisibility", "sleepHint", "sleepScoreLabel", "sleepScoreSourceLabel",
  "sleepDurationLabel", "sleepEfficiencyLabel", "sleepAwakeLabel", "sleepRemLabel", "sleepLightLabel", "sleepDeepLabel",
  "spo2Value", "hrvValue", "temperatureValue", "temperatureUnit", "temperatureSub", "batteryValue",
  "caloriesValue", "caloriesMetricLabel", "caloriesSourceLabel", "stepsValue",
];

function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

function formatMinutes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  const minutes = Math.max(0, Math.round(value));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}
