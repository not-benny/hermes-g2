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
 * id. Temperature has no separate record (it rides the stride-9 hourly layout);
 * only the sleep-stage layout remains unobserved and is left as a marked stub
 * rather than guessed.
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
 * One hourly HR / SpO2 / temperature record. Each record is 4 bytes:
 * [hourIdx u8][avg u8][max u8][min u8]. Values are direct: bpm for heart rate,
 * percent for SpO2. See notes/ring-daily-layout-2026-08-20.md.
 */
export interface RingHealthSample {
  /** Hour-of-day index the record belongs to (0..23). */
  hourIdx: number;
  /** Hourly average. */
  avg: number;
  /** Hourly maximum. */
  max: number;
  /** Hourly minimum. */
  min: number;
}

/**
 * One HRV record. Each record is 7 bytes: [hourIdx u8][avg u16 LE][max u16 LE]
 * [min u16 LE]. Values are milliseconds.
 */
export interface RingHrvSample {
  /** Hour-of-day index the record belongs to (0..23). */
  hourIdx: number;
  /** Hourly average HRV, milliseconds. */
  avg: number;
  /** Hourly maximum HRV, milliseconds. */
  max: number;
  /** Hourly minimum HRV, milliseconds. */
  min: number;
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
  /** Record count declared by the payload header ([0]). */
  count: number;
  /** Header u32 at [7..10]; exact meaning TBD (varies per metric). */
  base: number;
  /** The frame's live/current reading (header, not a record): u8 for HR/SpO2,
   *  u16 for HRV. null when the payload is too short to carry it. */
  current: number | null;
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

// Header before the records (notes/ring-daily-layout-2026-08-20.md):
//   [0]      count  u8
//   [1..6]   reserved (zero)
//   [7..10]  base   u32 LE (meaning TBD; low byte varies per metric)
//   [11..]   current reading (u8 HR/SpO2, u16 LE HRV), then the records.
const DAILY_BASE_OFF = 7;
const DAILY_CURRENT_OFF = 11;
/** HR / SpO2 / temperature record: [hourIdx u8][avg u8][max u8][min u8]. */
const HEALTH_REC_OFF = 12;
const HEALTH_REC_STRIDE = 4;
/** HRV record: [hourIdx u8][avg u16 LE][max u16 LE][min u16 LE]. */
const HRV_REC_OFF = 13;
const HRV_REC_STRIDE = 7;
/** Activity/steps layout is not yet validated against ground truth; kept as the
 *  earlier stride-7 read after the 7-byte header. TODO: RE and confirm. */
const ACTIVITY_REC_OFF = 7;
const ACTIVITY_REC_STRIDE = 7;

/**
 * Decode a daily-push payload for a single metric.
 *
 * `payload` is the inner-frame data region (RingInnerFrame.data). See the header
 * layout above; records are selected by metric.
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
  if (payload.length < DAILY_CURRENT_OFF) {
    throw new Error(`ring daily payload too short: ${payload.length} bytes`);
  }
  const count = payload[0];
  const base = u32le(payload, DAILY_BASE_OFF);

  if (metric === "hrv") {
    const current = payload.length >= HRV_REC_OFF ? u16le(payload, DAILY_CURRENT_OFF) : null;
    const records: RingHrvSample[] = [];
    for (let i = 0; i < count; i++) {
      const o = HRV_REC_OFF + i * HRV_REC_STRIDE;
      if (o + HRV_REC_STRIDE > payload.length) break;
      records.push({
        hourIdx: payload[o],
        avg: u16le(payload, o + 1),
        max: u16le(payload, o + 3),
        min: u16le(payload, o + 5),
      });
    }
    return { metric, count, base, current, records };
  }

  if (metric === "activity") {
    const records: RingActivitySample[] = [];
    for (let i = 0; i < count; i++) {
      const o = ACTIVITY_REC_OFF + i * ACTIVITY_REC_STRIDE;
      if (o + ACTIVITY_REC_STRIDE > payload.length) break;
      records.push({
        slot: payload[o],
        steps: u16le(payload, o + 1),
        f1: u16le(payload, o + 3),
        f2: u16le(payload, o + 5),
      });
    }
    return { metric, count, base, current: null, records };
  }

  // heartRate / spo2 / temperature: single-byte avg/max/min per hour.
  const current = payload.length >= HEALTH_REC_OFF ? payload[DAILY_CURRENT_OFF] : null;
  const records: RingHealthSample[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEALTH_REC_OFF + i * HEALTH_REC_STRIDE;
    if (o + HEALTH_REC_STRIDE > payload.length) break;
    records.push({
      hourIdx: payload[o],
      avg: payload[o + 1],
      max: payload[o + 2],
      min: payload[o + 3],
    });
  }
  return { metric, count, base, current, records };
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

/**
 * Firmware version from a deviceInfo response payload.
 *
 * The first field is a NUL-padded 16-byte ASCII string (observed 2.2.8.0002).
 * Ignore later device metadata fields in the same response.
 */
export function decodeRingFirmwareVersion(deviceInfoData: Bytes): string {
  const chars: string[] = [];
  const end = Math.min(16, deviceInfoData.length);
  for (let i = 0; i < end && deviceInfoData[i] !== 0; i++) {
    if (deviceInfoData[i] < 0x20 || deviceInfoData[i] > 0x7e) return "";
    chars.push(String.fromCharCode(deviceInfoData[i]));
  }
  return chars.join("");
}

// --- unobserved layouts (stubs) --------------------------------------------

/**
 * There is NO separate temperature-detail record (RE conclusion, specs/
 * even-protocol.md 2026-08-20). Temperature rides the same stride-9 hourly
 * layout as HR / SpO2 (cmd=3) and decodes via decodeDailyData(payload,
 * "temperature") the moment the ring is worn - no dedicated frame or extra
 * code. This defensive stub only exists so a stray caller fails loudly rather
 * than inventing a layout that does not exist; nothing should call it.
 */
export function decodeTemperatureDetail(_payload: Bytes): never {
  throw new Error("no separate ring temperature-detail record; use the stride-9 hourly path");
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
