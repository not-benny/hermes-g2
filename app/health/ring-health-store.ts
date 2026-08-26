/**
 * Live ring health state, assembled from raw bae80013 notify frames.
 *
 * The Java layer forwards every frame on the ring's data-notify characteristic
 * (see FaceclawBleCommunicator.emitRingHealthFrame). This store buffers the
 * multi-packet fragments per batch id, reassembles and CRC-checks them with
 * app/health/ring-parser, and keeps the latest decoded value per metric plus
 * the ring battery percent. The dashboard controller subscribes and mirrors
 * the values into the shell chrome (HUD heart rate + ring battery).
 *
 * Framework-agnostic on purpose: no NativeScript imports, so it runs under
 * plain Node for tests.
 */

import {
  canonicalizeRingSleepData,
  decodeDailyData,
  decodeSleep,
  parseFragment,
  parseInnerFrame,
  reassembleHealthFrames,
  decodeRingBattery,
  decodeRingFirmwareVersion,
  isCanonicalRingInnerFrame,
  RING_HEALTH_CMD,
  type Bytes,
  type RingActivitySample,
  type RingFragment,
  type RingHealthSample,
  type RingHrvSample,
  type RingSleepData,
} from "./ring-parser";

export interface RingActivitySnapshot {
  slots: RingActivitySample[];
  dayBaseSec: number;
  timezoneOffsetMinutes: number;
  totalSteps: number;
  activeCalories: number;
  totalCalories: number;
  restingCalories: number;
}

/** Rebuild a persisted/live activity snapshot from canonical source fields. */
export function canonicalizeActivitySnapshot(value: unknown, nowMs = Date.now()): RingActivitySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RingActivitySnapshot>;
  const base = candidate.dayBaseSec;
  const timezone = candidate.timezoneOffsetMinutes;
  if (!Number.isInteger(base) || !Number.isInteger(timezone) || !Array.isArray(candidate.slots)) return null;
  // The wire anchor is an unsigned 32-bit epoch second. Keeping that bound
  // explicit also lets persistence validate an expired snapshot against its
  // own day without accidentally accepting pre-epoch or synthetic huge dates.
  if (base! <= 0 || base! > 0xffffffff) return null;
  if (timezone! < -14 * 60 || timezone! > 14 * 60) return null;
  const nowSec = Math.floor(nowMs / 1000);
  const expectedBase = Math.floor((nowSec + timezone! * 60) / 86400) * 86400 - timezone! * 60;
  if (base !== expectedBase) return null;

  const bySlot = new Map<number, RingActivitySample>();
  for (const raw of candidate.slots) {
    if (
      !raw || !Number.isInteger(raw.slot) || raw.slot < 0 || raw.slot > 143 ||
      !Number.isInteger(raw.steps) || raw.steps < 0 || raw.steps > 0xffff ||
      !Number.isInteger(raw.activeCalories) || raw.activeCalories < 0 || raw.activeCalories > 0xffff ||
      !Number.isInteger(raw.totalCalories) || raw.totalCalories < raw.activeCalories || raw.totalCalories > 0xffff
    ) return null;
    bySlot.set(raw.slot, {
      slot: raw.slot,
      timestampSec: base! + raw.slot * 600,
      steps: raw.steps,
      activeCalories: raw.activeCalories,
      totalCalories: raw.totalCalories,
      restingCalories: raw.totalCalories - raw.activeCalories,
    });
  }
  const slots = Array.from(bySlot.values()).sort((a, b) => a.slot - b.slot);
  if (slots.length === 0) return null;
  return {
    slots,
    dayBaseSec: base!,
    timezoneOffsetMinutes: timezone!,
    totalSteps: slots.reduce((sum, slot) => sum + slot.steps, 0),
    activeCalories: slots.reduce((sum, slot) => sum + slot.activeCalories, 0),
    totalCalories: slots.reduce((sum, slot) => sum + slot.totalCalories, 0),
    restingCalories: slots.reduce((sum, slot) => sum + slot.restingCalories, 0),
  };
}

/** Latest decoded ring values. Null until the metric has been seen. */
export interface RingHealthSnapshot {
  /** Latest hourly heart-rate record (bpm in `latest`). */
  heartRate: RingHealthSample | null;
  /** Latest hourly SpO2 record (percent in `latest`). */
  spo2: RingHealthSample | null;
  /** Latest hourly temperature summary record. */
  temperature: RingHealthSample | null;
  /** Latest HRV record (milliseconds in `latest`). */
  hrv: RingHrvSample | null;
  /** Accumulated confirmed activity buckets for one local day. */
  activity: RingActivitySnapshot | null;
  /** Latest protocol-verified type-1 nightly sleep summary. */
  sleep: RingSleepData | null;
  /** Ring battery percent from the deviceStatus response. */
  batteryPercent: number | null;
  /** Wall-clock ms of the last deviceStatus battery response. */
  batteryUpdatedAtMs: number | null;
  /** Read-only firmware version from the deviceInfo response. */
  firmwareVersion: string | null;
  /** Wall-clock ms of the last applied update, null before the first. */
  updatedAtMs: number | null;
  /** The day's full hourly record arrays (for insights + sparklines). */
  heartRateSeries: RingHealthSample[];
  spo2Series: RingHealthSample[];
  hrvSeries: RingHrvSample[];
  /** Live/current heart rate from the point-push stream (null until wired/worn). */
  currentHr: number | null;
  /** Nightly body temperature in degC (from the sleep record; null until decoded). */
  bodyTempC: number | null;
}

const EMPTY: RingHealthSnapshot = {
  heartRate: null,
  spo2: null,
  temperature: null,
  hrv: null,
  activity: null,
  sleep: null,
  batteryPercent: null,
  batteryUpdatedAtMs: null,
  firmwareVersion: null,
  updatedAtMs: null,
  heartRateSeries: [],
  spo2Series: [],
  hrvSeries: [],
  currentHr: null,
  bodyTempC: null,
};

/** Incomplete batches kept while their fragments trickle in. */
const MAX_PENDING_BATCHES = 8;

/** Inner-frame envelope constants (see notes/ring-health-protocol-2026-08-19). */
const MODULE_SYSTEM = 1;
const MODULE_HEALTH = 2;
const CMD_SYSTEM = 0;
const SUBCMD_DEVICE_STATUS = 1;
const SUBCMD_DEVICE_INFO = 2;
const BATTERY_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SLEEP_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SLEEP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

type DailyVitalMetric = "heartRate" | "spo2" | "temperature" | "hrv";

function localDayToken(nowMs: number): string {
  const date = new Date(nowMs);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function emptyDailyVitalDays(): Record<DailyVitalMetric, string | null> {
  return { heartRate: null, spo2: null, temperature: null, hrv: null };
}

/** Apply the app's retention/future-time gate to a structurally valid night. */
export function canonicalizeSleepSnapshot(value: unknown, nowMs = Date.now()): RingSleepData | null {
  const sleep = canonicalizeRingSleepData(value);
  if (!sleep || sleep.endTs * 1000 > nowMs + SLEEP_FUTURE_SKEW_MS ||
    sleep.endTs * 1000 < nowMs - SLEEP_RETENTION_MS) return null;
  return sleep;
}

export class RingHealthStore {
  private snapshotState: RingHealthSnapshot = { ...EMPTY };
  private pending = new Map<number, RingFragment[]>();
  private pendingOrder: number[] = [];
  private listeners = new Set<(snapshot: RingHealthSnapshot) => void>();
  private log: (line: string) => void = () => {};
  /** Receipt-day tokens prevent retained daily pushes surviving local midnight. */
  private dailyVitalDays = emptyDailyVitalDays();

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  /** Route decode diagnostics into the app log (optional). */
  setLog(log: (line: string) => void): void {
    this.log = log;
  }

  snapshot(): RingHealthSnapshot {
    this.pruneExpiredActivity();
    this.pruneExpiredDailyVitals();
    return this.snapshotState;
  }

  /** Restore today's validated activity buckets from device-local persistence. */
  restoreActivity(activity: RingActivitySnapshot | null): void {
    const canonical = canonicalizeActivitySnapshot(activity, this.nowMs());
    if (!canonical) return;
    this.snapshotState = { ...this.snapshotState, activity: canonical };
    this.emit();
  }

  /** Restore the latest validated night from device-local persistence. */
  restoreSleep(value: RingSleepData | null): void {
    const sleep = canonicalizeSleepSnapshot(value, this.nowMs());
    if (!sleep || (this.snapshotState.sleep?.endTs ?? -1) >= sleep.endTs) return;
    this.snapshotState = {
      ...this.snapshotState,
      sleep,
      bodyTempC: sleep.bodyTemperatureDeciC === null ? null : sleep.bodyTemperatureDeciC / 10,
    };
    this.emit();
  }

  /** Restore the last protocol-verified battery while awaiting a fresh poll. */
  restoreBattery(percent: number | null, updatedAtMs: number | null): void {
    if (!Number.isInteger(percent) || (percent as number) < 0 || (percent as number) > 100 ||
      typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs) || updatedAtMs < 0 ||
      updatedAtMs > this.nowMs() + BATTERY_FUTURE_SKEW_MS) return;
    this.snapshotState = {
      ...this.snapshotState,
      batteryPercent: percent,
      batteryUpdatedAtMs: updatedAtMs,
    };
    this.emit();
  }

  /** Share a current verified battery from standard GATT or deviceStatus. */
  updateBatteryPercent(percent: number): void {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) return;
    const updatedAtMs = this.nowMs();
    this.snapshotState = {
      ...this.snapshotState,
      batteryPercent: percent,
      batteryUpdatedAtMs: updatedAtMs,
    };
    this.emit();
  }

  /** Clear battery when the configured ring identity changes or is removed. */
  clearBattery(): void {
    if (this.snapshotState.batteryPercent === null && this.snapshotState.batteryUpdatedAtMs === null) return;
    this.snapshotState = { ...this.snapshotState, batteryPercent: null, batteryUpdatedAtMs: null };
    this.emit();
  }

  onChange(listener: (snapshot: RingHealthSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drop pending fragments and decoded values (ring unpaired / new session). */
  reset(): void {
    this.pending.clear();
    this.pendingOrder = [];
    this.dailyVitalDays = emptyDailyVitalDays();
    this.snapshotState = { ...EMPTY };
    this.emit();
  }

  /**
   * Hard live-state boundary for configured-ring replacement or removal.
   * Kept explicit so address/config flows cannot accidentally clear only the
   * battery while leaving old-ring vitals, activity, sleep, or fragments live.
   */
  resetForIdentityChange(): void {
    this.reset();
  }

  /**
   * Preview/demo only: install a complete mock snapshot and notify listeners, so
   * the Health tab + HUD look alive with no ring connected. Cleared via reset().
   */
  seedMock(snapshot: RingHealthSnapshot): void {
    this.snapshotState = snapshot;
    const today = localDayToken(this.nowMs());
    this.dailyVitalDays = {
      heartRate: snapshot.heartRate !== null || snapshot.heartRateSeries.length > 0 || snapshot.currentHr !== null
        ? today : null,
      spo2: snapshot.spo2 !== null || snapshot.spo2Series.length > 0 ? today : null,
      temperature: snapshot.temperature !== null ? today : null,
      hrv: snapshot.hrv !== null || snapshot.hrvSeries.length > 0 ? today : null,
    };
    this.emit();
  }

  /**
   * Ingest one raw notify frame from the ring's data characteristic. Fragments
   * buffer per batch id; the batch decodes once its fragIndex-0 tail arrives.
   * Malformed input is logged and dropped, never thrown.
   */
  ingestFrame(frame: Bytes): void {
    let fragment: RingFragment;
    try {
      fragment = parseFragment(frame);
    } catch (error) {
      this.log(`ring health: bad fragment dropped (${String(error)})`);
      return;
    }
    const batch = this.pending.get(fragment.batchId);
    if (batch) {
      batch.push(fragment);
    } else {
      this.pending.set(fragment.batchId, [fragment]);
      this.pendingOrder.push(fragment.batchId);
      // Bound the buffer: a batch whose tail never arrives must not pin memory.
      while (this.pendingOrder.length > MAX_PENDING_BATCHES) {
        const evicted = this.pendingOrder.shift()!;
        if (evicted !== fragment.batchId) this.pending.delete(evicted);
      }
    }
    // fragIndex counts down; 0 is the final fragment of the batch.
    if (fragment.fragIndex !== 0) return;
    const fragments = this.pending.get(fragment.batchId) ?? [fragment];
    this.pending.delete(fragment.batchId);
    this.pendingOrder = this.pendingOrder.filter((id) => id !== fragment.batchId);
    try {
      const { inner } = reassembleHealthFrames(fragments);
      this.applyInner(inner);
    } catch (error) {
      this.log(`ring health: batch ${fragment.batchId} dropped (${String(error)})`);
    }
  }

  private applyInner(inner: Bytes): void {
    const parsed = parseInnerFrame(inner);
    if (parsed.module === MODULE_SYSTEM) {
      if (parsed.cmd === CMD_SYSTEM && parsed.subCmd === SUBCMD_DEVICE_STATUS && parsed.status === 3) {
        const percent = decodeRingBattery(parsed.data);
        this.updateBatteryPercent(percent);
      } else if (
        parsed.cmd === CMD_SYSTEM &&
        parsed.subCmd === SUBCMD_DEVICE_INFO &&
        parsed.status === 3
      ) {
        const version = decodeRingFirmwareVersion(parsed.data);
        if (version) {
          this.snapshotState = {
            ...this.snapshotState,
            firmwareVersion: version,
            updatedAtMs: this.nowMs(),
          };
          this.emit();
        }
      }
      return;
    }
    if (parsed.module !== MODULE_HEALTH) return;
    if (parsed.data.length === 0) return; // bare command ACK, no records.
    if (parsed.cmd === 6) {
      // Sleep may reach state only through the fully checked daily-push
      // envelope. decodeSleep itself accepts only the complete type-1 schema.
      if (parsed.status !== 2 || parsed.subCmd !== 1 || !isCanonicalRingInnerFrame(inner)) return;
      const sleep = canonicalizeSleepSnapshot(decodeSleep(parsed.data), this.nowMs());
      if (!sleep || (this.snapshotState.sleep?.endTs ?? -1) >= sleep.endTs) return;
      this.snapshotState = {
        ...this.snapshotState,
        sleep,
        bodyTempC: sleep.bodyTemperatureDeciC === null ? null : sleep.bodyTemperatureDeciC / 10,
        updatedAtMs: this.nowMs(),
      };
      this.emit();
      return;
    }
    const metric = RING_HEALTH_CMD[parsed.cmd];
    if (!metric) return;

    if (metric === "activity") {
      // Only the confirmed rich daily push layout may populate native totals.
      if (parsed.status !== 2 || parsed.subCmd !== 1 || !isCanonicalRingInnerFrame(inner)) return;
      const daily = decodeDailyData(parsed.data, "activity");
      const previous = this.snapshotState.activity?.dayBaseSec === daily.dayBaseSec
        ? this.snapshotState.activity.slots
        : [];
      const activity = canonicalizeActivitySnapshot({
        dayBaseSec: daily.dayBaseSec,
        timezoneOffsetMinutes: daily.timezoneOffsetMinutes,
        slots: [...previous, ...daily.records],
      }, this.nowMs());
      if (!activity) return;
      this.snapshotState = {
        ...this.snapshotState,
        activity,
        updatedAtMs: this.nowMs(),
      };
      this.emit();
      return;
    }

    // Vital timestamps may reach persisted/user-visible state only through the
    // exact daily-push envelope and incoming MODBUS CRC gate.
    if (parsed.status !== 2 || parsed.subCmd !== 1 || !isCanonicalRingInnerFrame(inner)) return;

    if (metric === "hrv") {
      const daily = decodeDailyData(parsed.data, "hrv");
      const newest = latestByHour(daily.records);
      if (!newest) return;
      const series = [...daily.records].sort((a, b) => a.hourIdx - b.hourIdx);
      this.dailyVitalDays.hrv = localDayToken(this.nowMs());
      this.snapshotState = { ...this.snapshotState, hrv: newest, hrvSeries: series, updatedAtMs: this.nowMs() };
      this.emit();
      return;
    }

    const daily = decodeDailyData(parsed.data, metric);
    const newest = latestByHour(daily.records);
    if (!newest) return;
    const series = [...daily.records].sort((a, b) => a.hourIdx - b.hourIdx);
    let seriesPatch: Partial<RingHealthSnapshot> = {};
    if (metric === "heartRate") {
      // The frame header carries the ring's live/current reading; surface it.
      seriesPatch = { heartRateSeries: series, currentHr: daily.current };
      this.dailyVitalDays.heartRate = localDayToken(this.nowMs());
    } else if (metric === "spo2") {
      seriesPatch = { spo2Series: series };
      this.dailyVitalDays.spo2 = localDayToken(this.nowMs());
    } else {
      this.dailyVitalDays.temperature = localDayToken(this.nowMs());
    }
    this.snapshotState = { ...this.snapshotState, [metric]: newest, ...seriesPatch, updatedAtMs: this.nowMs() };
    this.emit();
  }

  private emit(): void {
    // Activity is explicitly a current-local-day aggregate. The clock can roll
    // over while the app remains alive, so do not let yesterday's retained
    // buckets escape on an unrelated battery/vital notification.
    this.pruneExpiredActivity();
    this.pruneExpiredDailyVitals();
    const snapshot = this.snapshotState;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(snapshot);
      } catch (error) {
        // State has already been atomically installed. One UI/subscriber fault
        // must not block persistence or be misreported as a decode failure.
        this.log(`ring health: listener failed (${String(error)})`);
      }
    }
  }

  private pruneExpiredActivity(): void {
    if (this.snapshotState.activity &&
      !canonicalizeActivitySnapshot(this.snapshotState.activity, this.nowMs())) {
      this.snapshotState = { ...this.snapshotState, activity: null };
    }
  }

  private pruneExpiredDailyVitals(): void {
    const today = localDayToken(this.nowMs());
    let patch: Partial<RingHealthSnapshot> | null = null;
    if (this.dailyVitalDays.heartRate !== null && this.dailyVitalDays.heartRate !== today) {
      patch = { ...(patch ?? {}), heartRate: null, heartRateSeries: [], currentHr: null };
      this.dailyVitalDays.heartRate = null;
    }
    if (this.dailyVitalDays.spo2 !== null && this.dailyVitalDays.spo2 !== today) {
      patch = { ...(patch ?? {}), spo2: null, spo2Series: [] };
      this.dailyVitalDays.spo2 = null;
    }
    if (this.dailyVitalDays.temperature !== null && this.dailyVitalDays.temperature !== today) {
      patch = { ...(patch ?? {}), temperature: null };
      this.dailyVitalDays.temperature = null;
    }
    if (this.dailyVitalDays.hrv !== null && this.dailyVitalDays.hrv !== today) {
      patch = { ...(patch ?? {}), hrv: null, hrvSeries: [] };
      this.dailyVitalDays.hrv = null;
    }
    if (patch) this.snapshotState = { ...this.snapshotState, ...patch };
  }
}

function latestByHour<T extends { hourIdx: number }>(records: T[]): T | null {
  let newest: T | null = null;
  for (const record of records) {
    if (!newest || record.hourIdx >= newest.hourIdx) newest = record;
  }
  return newest;
}

/** Process-wide store instance; the dashboard controller feeds and reads it. */
export const ringHealthStore = new RingHealthStore();
