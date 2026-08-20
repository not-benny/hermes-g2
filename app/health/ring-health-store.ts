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
  decodeDailyData,
  parseFragment,
  parseInnerFrame,
  reassembleHealthFrames,
  decodeRingBattery,
  decodeRingFirmwareVersion,
  RING_HEALTH_CMD,
  type Bytes,
  type RingActivitySample,
  type RingFragment,
  type RingHealthSample,
  type RingHrvSample,
} from "./ring-parser";

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
  /** Latest activity batch: raw slots plus their summed step count. */
  activity: { slots: RingActivitySample[]; totalSteps: number } | null;
  /** Ring battery percent from the deviceStatus response. */
  batteryPercent: number | null;
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
  batteryPercent: null,
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

export class RingHealthStore {
  private snapshotState: RingHealthSnapshot = { ...EMPTY };
  private pending = new Map<number, RingFragment[]>();
  private pendingOrder: number[] = [];
  private listeners = new Set<(snapshot: RingHealthSnapshot) => void>();
  private log: (line: string) => void = () => {};

  /** Route decode diagnostics into the app log (optional). */
  setLog(log: (line: string) => void): void {
    this.log = log;
  }

  snapshot(): RingHealthSnapshot {
    return this.snapshotState;
  }

  onChange(listener: (snapshot: RingHealthSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drop pending fragments and decoded values (ring unpaired / new session). */
  reset(): void {
    this.pending.clear();
    this.pendingOrder = [];
    this.snapshotState = { ...EMPTY };
    this.emit();
  }

  /**
   * Preview/demo only: install a complete mock snapshot and notify listeners, so
   * the Health tab + HUD look alive with no ring connected. Cleared via reset().
   */
  seedMock(snapshot: RingHealthSnapshot): void {
    this.snapshotState = snapshot;
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
      if (parsed.cmd === CMD_SYSTEM && parsed.subCmd === SUBCMD_DEVICE_STATUS) {
        const percent = decodeRingBattery(parsed.data);
        if (percent >= 0 && percent <= 100) {
          this.snapshotState = {
            ...this.snapshotState,
            batteryPercent: percent,
            updatedAtMs: Date.now(),
          };
          this.emit();
        }
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
            updatedAtMs: Date.now(),
          };
          this.emit();
        }
      }
      return;
    }
    if (parsed.module !== MODULE_HEALTH) return;
    if (parsed.data.length === 0) return; // bare command ACK, no records.
    const metric = RING_HEALTH_CMD[parsed.cmd];
    if (!metric) return; // sleep (cmd 6) and unknown cmds: layout not decoded yet.

    if (metric === "activity") {
      // Activity/steps/calories are NOT surfaced yet. Firmware RE (2026-08-20)
      // confirmed the ring stores 10-minute buckets of steps plus a
      // resting/active calorie split, but the cmd=5 record byte layout is still
      // an unvalidated stride-7 guess (see decodeDailyData "activity"). Surfacing
      // it would show wrong step/calorie numbers, so leave `activity` null -- the
      // UI then honestly renders "--" until cmd=5 is decoded against the captured
      // steps.csv/calories.csv ground truth.
      return;
    }

    if (metric === "hrv") {
      const daily = decodeDailyData(parsed.data, "hrv");
      const newest = latestByHour(daily.records);
      if (!newest) return;
      const series = [...daily.records].sort((a, b) => a.hourIdx - b.hourIdx);
      this.snapshotState = { ...this.snapshotState, hrv: newest, hrvSeries: series, updatedAtMs: Date.now() };
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
    } else if (metric === "spo2") {
      seriesPatch = { spo2Series: series };
    }
    this.snapshotState = { ...this.snapshotState, [metric]: newest, ...seriesPatch, updatedAtMs: Date.now() };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.snapshotState;
    for (const listener of Array.from(this.listeners)) {
      listener(snapshot);
    }
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
