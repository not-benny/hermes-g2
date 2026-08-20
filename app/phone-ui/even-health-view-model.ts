import { Frame, Observable } from "@nativescript/core";

import { ringHealthStore, type RingHealthSnapshot } from "../health/ring-health-store";
import { dashboardController, type DashboardSnapshot } from "../g2/dashboard-controller";
import type { RingConnectionState } from "../native/faceclaw-communicator";

/**
 * Even Health dashboard, backed DIRECTLY by the R1 ring's BLE health store
 * (app/health/ring-health-store) - not the old Even cloud API. The store is
 * already fed by dashboard-controller (onRingHealthFrame -> ingestFrame), so
 * this view model only reads its snapshot and re-renders the tiles on change.
 *
 * Live tiles: heart rate, SpO2, HRV, temperature, battery. Sleep is gated: its
 * wire layout is not decoded yet (ring-parser.decodeSleep is a stub), so the
 * tile shows an unlock hint instead of a value.
 */
const RING_STATUS_LABELS: Record<RingConnectionState, string> = {
  "not-configured": "Ring: no address configured",
  idle: "Ring: waiting for glasses session",
  retrying: "Ring: reconnecting…",
  subscribing: "Ring: subscribing…",
  ready: "Ring: connected",
};

export class EvenHealthViewModel extends Observable {
  private health: RingHealthSnapshot = ringHealthStore.snapshot();
  private ringState: RingConnectionState = "not-configured";
  private offHealth: (() => void) | null = null;
  private offDashboard: (() => void) | null = null;

  constructor() {
    super();
    // onChange does NOT fire on subscribe, so we seed from snapshot() above.
    this.offHealth = ringHealthStore.onChange((snapshot) => {
      this.health = snapshot;
      this.refreshTiles();
    });
    // subscribe() DOES fire immediately, seeding ringState + the sleep hint.
    this.offDashboard = dashboardController.subscribe((snapshot: DashboardSnapshot) => {
      if (snapshot.ringConnectionState === this.ringState) return;
      this.ringState = snapshot.ringConnectionState;
      this.refreshConnection();
    });
  }

  dispose(): void {
    this.offHealth?.();
    this.offHealth = null;
    this.offDashboard?.();
    this.offDashboard = null;
  }

  // --- header / connection -------------------------------------------------
  get ringStatusLabel(): string {
    return RING_STATUS_LABELS[this.ringState];
  }
  get lastUpdatedLabel(): string {
    return this.health.updatedAtMs === null ? "No ring data yet." : `Updated ${relativeTime(this.health.updatedAtMs)}`;
  }
  get emptyStateVisibility(): "visible" | "collapse" {
    return this.health.updatedAtMs === null ? "visible" : "collapse";
  }

  // --- Heart rate ----------------------------------------------------------
  get heartRateValue(): string { return valueOf(this.health.heartRate?.latest); }
  get heartRateUnit(): string { return this.health.heartRate ? "bpm" : ""; }
  get heartRateSub(): string { return hourlySub(this.health.heartRate); }

  // --- SpO2 ----------------------------------------------------------------
  get spo2Value(): string { return valueOf(this.health.spo2?.latest); }
  get spo2Unit(): string { return this.health.spo2 ? "%" : ""; }
  get spo2Sub(): string { return hourlySub(this.health.spo2); }

  // --- HRV -----------------------------------------------------------------
  get hrvValue(): string { return valueOf(this.health.hrv?.latest); }
  get hrvUnit(): string { return this.health.hrv ? "ms" : ""; }
  get hrvSub(): string { return this.health.hrv ? `at ${clockTime(this.health.hrv.ts)}` : ""; }

  // --- Temperature (rides the stride-9 hourly layout; u8 => integer degrees)-
  get temperatureValue(): string { return formatTemp(this.health.temperature?.latest); }
  get temperatureUnit(): string { return this.health.temperature ? "°C" : ""; }
  get temperatureSub(): string { return hourlySub(this.health.temperature); }

  // --- Battery -------------------------------------------------------------
  get batteryValue(): string { return valueOf(this.health.batteryPercent); }
  get batteryUnit(): string { return this.health.batteryPercent === null ? "" : "%"; }
  get batterySub(): string { return this.health.batteryPercent === null ? "" : "ring"; }

  // --- Sleep (gated: layout undecoded) -------------------------------------
  get sleepHint(): string {
    return this.ringState === "ready"
      ? "Wear the ring overnight to unlock sleep staging."
      : "Connect the ring, then wear it overnight.";
  }

  onBackTap(): void {
    Frame.topmost()?.navigate({ moduleName: "phone-ui/main-page", clearHistory: true });
  }

  private refreshTiles(): void {
    for (const property of [
      "heartRateValue", "heartRateUnit", "heartRateSub",
      "spo2Value", "spo2Unit", "spo2Sub",
      "hrvValue", "hrvUnit", "hrvSub",
      "temperatureValue", "temperatureUnit", "temperatureSub",
      "batteryValue", "batteryUnit", "batterySub",
      "lastUpdatedLabel", "emptyStateVisibility",
    ]) {
      this.notifyPropertyChange(property, (this as any)[property]);
    }
  }

  private refreshConnection(): void {
    for (const property of ["ringStatusLabel", "sleepHint"]) {
      this.notifyPropertyChange(property, (this as any)[property]);
    }
  }
}

function valueOf(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : String(n);
}

/** Single knob for the temperature scale; adjust here if a real reading shows
 *  the u8 is not whole degrees C. */
function formatTemp(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : String(n);
}

function hourlySub(s: { avg: number; min: number; max: number } | null | undefined): string {
  return s ? `avg ${s.avg} · ${s.min}–${s.max}` : "";
}

function clockTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
