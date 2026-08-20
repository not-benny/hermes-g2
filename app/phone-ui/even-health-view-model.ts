import { AbsoluteLayout, Color, Label, Observable, Page } from "@nativescript/core";

import { ringHealthStore, type RingHealthSnapshot } from "../health/ring-health-store";
import { dashboardController, type DashboardSnapshot } from "../g2/dashboard-controller";
import type { RingConnectionState } from "../native/faceclaw-communicator";
import {
  heartRateInsights,
  readinessScore,
  sleepInsights,
  temperatureInsights,
  type InsightInputs,
} from "../health/health-insights";
import { computeBaselines } from "../health/health-history";
import {
  renderColumnChart,
  buildHrDayBars,
  buildTrendBars,
  readinessColor,
  type HourHr,
} from "./health-charts";
import {
  loadHealthHistory,
  recordHealthDay,
  shareHealthCsv,
  pushHealthToHermes,
  getHermesConsent,
  setHermesConsent,
} from "../native/health-export";

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

// While the user has consented, push the health history to Hermes on this cadence
// (in addition to an immediate push when the toggle is switched on). Deliberately
// infrequent: the push is a full-state upsert of the consolidated history, meant to
// keep a persistent store fresh -- not to open a Hermes session every few minutes.
const HERMES_PUSH_INTERVAL_MS = 3 * 60 * 60 * 1000;

export class EvenHealthViewModel extends Observable {
  private health: RingHealthSnapshot = ringHealthStore.snapshot();
  private ringState: RingConnectionState = "not-configured";
  private offHealth: (() => void) | null = null;
  private offDashboard: (() => void) | null = null;
  private ringDots: Label[] = [];
  private readinessRaw: number | null = null;
  private readinessColor = TRACK;
  private hermesTimer: ReturnType<typeof setInterval> | null = null;
  private hrChartHost: AbsoluteLayout | null = null;
  private trendChartHost: AbsoluteLayout | null = null;

  constructor() {
    super();
    this.offHealth = ringHealthStore.onChange((snapshot) => {
      this.health = snapshot;
      this.refresh();
    });
    this.offDashboard = dashboardController.subscribe((snapshot: DashboardSnapshot) => {
      if (snapshot.ringConnectionState === this.ringState) return;
      this.ringState = snapshot.ringConnectionState;
      this.refresh();
    });
    if (getHermesConsent()) this.startHermesTimer();
  }

  dispose(): void {
    this.offHealth?.(); this.offHealth = null;
    this.offDashboard?.(); this.offDashboard = null;
    this.stopHermesTimer();
  }

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
    const hours: HourHr[] = this.health.heartRateSeries.map((s) => ({
      hourIdx: s.hourIdx, min: s.min, max: s.max, avg: s.avg,
    }));
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

  // --- insight computation ---------------------------------------------------
  private inputs(): InsightInputs {
    const history = loadHealthHistory();
    const baselines = computeBaselines(history, Date.now());
    return {
      heartRate: this.health.heartRateSeries,
      hrv: this.health.hrvSeries,
      sleep: null, // gated until the cmd=6 sleep decoder is validated on worn data
      liveHr: this.health.currentHr,
      bodyTempC: this.health.bodyTempC,
      baselines,
      nowMs: Date.now(),
    };
  }

  private refresh(): void {
    const i = this.inputs();
    const hr = heartRateInsights(i);
    const sleep = sleepInsights(i);
    const temp = temperatureInsights(i);
    const readiness = readinessScore(i);
    this.readinessRaw = readiness.score;
    const band = BAND[readiness.band];
    this.readinessColor = readiness.score === null ? TRACK : band.color;

    const spo2 = this.health.spo2;
    const hrvNewest = this.health.hrv;

    // Log the day (merge-safe) once there's real data.
    if (this.health.updatedAtMs !== null) {
      recordHealthDay({
        hr, sleep, readiness,
        hrvAvg: hrvNewest?.latest ?? null,
        spo2Avg: spo2?.avg ?? null,
        steps: this.health.activity?.totalSteps ?? null,
        bodyTempC: this.health.bodyTempC,
        updatedAtMs: this.health.updatedAtMs,
      });
    }

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
    return this.health.updatedAtMs === null ? "No ring data yet" : `Updated ${relativeTime(this.health.updatedAtMs)}`;
  }
  get ringDotClass(): string { return this.ringState === "ready" ? "dot-on" : "dot-off"; }
  get batteryChipLabel(): string {
    return this.health.batteryPercent === null ? "" : `${this.health.batteryPercent}%`;
  }
  get batteryChipVisibility(): "visible" | "collapse" {
    return this.health.batteryPercent === null ? "collapse" : "visible";
  }
  get emptyStateVisibility(): "visible" | "collapse" {
    return this.health.updatedAtMs === null ? "visible" : "collapse";
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
    return this.health.heartRateSeries.length ? "visible" : "collapse";
  }

  // --- readiness trend (grows with history) ----------------------------------
  get trendChartVisibility(): "visible" | "collapse" { return this.trendDayCount >= 2 ? "visible" : "collapse"; }
  get trendEmptyVisibility(): "visible" | "collapse" { return this.trendDayCount >= 2 ? "collapse" : "visible"; }
  get trendEmptyLabel(): string {
    return this.trendDayCount === 1
      ? "One day logged. Your readiness trend fills in over the next few days."
      : "Your readiness trend fills in over the next few days.";
  }

  // --- sleep (gated) ---------------------------------------------------------
  get sleepAvailable(): boolean { return this.sleepI.available === "full"; }
  get sleepLockedVisibility(): "visible" | "collapse" { return this.sleepI.available === "full" ? "collapse" : "visible"; }
  get sleepFullVisibility(): "visible" | "collapse" { return this.sleepI.available === "full" ? "visible" : "collapse"; }
  get sleepHint(): string {
    return this.ringState === "ready"
      ? "Wear the ring overnight to unlock sleep staging."
      : "Connect the ring, then wear it overnight.";
  }
  get sleepScoreLabel(): string { return this.sleepI.score === null ? "--" : String(this.sleepI.score); }
  get sleepDurationLabel(): string {
    const m = this.sleepI.totalSleepMin;
    return m === null ? "" : `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  // --- supporting tiles ------------------------------------------------------
  get spo2Value(): string { return this.health.spo2 ? String(this.health.spo2.latest) : "--"; }
  get hrvValue(): string { return this.health.hrv ? String(this.health.hrv.latest) : "--"; }
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

  // --- export + sharing ------------------------------------------------------
  onExportCsvTap(): void {
    try { shareHealthCsv(); } catch (e) { console.error(`[health] csv export failed: ${e}`); }
  }

  /** Consent toggle: off by default, nothing leaves the device until turned on. */
  get hermesConsent(): boolean { return getHermesConsent(); }
  set hermesConsent(on: boolean) {
    if (on === getHermesConsent()) return; // guard the notify->write loop
    setHermesConsent(on);
    this.notifyPropertyChange("hermesConsent", on);
    this.notifyPropertyChange("hermesConsentSub", this.hermesConsentSub);
    if (on) { this.startHermesTimer(); void this.pushToHermes(); } else { this.stopHermesTimer(); }
  }
  get hermesConsentSub(): string {
    return getHermesConsent()
      ? "Sharing on · syncs to Hermes every 3 hours"
      : "Off · your health data stays on this device";
  }

  private startHermesTimer(): void {
    if (this.hermesTimer) return;
    this.hermesTimer = setInterval(() => { void this.pushToHermes(); }, HERMES_PUSH_INTERVAL_MS);
  }
  private stopHermesTimer(): void {
    if (this.hermesTimer) { clearInterval(this.hermesTimer); this.hermesTimer = null; }
  }
  private async pushToHermes(): Promise<void> {
    if (!getHermesConsent()) return; // re-check: consent may have flipped off mid-interval
    const ok = await pushHealthToHermes();
    console.log(`[health] hermes auto-push ${ok ? "ok" : "failed"}`);
  }
}

const NOTIFY = [
  "ringStatusLabel", "lastUpdatedLabel", "ringDotClass", "batteryChipLabel", "batteryChipVisibility", "emptyStateVisibility",
  "readinessValue", "readinessOutOf", "readinessVerdict", "readinessBlurb", "driverChips", "driverChipsVisibility",
  "currentHrValue", "currentHrSource", "restingHrLabel", "hrRangeLabel", "hrTrendLabel", "hrChartVisibility",
  "trendChartVisibility", "trendEmptyVisibility", "trendEmptyLabel",
  "sleepLockedVisibility", "sleepFullVisibility", "sleepHint", "sleepScoreLabel", "sleepDurationLabel",
  "spo2Value", "hrvValue", "temperatureValue", "temperatureUnit", "temperatureSub", "batteryValue",
];

function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}
