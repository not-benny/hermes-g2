export type MotionRate = "low" | "interactive";
export type CalibrationQuality = "uncalibrated" | "poor" | "fair" | "good";
export type CompassQuality = "unavailable" | "calibrating" | "poor" | "fair" | "good" | "interference";
export type MotionState = "inactive" | "starting" | "live" | "stale" | "disconnected";

export type ImuSample = { x: number; y: number; z: number; source: number };
export type CompassSample = { command: number; headingDegrees: number };

export type Orientation = {
  pitchDegrees: number;
  rollDegrees: number;
  level: boolean;
  posture: "up" | "neutral" | "down" | "unknown";
};

export type MotionSnapshot = {
  state: MotionState;
  sessionGeneration: number | null;
  deviceId: string | null;
  headingDegrees: number | null;
  compassQuality: CompassQuality;
  imuReading: ImuSample | null;
  orientation: Orientation | null;
  calibrationQuality: CalibrationQuality;
  lastSampleAtMs: number | null;
  acceptedSamples: number;
  rejectedSamples: number;
};

export type MotionRequest = {
  imuRate?: MotionRate;
  compass?: boolean;
};

export type MotionLease = {
  setActive(active: boolean): void;
  release(): void;
};

export type MotionSource = {
  setImuEnabled(enabled: boolean, paceCode: number): void;
  setCompassEnabled(enabled: boolean): void;
  onImu(listener: (sample: ImuSample) => void): () => void;
  onCompass(listener: (sample: CompassSample) => void): () => void;
};

export type MotionPersistence = {
  load(): unknown;
  save(record: MotionCalibrationRecordV1): boolean;
};

export type MotionCalibrationRecordV1 = {
  schemaVersion: 1;
  algorithmVersion: "motion-v1";
  deviceId: string;
  quality: Exclude<CalibrationQuality, "uncalibrated">;
  calibratedAtMs: number;
  neutralVector: { x: number; y: number; z: number };
  headingOffsetDegrees: number;
};

type LeaseRecord = {
  request: MotionRequest;
  listener: (snapshot: MotionSnapshot) => void;
  active: boolean;
  released: boolean;
};

const COMPASS_CHANGED = 15;
const COMPASS_CALIBRATION_STARTED = 16;
const COMPASS_CALIBRATION_COMPLETE = 17;
const SAMPLE_FRESH_MS = 3_000;
const MIN_VECTOR_MAGNITUDE = 0.2;
const MAX_VECTOR_MAGNITUDE = 4;
const INTERFERENCE_DELTA_DEGREES = 85;
const REACQUIRE_TOLERANCE_DEGREES = 25;
const CALIBRATION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1_000;
const CALIBRATION_FUTURE_TOLERANCE_MS = 60_000;
const RATE_PACE: Record<MotionRate, number> = { low: 500, interactive: 200 };

export function normalizeHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function circularDelta(fromDegrees: number, toDegrees: number): number {
  const delta = normalizeHeading(toDegrees - fromDegrees + 180) - 180;
  return delta === -180 ? 180 : delta;
}

export function deriveOrientation(vector: { x: number; y: number; z: number }, neutralPitch = 0): Orientation | null {
  const { x, y, z } = vector;
  if (![x, y, z].every(Number.isFinite)) return null;
  const magnitude = Math.hypot(x, y, z);
  if (magnitude < MIN_VECTOR_MAGNITUDE || magnitude > MAX_VECTOR_MAGNITUDE) return null;
  const pitchDegrees = Math.atan2(x, Math.hypot(y, z)) * 180 / Math.PI;
  const rollDegrees = Math.atan2(y, z) * 180 / Math.PI;
  if (!Number.isFinite(pitchDegrees) || !Number.isFinite(rollDegrees)) return null;
  const relativePitch = pitchDegrees - neutralPitch;
  return {
    pitchDegrees,
    rollDegrees,
    level: Math.abs(relativePitch) <= 5 && Math.abs(rollDegrees) <= 5,
    posture: relativePitch >= 15 ? "up" : relativePitch <= -15 ? "down" : "neutral",
  };
}

function validCalibration(value: unknown, deviceId: string, nowMs: number): MotionCalibrationRecordV1 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<MotionCalibrationRecordV1>;
  const neutral = candidate.neutralVector;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.algorithmVersion !== "motion-v1" ||
    candidate.deviceId !== deviceId ||
    !["poor", "fair"].includes(String(candidate.quality)) ||
    !Number.isFinite(candidate.calibratedAtMs) ||
    !Number.isFinite(candidate.headingOffsetDegrees) ||
    candidate.calibratedAtMs! <= 0 ||
    candidate.calibratedAtMs! > nowMs + CALIBRATION_FUTURE_TOLERANCE_MS ||
    nowMs - candidate.calibratedAtMs! > CALIBRATION_MAX_AGE_MS ||
    Math.abs(candidate.headingOffsetDegrees!) > 180 ||
    !neutral ||
    ![neutral.x, neutral.y, neutral.z].every(Number.isFinite) ||
    !deriveOrientation(neutral)
  ) return null;
  return candidate as MotionCalibrationRecordV1;
}

export class MotionService {
  private source: MotionSource | null = null;
  private identity: { deviceId: string; sessionGeneration: number } | null = null;
  private sourceEpoch = 0;
  private offImu: (() => void) | null = null;
  private offCompass: (() => void) | null = null;
  private screenOn = false;
  private readonly leases = new Set<LeaseRecord>();
  private imuPace: number | null = null;
  private compassEnabled = false;
  private heading: number | null = null;
  private headingAtMs: number | null = null;
  private orientation: Orientation | null = null;
  private imuReading: ImuSample | null = null;
  private orientationAtMs: number | null = null;
  private compassQuality: CompassQuality = "unavailable";
  private calibrationQuality: CalibrationQuality = "uncalibrated";
  private calibration: MotionCalibrationRecordV1 | null = null;
  private stableHeadingCount = 0;
  private headingDiscontinuities = 0;
  private outlierCandidate: number | null = null;
  private outlierCandidateCount = 0;
  private calibrationActive = false;
  private calibrationHeadingCount = 0;
  private neutralSum = { x: 0, y: 0, z: 0 };
  private neutralCount = 0;
  private acceptedSamples = 0;
  private rejectedSamples = 0;
  private lastSampleAtMs: number | null = null;

  constructor(private readonly options: { now: () => number; persistence: MotionPersistence }) {}

  bind(source: MotionSource, identity: { deviceId: string; sessionGeneration: number }): void {
    this.stopSource();
    this.sourceEpoch++;
    this.source = source;
    this.identity = { ...identity };
    this.clearLiveSamples();
    this.calibration = validCalibration(this.options.persistence.load(), identity.deviceId, this.options.now());
    this.calibrationQuality = this.calibration?.quality ?? "uncalibrated";
    const epoch = this.sourceEpoch;
    this.offImu = source.onImu((sample) => {
      if (epoch !== this.sourceEpoch) return;
      this.acceptImu(sample);
    });
    this.offCompass = source.onCompass((sample) => {
      if (epoch !== this.sourceEpoch) return;
      this.acceptCompass(sample);
    });
    this.reconcile();
  }

  unbind(): void {
    this.stopSource();
    this.sourceEpoch++;
    this.source = null;
    this.identity = null;
    this.clearLiveSamples();
  }

  setScreenOn(on: boolean): void {
    if (this.screenOn === on) return;
    this.screenOn = on;
    if (!on) this.clearLiveSamples();
    this.sourceEpoch++;
    if (this.source) {
      const source = this.source;
      this.offImu?.();
      this.offCompass?.();
      const epoch = this.sourceEpoch;
      this.offImu = source.onImu((sample) => {
        if (epoch === this.sourceEpoch) this.acceptImu(sample);
      });
      this.offCompass = source.onCompass((sample) => {
        if (epoch === this.sourceEpoch) this.acceptCompass(sample);
      });
    }
    this.reconcile();
    this.dispatch();
  }

  acquire(request: MotionRequest, listener: (snapshot: MotionSnapshot) => void): MotionLease {
    const record: LeaseRecord = { request: { ...request }, listener, active: true, released: false };
    this.leases.add(record);
    this.reconcile();
    listener(this.snapshot());
    return {
      setActive: (active) => {
        if (record.released || record.active === active) return;
        record.active = active;
        this.reconcile();
        listener(this.snapshot());
      },
      release: () => {
        if (record.released) return;
        record.released = true;
        record.active = false;
        this.leases.delete(record);
        this.reconcile();
      },
    };
  }

  /**
   * Re-send the aggregate state after the native EvenHub session has warmed.
   * The transport can report connected before it accepts IMU controls, so the
   * first warm frame is the positive readiness boundary for this one retry.
   */
  reassertSourceState(): void {
    const source = this.source;
    if (!source) return;
    const desiredPace = this.screenOn ? this.desiredImuPace() : null;
    const desiredCompass = this.screenOn && this.desiredCompass();
    source.setImuEnabled(desiredPace !== null, desiredPace ?? this.imuPace ?? RATE_PACE.interactive);
    source.setCompassEnabled(desiredCompass);
    this.imuPace = desiredPace;
    this.compassEnabled = desiredCompass;
  }

  snapshot(): MotionSnapshot {
    const now = this.options.now();
    const headingFresh = this.headingAtMs !== null && now - this.headingAtMs <= SAMPLE_FRESH_MS;
    const orientationFresh = this.orientationAtMs !== null && now - this.orientationAtMs <= SAMPLE_FRESH_MS;
    const demanded = this.hasDemand();
    const live = (headingFresh && this.heading !== null) || (orientationFresh && this.orientation !== null);
    const state: MotionState = !this.source
      ? "disconnected"
      : !this.screenOn || !demanded
        ? "inactive"
        : live
          ? "live"
          : this.lastSampleAtMs === null
            ? "starting"
            : "stale";
    return {
      state,
      sessionGeneration: this.identity?.sessionGeneration ?? null,
      deviceId: this.identity?.deviceId ?? null,
      headingDegrees: headingFresh ? this.heading : null,
      compassQuality: headingFresh ? this.compassQuality : (this.compassQuality === "calibrating" ? "calibrating" : "unavailable"),
      imuReading: orientationFresh ? this.imuReading : null,
      orientation: orientationFresh ? this.orientation : null,
      calibrationQuality: this.calibrationQuality,
      lastSampleAtMs: this.lastSampleAtMs,
      acceptedSamples: this.acceptedSamples,
      rejectedSamples: this.rejectedSamples,
    };
  }

  private hasDemand(): boolean {
    for (const lease of this.leases) if (lease.active) return true;
    return false;
  }

  private desiredImuPace(): number | null {
    let rate: MotionRate | null = null;
    for (const lease of this.leases) {
      if (!lease.active || !lease.request.imuRate) continue;
      if (lease.request.imuRate === "interactive") return RATE_PACE.interactive;
      rate = "low";
    }
    return rate ? RATE_PACE[rate] : null;
  }

  private desiredCompass(): boolean {
    for (const lease of this.leases) if (lease.active && lease.request.compass) return true;
    return false;
  }

  private reconcile(): void {
    const source = this.source;
    const desiredPace = source && this.screenOn ? this.desiredImuPace() : null;
    const desiredCompass = Boolean(source && this.screenOn && this.desiredCompass());
    if (source && desiredPace !== this.imuPace) {
      source.setImuEnabled(desiredPace !== null, desiredPace ?? this.imuPace ?? RATE_PACE.interactive);
      this.imuPace = desiredPace;
    } else if (!source) {
      this.imuPace = null;
    }
    if (source && desiredCompass !== this.compassEnabled) {
      source.setCompassEnabled(desiredCompass);
      this.compassEnabled = desiredCompass;
    } else if (!source) {
      this.compassEnabled = false;
    }
  }

  private stopSource(): void {
    const source = this.source;
    if (source && this.imuPace !== null) source.setImuEnabled(false, this.imuPace);
    if (source && this.compassEnabled) source.setCompassEnabled(false);
    this.imuPace = null;
    this.compassEnabled = false;
    this.offImu?.();
    this.offCompass?.();
    this.offImu = null;
    this.offCompass = null;
  }

  private activeFor(kind: "imu" | "compass"): boolean {
    if (!this.source || !this.screenOn) return false;
    return kind === "imu" ? this.imuPace !== null : this.compassEnabled;
  }

  private acceptImu(sample: ImuSample): void {
    if (!this.activeFor("imu") || sample.source !== 1) {
      this.rejectedSamples++;
      return;
    }
    const derived = deriveOrientation(sample, this.neutralPitch());
    if (!derived) {
      this.rejectedSamples++;
      return;
    }
    const raw: Orientation = this.calibration
      ? derived
      : { ...derived, posture: "unknown" };
    const now = this.options.now();
    this.orientation = raw;
    this.imuReading = { ...sample };
    this.orientationAtMs = now;
    this.lastSampleAtMs = now;
    this.acceptedSamples++;
    if (
      this.calibrationActive &&
      this.neutralCount < 20 &&
      Math.abs(raw.pitchDegrees) <= 10 &&
      Math.abs(raw.rollDegrees) <= 10
    ) {
      this.neutralSum.x += sample.x;
      this.neutralSum.y += sample.y;
      this.neutralSum.z += sample.z;
      this.neutralCount++;
    }
    this.dispatch();
  }

  private acceptCompass(sample: CompassSample): void {
    if (!this.activeFor("compass")) {
      this.rejectedSamples++;
      return;
    }
    if (sample.command === COMPASS_CALIBRATION_STARTED) {
      this.calibrationActive = true;
      this.calibrationHeadingCount = 0;
      this.neutralSum = { x: 0, y: 0, z: 0 };
      this.neutralCount = 0;
      this.compassQuality = "calibrating";
      this.dispatch();
      return;
    }
    if (sample.command === COMPASS_CALIBRATION_COMPLETE) {
      if (!this.calibrationActive) {
        this.rejectedSamples++;
        return;
      }
      this.calibrationActive = false;
      this.persistCalibration();
      this.dispatch();
      return;
    }
    if (sample.command !== COMPASS_CHANGED || !Number.isFinite(sample.headingDegrees) || sample.headingDegrees < 0) {
      this.rejectedSamples++;
      return;
    }
    const now = this.options.now();
    const candidate = normalizeHeading(sample.headingDegrees + (this.calibration?.headingOffsetDegrees ?? 0));
    if (this.heading !== null) {
      const delta = circularDelta(this.heading, candidate);
      if (Math.abs(delta) > INTERFERENCE_DELTA_DEGREES) {
        const nearCandidate = this.outlierCandidate !== null &&
          Math.abs(circularDelta(this.outlierCandidate, candidate)) <= REACQUIRE_TOLERANCE_DEGREES;
        this.outlierCandidate = candidate;
        this.outlierCandidateCount = nearCandidate ? this.outlierCandidateCount + 1 : 1;
        if (!nearCandidate) this.headingDiscontinuities++;
        this.stableHeadingCount = 0;
        this.rejectedSamples++;
        if (this.outlierCandidateCount >= 3) {
          this.heading = candidate;
          this.headingAtMs = now;
          this.lastSampleAtMs = now;
          this.acceptedSamples++;
          this.stableHeadingCount = 1;
          if (this.calibrationActive) this.calibrationHeadingCount++;
          this.outlierCandidate = null;
          this.outlierCandidateCount = 0;
          this.headingDiscontinuities = 0;
          this.compassQuality = "poor";
        } else if (this.headingDiscontinuities >= 3) {
          this.compassQuality = "interference";
        }
        this.dispatch();
        return;
      }
      this.outlierCandidate = null;
      this.outlierCandidateCount = 0;
      const alpha = 0.3;
      this.heading = normalizeHeading(this.heading + delta * alpha);
    } else {
      this.heading = candidate;
    }
    this.headingAtMs = now;
    this.lastSampleAtMs = now;
    this.acceptedSamples++;
    this.stableHeadingCount++;
    if (this.calibrationActive) this.calibrationHeadingCount++;
    if (this.stableHeadingCount >= 10) {
      this.headingDiscontinuities = 0;
      this.compassQuality = this.calibrationQuality === "good" ? "good" : "fair";
    } else if (this.compassQuality !== "interference") {
      this.compassQuality = "poor";
    }
    this.dispatch();
  }

  private neutralPitch(): number {
    const vector = this.calibration?.neutralVector;
    if (!vector) return 0;
    return deriveOrientation(vector)?.pitchDegrees ?? 0;
  }

  private persistCalibration(): void {
    if (!this.identity || this.calibrationHeadingCount < 8 || this.neutralCount < 8) {
      this.calibrationQuality = "poor";
      this.compassQuality = "poor";
      return;
    }
    // Firmware completion plus stable samples proves sensor/neutral quality,
    // not wearer boresight alignment. Keep the maximum truthful grade at fair.
    const quality: Exclude<CalibrationQuality, "uncalibrated"> = "fair";
    const record: MotionCalibrationRecordV1 = {
      schemaVersion: 1,
      algorithmVersion: "motion-v1",
      deviceId: this.identity.deviceId,
      quality,
      calibratedAtMs: this.options.now(),
      neutralVector: {
        x: this.neutralSum.x / this.neutralCount,
        y: this.neutralSum.y / this.neutralCount,
        z: this.neutralSum.z / this.neutralCount,
      },
      headingOffsetDegrees: 0,
    };
    try {
      if (!this.options.persistence.save(record)) throw new Error("calibration save was not verified");
      this.calibration = record;
      this.calibrationQuality = quality;
      this.compassQuality = quality;
    } catch {
      this.calibration = null;
      this.calibrationQuality = "poor";
      this.compassQuality = "poor";
    }
  }

  private clearLiveSamples(): void {
    this.heading = null;
    this.headingAtMs = null;
    this.orientation = null;
    this.imuReading = null;
    this.orientationAtMs = null;
    this.lastSampleAtMs = null;
    this.compassQuality = "unavailable";
    this.stableHeadingCount = 0;
    this.headingDiscontinuities = 0;
    this.outlierCandidate = null;
    this.outlierCandidateCount = 0;
    this.calibrationActive = false;
    this.calibrationHeadingCount = 0;
    this.neutralSum = { x: 0, y: 0, z: 0 };
    this.neutralCount = 0;
  }

  private dispatch(): void {
    const snapshot = this.snapshot();
    for (const lease of Array.from(this.leases)) {
      if (!lease.active || lease.released) continue;
      try {
        lease.listener(snapshot);
      } catch {
        // One app must not break the shared hardware owner or other consumers.
      }
    }
  }
}
