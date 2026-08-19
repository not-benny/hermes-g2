/**
 * Pure decoder for the R1 ring's health daily-data wire format.
 *
 * The ring pushes daily health history over the bae80013 notify characteristic
 * as CRC-checked multi-packet frames. This module holds the framework-agnostic
 * decode path: reassemble the fragments, verify the transport CRC-32, unwrap the
 * inner frame envelope, and turn the daily-push payload into typed records. It
 * has no NativeScript or Android dependencies so it can run under plain Node for
 * tests, and a HUD/state layer consumes the exported types.
 *
 * Wire format was reverse-engineered from a real capture and validated end to
 * end: every multi-packet frame reassembled and every crc32 matched its batch
 * id. The temperature-detail and sleep layouts were not observed on-device and
 * are left as marked stubs rather than guessed.
 */

/** A byte source: anything indexable that yields 0..255 values. */
export type Bytes = Uint8Array;

/** Health metrics carried by the daily-push payload (module=health, per cmd). */
export type RingMetric =
  | "heartRate"
  | "spo2"
  | "temperature"
  | "hrv"
  | "activity";

/** cmd byte -> metric, for module=health(2) daily-push frames. */
export const RING_HEALTH_CMD: Record<number, RingMetric> = {
  1: "heartRate",
  2: "spo2",
  3: "temperature",
  4: "hrv",
  5: "activity",
};

/**
 * One hourly HR / SpO2 / temperature record (stride 9). Values are direct:
 * bpm for heart rate, percent for SpO2.
 */
export interface RingHealthSample {
  /** Record timestamp, epoch seconds. */
  ts: number;
  /** Most recent reading in the hour. */
  latest: number;
  /** Hour-of-day index the record belongs to. */
  hourIdx: number;
  /** Hourly average. */
  avg: number;
  /** Hourly maximum. */
  max: number;
  /** Hourly minimum. */
  min: number;
}

/** One HRV record (stride 13). `latest` is in milliseconds. */
export interface RingHrvSample {
  /** Record timestamp, epoch seconds. */
  ts: number;
  /** Most recent HRV reading, milliseconds. */
  latest: number;
  /** Hour-of-day index the record belongs to. */
  hourIdx: number;
  /** Three trailing u16 fields whose exact meaning is not yet pinned down. */
  field1: number;
  field2: number;
  field3: number;
}

/**
 * One activity/steps record (stride 7). Activity is a slot-indexed 144-hour
 * circular buffer, so `slot` is the buffer position rather than a timestamp.
 */
export interface RingActivitySample {
  /** Circular-buffer slot index (0..143). */
  slot: number;
  /** Step count for the slot. */
  steps: number;
  /** Auxiliary field 1 (units not yet pinned down). */
  f1: number;
  /** Auxiliary field 2 (units not yet pinned down). */
  f2: number;
}

/** Decoded daily-push payload for a single metric. */
export interface RingDailyData<T = RingHealthSample> {
  metric: RingMetric;
  /** Sampling interval in minutes (observed 60). */
  interval: number;
  /** Base timestamp for the batch, epoch seconds. */
  baseTs: number;
  /** Record count declared by the payload header. */
  count: number;
  records: T[];
}

/** Unwrapped inner-frame envelope fields. */
export interface RingInnerFrame {
  module: number;
  version: number;
  serial: number;
  status: number;
  cmd: number;
  subCmd: number;
  /** Declared inner length (bytes 8..9). */
  innerLen: number;
  crc16: number;
  /** Payload region (inner[12 .. innerLen]). */
  data: Bytes;
}

/** Result of reassembling one batch of health fragments. */
export interface RingReassembly {
  /** Batch id from the fragment header (frame bytes 1..4, little-endian). */
  batchId: number;
  /** Concatenated inner buffer, CRC-verified against batchId. */
  inner: Bytes;
}

// --- little-endian readers -------------------------------------------------

function u16le(b: Bytes, o: number): number {
  return (b[o] | (b[o + 1] << 8)) >>> 0;
}

function u32le(b: Bytes, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

// --- CRC-32 (transport checksum) -------------------------------------------

// CRC-32, poly 0x1EDC6F41 (Castagnoli), MSB-first, init 0, no xorout. This is
// the same algorithm the Java side uses (FaceclawBleCommunicator.ringCrc32 /
// RING_CRC32_TABLE); the frame stores it little-endian at frame bytes 1..4.
const RING_CRC32_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) {
      c = (c & 0x80000000) !== 0 ? (c << 1) ^ 0x1edc6f41 : c << 1;
    }
    t[i] = c;
  }
  return t;
})();

/** CRC-32 over `bytes`, returned as an unsigned 32-bit number. */
export function ringCrc32(bytes: Bytes): number {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) {
    c = (c << 8) ^ RING_CRC32_TABLE[((c >>> 24) ^ bytes[i]) & 0xff];
  }
  return c >>> 0;
}

// --- fragment reassembly ---------------------------------------------------

/**
 * A single notify fragment: a 5-byte chunk header [fragIndex u8][batchId u32 LE]
 * followed by the fragment payload.
 */
export interface RingFragment {
  fragIndex: number;
  batchId: number;
  payload: Bytes;
}

/** Split a raw notify frame into its fragment header and payload. */
export function parseFragment(frame: Bytes): RingFragment {
  if (frame.length < 5) {
    throw new Error(`ring fragment too short: ${frame.length} bytes`);
  }
  return {
    fragIndex: frame[0],
    batchId: u32le(frame, 1),
    payload: frame.subarray(5),
  };
}

/**
 * Reassemble one batch of health fragments into its inner buffer.
 *
 * Fragments of a batch share the batch id in frame bytes 1..4 and arrive in
 * descending fragIndex order down to 0. Payloads (the bytes after each 5-byte
 * chunk header) are concatenated in descending fragIndex order to form the
 * inner buffer, then ringCrc32(inner) is asserted to equal the batch id.
 *
 * Accepts either raw notify frames (Uint8Array) or pre-parsed RingFragment
 * objects. Throws if the fragments disagree on batch id or the CRC fails.
 */
export function reassembleHealthFrames(
  fragments: Array<Bytes | RingFragment>,
): RingReassembly {
  if (fragments.length === 0) {
    throw new Error("no ring fragments to reassemble");
  }
  const parsed: RingFragment[] = fragments.map((f) =>
    f instanceof Uint8Array ? parseFragment(f) : f,
  );
  const batchId = parsed[0].batchId;
  for (const p of parsed) {
    if (p.batchId !== batchId) {
      throw new Error(
        `ring fragment batch mismatch: ${p.batchId} != ${batchId}`,
      );
    }
  }
  // Descending fragIndex order; a stable sort keeps arrival order for ties.
  const ordered = parsed.slice().sort((a, b) => b.fragIndex - a.fragIndex);
  let total = 0;
  for (const p of ordered) {
    total += p.payload.length;
  }
  const inner = new Uint8Array(total);
  let off = 0;
  for (const p of ordered) {
    inner.set(p.payload, off);
    off += p.payload.length;
  }
  const crc = ringCrc32(inner);
  if (crc !== batchId) {
    throw new Error(
      `ring reassembly CRC mismatch: crc32=${crc} batchId=${batchId}`,
    );
  }
  return { batchId, inner };
}

// --- inner-frame envelope --------------------------------------------------

/**
 * Unwrap the inner-frame envelope. Layout:
 *   [0] 0x64  [1] module  [2] 0x64(version)  [3..4] serial u16 LE
 *   [5] status  [6] cmd  [7] subCmd  [8..9] innerLen u16 LE
 *   [10..11] crc16  [12 .. innerLen] data
 */
export function parseInnerFrame(inner: Bytes): RingInnerFrame {
  if (inner.length < 12) {
    throw new Error(`ring inner frame too short: ${inner.length} bytes`);
  }
  const innerLen = u16le(inner, 8);
  const end = Math.min(innerLen, inner.length);
  return {
    module: inner[1],
    version: inner[2],
    serial: u16le(inner, 3),
    status: inner[5],
    cmd: inner[6],
    subCmd: inner[7],
    innerLen,
    crc16: u16le(inner, 10),
    data: inner.subarray(12, Math.max(12, end)),
  };
}

// --- daily-push payload ----------------------------------------------------

const HEALTH_STRIDE_9 = 9;
const HRV_STRIDE = 13;
const ACTIVITY_STRIDE = 7;
/** Records begin after [count u8][interval u16 LE][base_ts u32 LE]. */
const DAILY_HEADER_LEN = 7;

/**
 * Decode a daily-push payload for a single metric.
 *
 * `payload` is the inner-frame data region (RingInnerFrame.data). Header:
 *   [count u8][interval u16 LE = minutes][base_ts u32 LE = epoch seconds]
 * followed by fixed-stride records selected by metric.
 */
export function decodeDailyData(
  payload: Bytes,
  metric: "heartRate" | "spo2" | "temperature",
): RingDailyData<RingHealthSample>;
export function decodeDailyData(
  payload: Bytes,
  metric: "hrv",
): RingDailyData<RingHrvSample>;
export function decodeDailyData(
  payload: Bytes,
  metric: "activity",
): RingDailyData<RingActivitySample>;
export function decodeDailyData(
  payload: Bytes,
  metric: RingMetric,
): RingDailyData<RingHealthSample | RingHrvSample | RingActivitySample> {
  if (payload.length < DAILY_HEADER_LEN) {
    throw new Error(
      `ring daily payload too short: ${payload.length} bytes`,
    );
  }
  const count = payload[0];
  const interval = u16le(payload, 1);
  const baseTs = u32le(payload, 3);
  const recs = payload.subarray(DAILY_HEADER_LEN);

  if (metric === "hrv") {
    const records: RingHrvSample[] = [];
    for (let i = 0; i < count; i++) {
      const o = i * HRV_STRIDE;
      if (o + HRV_STRIDE > recs.length) break;
      records.push({
        ts: u32le(recs, o),
        latest: u16le(recs, o + 4),
        hourIdx: recs[o + 6],
        field1: u16le(recs, o + 7),
        field2: u16le(recs, o + 9),
        field3: u16le(recs, o + 11),
      });
    }
    return { metric, interval, baseTs, count, records };
  }

  if (metric === "activity") {
    const records: RingActivitySample[] = [];
    for (let i = 0; i < count; i++) {
      const o = i * ACTIVITY_STRIDE;
      if (o + ACTIVITY_STRIDE > recs.length) break;
      records.push({
        slot: recs[o],
        steps: u16le(recs, o + 1),
        f1: u16le(recs, o + 3),
        f2: u16le(recs, o + 5),
      });
    }
    return { metric, interval, baseTs, count, records };
  }

  // heartRate / spo2 / temperature all share the stride-9 layout.
  const records: RingHealthSample[] = [];
  for (let i = 0; i < count; i++) {
    const o = i * HEALTH_STRIDE_9;
    if (o + HEALTH_STRIDE_9 > recs.length) break;
    records.push({
      ts: u32le(recs, o),
      latest: recs[o + 4],
      hourIdx: recs[o + 5],
      avg: recs[o + 6],
      max: recs[o + 7],
      min: recs[o + 8],
    });
  }
  return { metric, interval, baseTs, count, records };
}

// --- device status ---------------------------------------------------------

/**
 * Ring battery percent from a deviceStatus response payload.
 *
 * Source frame: module=system(1), cmd=system(0), subCmd=deviceStatus(1),
 * status=3. Battery percent is the first data byte.
 */
export function decodeRingBattery(deviceStatusData: Bytes): number {
  if (deviceStatusData.length < 1) {
    throw new Error("ring deviceStatus payload is empty");
  }
  return deviceStatusData[0];
}

// --- unobserved layouts (stubs) --------------------------------------------

/**
 * TODO: temperature-detail record layout is not yet decoded.
 *
 * The hourly temperature summary rides the stride-9 layout via
 * decodeDailyData(payload, "temperature"). A separate high-resolution
 * temperature-detail record was never observed on-device (the ring was not worn
 * long enough), so its byte layout is unknown. Do not guess it. Capture a real
 * temperature-detail frame, confirm the stride, then implement here.
 */
export function decodeTemperatureDetail(_payload: Bytes): never {
  throw new Error("ring temperature-detail layout not yet observed");
}

/**
 * TODO: sleep record layout is not yet decoded.
 *
 * No sleep frame was captured (the ring was not worn overnight during the
 * session), so the record stride and field meanings are unknown. Do not guess
 * the layout. Capture a real sleep frame, confirm the stride, then implement
 * here.
 */
export function decodeSleep(_payload: Bytes): never {
  throw new Error("ring sleep layout not yet observed");
}
