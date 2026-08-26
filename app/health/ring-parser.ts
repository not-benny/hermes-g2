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
 * type-1 sleep summaries have also been validated against the ring firmware and
 * a complete overnight capture. Type-2 interval-only records still lack an
 * absolute time base and are deliberately rejected.
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
  /** Absolute epoch second when the daily header contains a valid day anchor. */
  timestampSec: number | null;
  /** Header timezone used to derive the record's local day, or null when unanchored. */
  timezoneOffsetMinutes: number | null;
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
  /** Absolute epoch second when the daily header contains a valid day anchor. */
  timestampSec: number | null;
  /** Header timezone used to derive the record's local day, or null when unanchored. */
  timezoneOffsetMinutes: number | null;
}

/** One confirmed 10-minute activity bucket (stride 7). */
export interface RingActivitySample {
  /** Ten-minute slot within the local day (0..143). */
  slot: number;
  /** Absolute bucket timestamp reconstructed from day base + slot * 600. */
  timestampSec: number;
  /** Step count for the slot. */
  steps: number;
  /** Ring-native active calories for the slot. */
  activeCalories: number;
  /** Ring-native total calories for the slot. */
  totalCalories: number;
  /** Derived total - active calories for the slot. */
  restingCalories: number;
}

/** Decoded daily-push payload for a single metric. */
export interface RingDailyData<T = RingHealthSample> {
  metric: RingMetric;
  /** Record count declared by the payload header ([0]). */
  count: number;
  /** Signed timezone offset in minutes from header bytes [1..2]. */
  timezoneOffsetMinutes: number;
  /** Local-midnight epoch second from header bytes [3..6]. */
  dayBaseSec: number;
  /** Timestamp of the header's current value, or null when stale/invalid. */
  currentTimestampSec: number | null;
  /** The frame's live/current reading (header, not a record): u8 for HR/SpO2,
   *  u16 for HRV. null when the payload is too short to carry it. */
  current: number | null;
  records: T[];
}

export interface RingActivityData extends RingDailyData<RingActivitySample> {
  current: null;
}

/** Firmware stage ids used by a type-1 sleep summary. */
export type RingSleepStageType = 0 | 1 | 2 | 3;

/** One run in the firmware's compact hypnogram (duration units are 30 seconds). */
export interface RingSleepStageRun {
  /** 0=awake, 1=REM, 2=light/core, 3=deep. */
  type: RingSleepStageType;
  halfMinutes: number;
}

/** Protocol-verified type-1 nightly summary carried by health cmd=6. */
export interface RingSleepData {
  recordType: 1;
  /** Ring-calculated sleep efficiency, percent. */
  efficiencyPct: number;
  /** Authoritative sleep score calculated by the ring. */
  score: number;
  /** Absolute nightly body/skin temperature in tenths of a degree C. */
  bodyTemperatureDeciC: number | null;
  timezoneOffsetMinutes: number;
  startTs: number;
  endTs: number;
  totalSleepSec: number;
  awakeSec: number;
  remSec: number;
  lightSec: number;
  deepSec: number;
  stages: RingSleepStageRun[];
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

function i16le(b: Bytes, o: number): number {
  const value = u16le(b, o);
  return value & 0x8000 ? value - 0x10000 : value;
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

/** Incoming inner-frame CRC-16/MODBUS with its own slot treated as zero. */
export function ringCrc16Modbus(inner: Bytes): number {
  let crc = 0xffff;
  for (let i = 0; i < inner.length; i++) {
    const byte = i === 10 || i === 11 ? 0 : inner[i];
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/** Strict activity-envelope gate; general legacy decoders remain lenient. */
export function isCanonicalRingInnerFrame(inner: Bytes): boolean {
  if (inner.length < 12 || inner[0] !== 0x64 || inner[2] !== 0x64) return false;
  const declared = u16le(inner, 8);
  if (declared !== inner.length) return false;
  return u16le(inner, 10) === ringCrc16Modbus(inner);
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

// Vital header: count, signed timezone offset, local-midnight day base, current
// value timestamp, current value, then hourly records.
const DAILY_TIMEZONE_OFF = 1;
const DAILY_DAY_BASE_OFF = 3;
const DAILY_CURRENT_TIMESTAMP_OFF = 7;
const DAILY_CURRENT_OFF = 11;
/** HR / SpO2 / temperature record: [hourIdx u8][avg u8][max u8][min u8]. */
const HEALTH_REC_OFF = 12;
const HEALTH_REC_STRIDE = 4;
/** HRV record: [hourIdx u8][avg u16 LE][max u16 LE][min u16 LE]. */
const HRV_REC_OFF = 13;
const HRV_REC_STRIDE = 7;
/** Activity header: count u8, signed timezone offset i16 LE, local-day base u32 LE. */
const ACTIVITY_REC_OFF = 7;
const ACTIVITY_REC_STRIDE = 7;

function positiveMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function hasValidDayAnchor(timezoneOffsetMinutes: number, dayBaseSec: number): boolean {
  return timezoneOffsetMinutes >= -840 && timezoneOffsetMinutes <= 840 &&
    dayBaseSec !== 0 && positiveMod(dayBaseSec + timezoneOffsetMinutes * 60, 86400) === 0;
}

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
): RingActivityData;
export function decodeDailyData(
  payload: Bytes,
  metric: RingMetric,
): RingDailyData<RingHealthSample | RingHrvSample> | RingActivityData {
  if (metric === "activity") {
    if (payload.length < ACTIVITY_REC_OFF) {
      throw new Error(`ring activity payload too short: ${payload.length} bytes`);
    }
    const count = payload[0];
    const timezoneOffsetMinutes = i16le(payload, 1);
    const dayBaseSec = u32le(payload, 3);
    const required = ACTIVITY_REC_OFF + count * ACTIVITY_REC_STRIDE;
    if (required > payload.length) {
      throw new Error(`ring activity payload truncated: need ${required}, got ${payload.length}`);
    }
    const records: RingActivitySample[] = [];
    for (let i = 0; i < count; i++) {
      const o = ACTIVITY_REC_OFF + i * ACTIVITY_REC_STRIDE;
      const slot = payload[o];
      if (slot > 143) throw new Error(`ring activity slot out of range: ${slot}`);
      const activeCalories = u16le(payload, o + 3);
      const totalCalories = u16le(payload, o + 5);
      if (activeCalories > totalCalories) {
        throw new Error(`ring activity calories invalid: active ${activeCalories} > total ${totalCalories}`);
      }
      records.push({
        slot,
        timestampSec: dayBaseSec + slot * 600,
        steps: u16le(payload, o + 1),
        activeCalories,
        totalCalories,
        restingCalories: totalCalories - activeCalories,
      });
    }
    return {
      metric, count, timezoneOffsetMinutes, dayBaseSec,
      currentTimestampSec: null, current: null, records,
    };
  }

  if (payload.length < DAILY_CURRENT_OFF) {
    throw new Error(`ring daily payload too short: ${payload.length} bytes`);
  }
  const count = payload[0];
  const timezoneOffsetMinutes = i16le(payload, DAILY_TIMEZONE_OFF);
  const dayBaseSec = u32le(payload, DAILY_DAY_BASE_OFF);
  const currentTimestampCandidate = u32le(payload, DAILY_CURRENT_TIMESTAMP_OFF);
  const validDayAnchor = hasValidDayAnchor(timezoneOffsetMinutes, dayBaseSec);
  const currentTimestampSec = validDayAnchor && currentTimestampCandidate >= dayBaseSec &&
    currentTimestampCandidate < dayBaseSec + 86400 ? currentTimestampCandidate : null;
  const timestampForHour = (hourIdx: number): number | null =>
    validDayAnchor && hourIdx >= 0 && hourIdx <= 23 ? dayBaseSec + hourIdx * 3600 : null;

  if (metric === "hrv") {
    const current = payload.length >= HRV_REC_OFF ? u16le(payload, DAILY_CURRENT_OFF) : null;
    const required = HRV_REC_OFF + count * HRV_REC_STRIDE;
    if (required > payload.length) {
      throw new Error(`ring HRV payload truncated: need ${required}, got ${payload.length}`);
    }
    const records: RingHrvSample[] = [];
    for (let i = 0; i < count; i++) {
      const o = HRV_REC_OFF + i * HRV_REC_STRIDE;
      records.push({
        hourIdx: payload[o],
        avg: u16le(payload, o + 1),
        max: u16le(payload, o + 3),
        min: u16le(payload, o + 5),
        timestampSec: timestampForHour(payload[o]),
        timezoneOffsetMinutes: validDayAnchor ? timezoneOffsetMinutes : null,
      });
    }
    return { metric, count, timezoneOffsetMinutes, dayBaseSec, currentTimestampSec, current, records };
  }

  // heartRate / spo2 / temperature: single-byte avg/max/min per hour.
  const current = payload.length >= HEALTH_REC_OFF ? payload[DAILY_CURRENT_OFF] : null;
  const required = HEALTH_REC_OFF + count * HEALTH_REC_STRIDE;
  if (required > payload.length) {
    throw new Error(`ring daily payload truncated: need ${required}, got ${payload.length}`);
  }
  const records: RingHealthSample[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEALTH_REC_OFF + i * HEALTH_REC_STRIDE;
    records.push({
      hourIdx: payload[o],
      avg: payload[o + 1],
      max: payload[o + 2],
      min: payload[o + 3],
      timestampSec: timestampForHour(payload[o]),
      timezoneOffsetMinutes: validDayAnchor ? timezoneOffsetMinutes : null,
    });
  }
  return { metric, count, timezoneOffsetMinutes, dayBaseSec, currentTimestampSec, current, records };
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

// --- temperature + sleep ----------------------------------------------------

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

const SLEEP_FIXED_BYTES = 32;
const SLEEP_STAGE_BYTES = 3;
const SLEEP_TRAILER_BYTES = 4;
const SLEEP_MAX_SECONDS = 24 * 60 * 60;
const SLEEP_MIN_EPOCH_SEC = 946684800; // 2000-01-01; rejects relative type-2 values.

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/**
 * Validate and defensively copy a decoded/persisted type-1 sleep summary.
 *
 * This is intentionally stricter than a UI model: every aggregate must agree
 * with both the absolute interval and the compact stage runs. It therefore
 * cannot turn an interval-only type-2 record or partially decoded bytes into a
 * user-visible night.
 */
export function canonicalizeRingSleepData(value: unknown): RingSleepData | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<RingSleepData>;
  if (raw.recordType !== 1 ||
    !isIntegerIn(raw.efficiencyPct, 0, 100) ||
    !isIntegerIn(raw.score, 0, 100) ||
    !isIntegerIn(raw.timezoneOffsetMinutes, -840, 840) ||
    !isIntegerIn(raw.startTs, SLEEP_MIN_EPOCH_SEC, 0xffffffff) ||
    !isIntegerIn(raw.endTs, SLEEP_MIN_EPOCH_SEC + 1, 0xffffffff) ||
    !isIntegerIn(raw.totalSleepSec, 0, SLEEP_MAX_SECONDS) ||
    !isIntegerIn(raw.awakeSec, 0, SLEEP_MAX_SECONDS) ||
    !isIntegerIn(raw.remSec, 0, SLEEP_MAX_SECONDS) ||
    !isIntegerIn(raw.lightSec, 0, SLEEP_MAX_SECONDS) ||
    !isIntegerIn(raw.deepSec, 0, SLEEP_MAX_SECONDS) ||
    !Array.isArray(raw.stages) || raw.stages.length < 1 || raw.stages.length > 255) return null;
  if (raw.bodyTemperatureDeciC !== null &&
    !isIntegerIn(raw.bodyTemperatureDeciC, 200, 450)) return null;

  const intervalSec = raw.endTs - raw.startTs;
  const totals = [raw.totalSleepSec, raw.awakeSec, raw.remSec, raw.lightSec, raw.deepSec] as number[];
  if (intervalSec <= 0 || intervalSec > SLEEP_MAX_SECONDS || intervalSec % 30 !== 0 ||
    totals.some((seconds) => seconds % 30 !== 0) ||
    raw.totalSleepSec !== raw.remSec + raw.lightSec + raw.deepSec ||
    intervalSec !== raw.totalSleepSec + raw.awakeSec ||
    raw.efficiencyPct !== Math.floor(raw.totalSleepSec * 100 / intervalSec)) return null;

  const stageTotals = [0, 0, 0, 0];
  const stages: RingSleepStageRun[] = [];
  for (const candidate of raw.stages) {
    if (!candidate || typeof candidate !== "object") return null;
    const stage = candidate as Partial<RingSleepStageRun>;
    if (!isIntegerIn(stage.type, 0, 3) || !isIntegerIn(stage.halfMinutes, 1, 0xffff)) return null;
    if (stages.at(-1)?.type === stage.type) return null;
    stageTotals[stage.type] += stage.halfMinutes * 30;
    if (stageTotals[stage.type] > SLEEP_MAX_SECONDS) return null;
    stages.push({ type: stage.type as RingSleepStageType, halfMinutes: stage.halfMinutes });
  }
  if (stageTotals[0] !== raw.awakeSec || stageTotals[1] !== raw.remSec ||
    stageTotals[2] !== raw.lightSec || stageTotals[3] !== raw.deepSec) return null;

  return {
    recordType: 1,
    efficiencyPct: raw.efficiencyPct,
    score: raw.score,
    bodyTemperatureDeciC: raw.bodyTemperatureDeciC,
    timezoneOffsetMinutes: raw.timezoneOffsetMinutes,
    startTs: raw.startTs,
    endTs: raw.endTs,
    totalSleepSec: raw.totalSleepSec,
    awakeSec: raw.awakeSec,
    remSec: raw.remSec,
    lightSec: raw.lightSec,
    deepSec: raw.deepSec,
    stages,
  };
}

/**
 * Decode the firmware's complete type-1 cmd=6 sleep summary.
 *
 * Fixed fields are followed by `count` three-byte stage runs
 * `[stage u8][duration u16 LE]` and a four-byte protocol trailer. The trailer
 * is retained as an envelope invariant but not interpreted. Type-2 records are
 * interval-only and lack an absolute base, so this decoder rejects them.
 */
export function decodeSleep(payload: Bytes): RingSleepData {
  if (payload.length < 1) {
    throw new Error(`ring sleep payload too short: ${payload.length} bytes`);
  }
  if (payload[0] !== 1) {
    throw new Error(`unsupported ring sleep record type: ${payload[0]}`);
  }
  if (payload.length < SLEEP_FIXED_BYTES + SLEEP_STAGE_BYTES + SLEEP_TRAILER_BYTES) {
    throw new Error(`ring sleep payload too short: ${payload.length} bytes`);
  }
  const count = payload[30];
  const required = SLEEP_FIXED_BYTES + count * SLEEP_STAGE_BYTES + SLEEP_TRAILER_BYTES;
  if (count === 0 || payload.length !== required) {
    throw new Error(`ring sleep payload length mismatch: need ${required}, got ${payload.length}`);
  }
  // Firmware leaves these alignment/reserved bytes zero in the type-1 schema.
  if (payload[3] !== 0 || payload[31] !== 0) {
    throw new Error("ring sleep reserved bytes are non-zero");
  }
  // The firmware quantizes three stage shares and constructs byte 4 as their
  // remainder from 100, so the four display percentages sum exactly. Duration
  // totals/runs below remain the stronger semantic integrity check.
  const stagePercentages = [payload[4], payload[5], payload[6], payload[7]];
  if (stagePercentages.some((value) => value > 100) ||
    stagePercentages.reduce((sum, value) => sum + value, 0) !== 100) {
    throw new Error("ring sleep stage percentages are invalid");
  }

  const stages: RingSleepStageRun[] = [];
  for (let index = 0; index < count; index++) {
    const offset = SLEEP_FIXED_BYTES + index * SLEEP_STAGE_BYTES;
    stages.push({ type: payload[offset] as RingSleepStageType, halfMinutes: u16le(payload, offset + 1) });
  }
  const bodyTemperatureRaw = u16le(payload, 8);
  const decoded = canonicalizeRingSleepData({
    recordType: 1,
    efficiencyPct: payload[1],
    score: payload[2],
    bodyTemperatureDeciC: bodyTemperatureRaw === 0 ? null : bodyTemperatureRaw,
    timezoneOffsetMinutes: i16le(payload, 10),
    startTs: u32le(payload, 12),
    endTs: u32le(payload, 16),
    totalSleepSec: u16le(payload, 20),
    awakeSec: u16le(payload, 22),
    remSec: u16le(payload, 24),
    lightSec: u16le(payload, 26),
    deepSec: u16le(payload, 28),
    stages,
  });
  if (!decoded) throw new Error("ring sleep summary invariants failed");
  return decoded;
}
