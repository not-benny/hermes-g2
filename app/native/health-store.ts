/**
 * Sole persistence adapter for ring health. All health data is stored as one
 * app-private JSON value; the separate consent bit survives data migration and
 * clearing because revocation is an access gate, not a delete operation.
 */
import { ApplicationSettings } from "@nativescript/core";
import { BATTERY_FUTURE_SKEW_MS, canonicalizeHealthDocument, parseLocalDateKey, type HealthStoreDocument, type RingBatterySnapshot } from "../health/health-store";
import { dateKeyOf, summarizeDay, type DailyHealthSummary, type DaySummaryInputs } from "../health/health-history";
import { buildHourlyPoints, type HourlyPoint } from "../health/health-hourly";
import { canonicalizeActivitySnapshot, canonicalizeSleepSnapshot, type RingActivitySnapshot } from "../health/ring-health-store";
import { canonicalizeRingSleepData, type RingSleepData } from "../health/ring-parser";

export const HEALTH_STORE_KEY = "health.store.v1";
export const LEGACY_HISTORY_KEY = "health.history.v1";
export const LEGACY_HOURLY_KEY = "health.hourly.v1";
export const LEGACY_ACTIVITY_KEY = "health.activity.v1";
export const HERMES_CONSENT_KEY = "health.hermes.consent.v1";
export const HEALTH_RING_SCOPE_KEY = "health.ring.scope.v1";
const LEGACY_KEYS = [LEGACY_HISTORY_KEY, LEGACY_HOURLY_KEY, LEGACY_ACTIVITY_KEY] as const;
const BATTERY_PERSIST_INTERVAL_MS = 60 * 60 * 1000;
type RingHour = { hourIdx: number; avg: number; max: number; min: number; timestampSec?: number | null; timezoneOffsetMinutes?: number | null };

export interface HealthApplicationSettings {
  hasKey?(key: string): boolean;
  getString(key: string, defaultValue?: string): string;
  setString(key: string, value: string): void;
  getBoolean(key: string, defaultValue?: boolean): boolean;
  setBoolean(key: string, value: boolean): void;
  remove(key: string): void;
  flush?(): boolean;
}
export interface HealthLoadResult { ok: boolean; document?: HealthStoreDocument; error?: string; }
export interface HealthWriteResult { ok: boolean; document?: HealthStoreDocument; error?: string; }
export interface HealthPersistence {
  loadHealthDocument(): HealthStoreDocument;
  loadHealthDocumentResult(): HealthLoadResult;
  replaceHealthDocument(value: unknown): HealthWriteResult;
  loadHealthHistory(): DailyHealthSummary[];
  recordHealthDay(inputs: DaySummaryInputs): DailyHealthSummary[];
  loadHourly(): HourlyPoint[];
  recordHourly(hr: RingHour[], spo2: RingHour[], hrv: RingHour[], nowMs: number): HourlyPoint[];
  loadActivity(nowMs?: number): RingActivitySnapshot | null;
  recordActivity(activity: RingActivitySnapshot | null): void;
  loadSleep(nowMs?: number): RingSleepData | null;
  recordSleep(sleep: RingSleepData | null): void;
  loadBattery(ringId: string): RingBatterySnapshot | null;
  recordBattery(ringId: string, percent: number | null, updatedAtMs: number | null): void;
  transitionRingIdentity(previousRingId: string, nextRingId: string): HealthWriteResult;
  getHermesConsent(): boolean;
  setHermesConsent(on: boolean): void;
  clearHealthData(): void;
}
function parseJson(raw: string, fallback: unknown): unknown {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

const DAILY_FIELDS = ["restingHr", "hrMin", "hrMax", "hrvAvg", "spo2Avg", "steps",
  "sleepScore", "sleepDurationMin", "sleepDeepMin", "sleepRemMin", "bodyTempC", "readinessScore"];
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isDateKey = (value: unknown): value is string => parseLocalDateKey(value) !== null;
const normalizeRingId = (value: string): string => value.trim().toUpperCase();
const isValidRingId = (value: string): boolean => /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(normalizeRingId(value));
const canonicalRingId = (value: string): string => isValidRingId(value) ? normalizeRingId(value) : "";

type PersistedRingScope = { version: 1; ringId: string };

function parseRingScope(raw: string): PersistedRingScope | null {
  const parsed = parseJson(raw, null);
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || typeof value.ringId !== "string") return null;
  const ringId = value.ringId === "" ? "" : canonicalRingId(value.ringId);
  return value.ringId === "" || ringId ? { version: 1, ringId } : null;
}

function isValidPersistedDocument(value: Record<string, unknown>, nowMs: number): boolean {
  if (value.version !== 1 || value.retentionDays !== 90 || !isFiniteNumber(value.updatedAtMs) ||
    !Array.isArray(value.history) || !Array.isArray(value.hourly) ||
    (value.activity !== null && typeof value.activity !== "object") ||
    (value.sleep !== undefined && value.sleep !== null && typeof value.sleep !== "object")) return false;
  if (value.history.some((candidate) => {
    if (!candidate || typeof candidate !== "object") return true;
    const row = candidate as Record<string, unknown>;
    return !isDateKey(row.dateKey) || !isFiniteNumber(row.updatedAtMs) ||
      DAILY_FIELDS.some((field) => row[field] !== null && !isFiniteNumber(row[field]));
  })) return false;
  if (value.hourly.some((candidate) => {
    if (!candidate || typeof candidate !== "object") return true;
    const point = candidate as Record<string, unknown>;
    if (!isDateKey(point.dateKey) || !Number.isInteger(point.hourIdx) ||
      (point.hourIdx as number) < 0 || (point.hourIdx as number) > 23) return true;
    if (point.timestampSec !== undefined &&
      (!Number.isInteger(point.timestampSec) || (point.timestampSec as number) < 0)) return true;
    if (point.timestampSec !== undefined) {
      if (!Number.isInteger(point.timezoneOffsetMinutes) ||
        (point.timezoneOffsetMinutes as number) < -840 || (point.timezoneOffsetMinutes as number) > 840) return true;
      const fixedLocal = new Date(((point.timestampSec as number) +
        (point.timezoneOffsetMinutes as number) * 60) * 1000);
      if (fixedLocal.toISOString().slice(0, 10) !== point.dateKey ||
        fixedLocal.getUTCHours() !== point.hourIdx) return true;
    } else if (point.timezoneOffsetMinutes !== undefined) return true;
    if (!["hr", "spo2", "hrv"].some((field) => point[field] !== undefined)) return true;
    return ["hr", "spo2", "hrv"].some((field) => {
      if (point[field] === undefined) return false;
      const metric = point[field];
      return !metric || typeof metric !== "object" ||
        !["avg", "max", "min"].every((key) => isFiniteNumber((metric as Record<string, unknown>)[key]));
    });
  })) return false;
  if (value.battery !== undefined && value.battery !== null) {
    if (typeof value.battery !== "object") return false;
    const battery = value.battery as Record<string, unknown>;
    if (!Number.isInteger(battery.percent) || (battery.percent as number) < 0 ||
      (battery.percent as number) > 100 || !isFiniteNumber(battery.updatedAtMs) ||
      (battery.updatedAtMs as number) < 0) return false;
    // Accept the short-lived unscoped preview shape only so canonicalization
    // can discard it without invalidating otherwise sound health history.
    if (battery.ringId !== undefined &&
      (typeof battery.ringId !== "string" || !isValidRingId(battery.ringId) ||
        (battery.updatedAtMs as number) > nowMs + BATTERY_FUTURE_SKEW_MS)) return false;
  }
  if (value.sleep !== undefined && value.sleep !== null && canonicalizeRingSleepData(value.sleep) === null) return false;
  if (value.activity === null) return true;
  const activity = value.activity as Record<string, unknown>;
  if (!Number.isInteger(activity.dayBaseSec) || !Number.isInteger(activity.timezoneOffsetMinutes) ||
    !Array.isArray(activity.slots) || !isFiniteNumber(activity.totalSteps) ||
    !isFiniteNumber(activity.activeCalories) || !isFiniteNumber(activity.totalCalories) ||
    !isFiniteNumber(activity.restingCalories) || activity.slots.length === 0) return false;
  let totalSteps = 0;
  let activeCalories = 0;
  let totalCalories = 0;
  let restingCalories = 0;
  for (const candidate of activity.slots) {
    if (!candidate || typeof candidate !== "object") return false;
    const slot = candidate as Record<string, unknown>;
    if (!Number.isInteger(slot.slot) || (slot.slot as number) < 0 || (slot.slot as number) > 143 ||
      !Number.isInteger(slot.timestampSec) || !isFiniteNumber(slot.steps) ||
      !isFiniteNumber(slot.activeCalories) || !isFiniteNumber(slot.totalCalories) ||
      !isFiniteNumber(slot.restingCalories) || (slot.totalCalories as number) < (slot.activeCalories as number) ||
      slot.timestampSec !== (activity.dayBaseSec as number) + (slot.slot as number) * 600 ||
      slot.restingCalories !== (slot.totalCalories as number) - (slot.activeCalories as number)) return false;
    totalSteps += slot.steps as number;
    activeCalories += slot.activeCalories as number;
    totalCalories += slot.totalCalories as number;
    restingCalories += slot.restingCalories as number;
  }
  // Activity is intentionally current-day-only when projected for display, but
  // an otherwise sound snapshot naturally becomes yesterday's at midnight.
  // Validate it against its own anchored day here; canonicalization below will
  // prune it against `nowMs`. Treating normal day rollover as corruption would
  // reject the entire single-key document, hiding durable history/hourly data
  // and preventing every subsequent health write.
  // The stored base is already the UTC epoch corresponding to exact local
  // midnight under the record's fixed offset. Validate at that anchor itself;
  // adding an arbitrary wall-clock offset risks changing the derived local day
  // at the supported UTC-14/UTC+14 boundaries.
  const activityOwnDayMs = (activity.dayBaseSec as number) * 1000;
  return activity.totalSteps === totalSteps && activity.activeCalories === activeCalories &&
    activity.totalCalories === totalCalories && activity.restingCalories === restingCalories &&
    canonicalizeActivitySnapshot(activity, activityOwnDayMs) !== null;
}

export function createHealthPersistence(settings: HealthApplicationSettings, now: () => number = () => Date.now()): HealthPersistence {
  // Android SharedPreferences.apply updates in-memory reads before durable I/O.
  // Remember a failed synchronous flush so equality fast paths cannot later
  // mistake that candidate for a committed document/scope.
  let durabilityPending = false;
  const ensureDurable = (): string | null => {
    if (!durabilityPending) return null;
    try {
      if (settings.flush && !settings.flush()) return "health settings flush failed";
      durabilityPending = false;
      return null;
    } catch (error) {
      return `health settings flush failed: ${String(error)}`;
    }
  };
  const removeLegacy = () => {
    for (const key of LEGACY_KEYS) {
      try { settings.remove(key); } catch (error) {
        console.error(`[health-store] legacy cleanup failed for ${key}: ${String(error)}`);
      }
    }
  };
  const writeVerified = (document: HealthStoreDocument, removeCandidateOnFailure: boolean): HealthWriteResult => {
    const serialized = JSON.stringify(document);
    try {
      durabilityPending = Boolean(settings.flush);
      settings.setString(HEALTH_STORE_KEY, serialized);
      const durabilityError = ensureDurable();
      if (durabilityError || settings.getString(HEALTH_STORE_KEY, "") !== serialized) {
        if (removeCandidateOnFailure) {
          try { settings.remove(HEALTH_STORE_KEY); } catch (error) {
            console.error(`[health-store] failed canonical candidate cleanup: ${String(error)}`);
          }
        }
        return { ok: false, error: durabilityError ?? "canonical health write could not be verified" };
      }
      removeLegacy();
      return { ok: true, document };
    } catch (error) {
      if (removeCandidateOnFailure) {
        try { settings.remove(HEALTH_STORE_KEY); } catch (cleanupError) {
          console.error(`[health-store] failed canonical candidate cleanup: ${String(cleanupError)}`);
        }
      }
      console.error(`[health-store] canonical save failed: ${String(error)}`);
      return { ok: false, error: `canonical health write failed: ${String(error)}` };
    }
  };
  const loadHealthDocumentResult = (): HealthLoadResult => {
    const durabilityError = ensureDurable();
    if (durabilityError) return { ok: false, error: durabilityError };
    const nowMs = now();
    const canonicalRaw = settings.getString(HEALTH_STORE_KEY, "");
    if (canonicalRaw) {
      const parsed = parseJson(canonicalRaw, null);
      const raw = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
      if (!raw || !isValidPersistedDocument(raw, nowMs)) {
        return { ok: false, error: "canonical health document is malformed or unsupported" };
      }
      const document = canonicalizeHealthDocument(parsed, nowMs);
      const normalized = JSON.stringify(document);
      const hasLegacy = LEGACY_KEYS.some((key) => settings.hasKey ? settings.hasKey(key) : settings.getString(key, "") !== "");
      if (canonicalRaw !== normalized || hasLegacy) {
        const result = writeVerified(document, false);
        if (!result.ok) return { ok: false, error: result.error };
      }
      return { ok: true, document };
    }
    const migrated = canonicalizeHealthDocument({
      updatedAtMs: nowMs,
      history: parseJson(settings.getString(LEGACY_HISTORY_KEY, ""), []),
      hourly: parseJson(settings.getString(LEGACY_HOURLY_KEY, ""), []),
      activity: parseJson(settings.getString(LEGACY_ACTIVITY_KEY, ""), null),
    }, nowMs);
    const result = writeVerified(migrated, true);
    return result.ok ? { ok: true, document: migrated } : { ...result, document: migrated };
  };
  const loadHealthDocument = (): HealthStoreDocument =>
    loadHealthDocumentResult().document ?? canonicalizeHealthDocument({}, now());
  const replaceHealthDocument = (value: unknown): HealthWriteResult => {
    const nowMs = now();
    if (settings.getString(HEALTH_STORE_KEY, "") && !loadHealthDocumentResult().ok) {
      return { ok: false, error: "canonical health document is malformed or unsupported" };
    }
    const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return writeVerified(canonicalizeHealthDocument({ ...source, updatedAtMs: nowMs }, nowMs), false);
  };
  const writeRingScopeVerified = (ringId: string): string | null => {
    const serialized = JSON.stringify({ version: 1, ringId });
    try {
      durabilityPending = Boolean(settings.flush);
      settings.setString(HEALTH_RING_SCOPE_KEY, serialized);
      const durabilityError = ensureDurable();
      return !durabilityError && settings.getString(HEALTH_RING_SCOPE_KEY, "") === serialized
        ? null
        : durabilityError ?? "ring health identity scope could not be verified";
    } catch (error) {
      return `ring health identity scope write failed: ${String(error)}`;
    }
  };
  const transitionRingIdentity = (previousRingId: string, nextRingId: string): HealthWriteResult => {
    const durabilityError = ensureDurable();
    if (durabilityError) return { ok: false, error: durabilityError };
    const previous = canonicalRingId(previousRingId);
    const next = canonicalRingId(nextRingId);
    const scopeRaw = settings.getString(HEALTH_RING_SCOPE_KEY, "");
    const persistedScope = scopeRaw ? parseRingScope(scopeRaw) : null;
    const explicitChange = previous !== next;
    const persistedChange = persistedScope !== null && persistedScope.ringId !== next;
    const malformedScope = Boolean(scopeRaw) && persistedScope === null;
    const unconfiguredFirstBind = !scopeRaw && next === "";

    // First-run migration can safely adopt the ring already configured at
    // boot. An explicit A->B/removal transition, a persisted mismatch on
    // relaunch, or a malformed scope must scrub all ring-specific current data.
    if (!explicitChange && !persistedChange && !malformedScope && !unconfiguredFirstBind) {
      const error = persistedScope ? null : writeRingScopeVerified(next);
      if (error) return { ok: false, error };
      const loaded = loadHealthDocumentResult();
      return loaded.ok && loaded.document
        ? { ok: true, document: loaded.document }
        : { ok: false, error: loaded.error ?? "health document unavailable while binding ring identity" };
    }

    const loaded = loadHealthDocumentResult();
    if (!loaded.ok || !loaded.document) {
      return { ok: false, error: loaded.error ?? "health document unavailable during ring identity transition" };
    }
    const nowMs = now();
    const today = dateKeyOf(nowMs);
    const safelyCompletedBeforeMs = nowMs - 24 * 60 * 60 * 1000;
    const scrubbed = canonicalizeHealthDocument({
      ...loaded.document,
      // Completed prior days are user history and remain useful across
      // hardware replacement. Current-day readiness and every unsummarized,
      // ring-derived source are unscoped and therefore cannot cross rings.
      history: loaded.document.history.filter((row) =>
        row.dateKey < today && row.updatedAtMs < safelyCompletedBeforeMs),
      hourly: [],
      activity: null,
      sleep: null,
      battery: null,
      updatedAtMs: nowMs,
    }, nowMs);
    const write = writeVerified(scrubbed, false);
    if (!write.ok) return write;
    // Scope is committed only after the scrub is durably verified. A crash or
    // failure between writes leaves the old scope, causing an idempotent scrub
    // on the next boot rather than restoring old-ring data under the new ring.
    const scopeError = writeRingScopeVerified(next);
    return scopeError ? { ok: false, document: scrubbed, error: scopeError } : { ok: true, document: scrubbed };
  };
  return {
    loadHealthDocument, loadHealthDocumentResult, replaceHealthDocument, transitionRingIdentity,
    loadHealthHistory: () => loadHealthDocumentResult().document?.history ?? [],
    recordHealthDay(inputs) {
      const loaded = loadHealthDocumentResult();
      if (!loaded.ok || !loaded.document) return [];
      const document = loaded.document;
      const summary = summarizeDay(dateKeyOf(inputs.updatedAtMs), inputs);
      return replaceHealthDocument({ ...document, history: [...document.history, summary] }).document?.history ?? document.history;
    },
    loadHourly: () => loadHealthDocumentResult().document?.hourly ?? [],
    recordHourly(hr, spo2, hrv, nowMs) {
      const loaded = loadHealthDocumentResult();
      if (!loaded.ok || !loaded.document) return [];
      const document = loaded.document;
      const incoming = buildHourlyPoints(hr, spo2, hrv, nowMs);
      if (incoming.length === 0) return document.hourly;
      return replaceHealthDocument({ ...document, hourly: [...document.hourly, ...incoming] }).document?.hourly ?? document.hourly;
    },
    loadActivity(nowMs = now()) {
      const loaded = loadHealthDocumentResult();
      return loaded.document ? canonicalizeHealthDocument(loaded.document, nowMs).activity : null;
    },
    recordActivity(activity) {
      if (!activity) return;
      const loaded = loadHealthDocumentResult();
      if (!loaded.ok || !loaded.document) return;
      if (JSON.stringify(loaded.document.activity) === JSON.stringify(activity)) return;
      replaceHealthDocument({ ...loaded.document, activity });
    },
    loadSleep(nowMs = now()) {
      const loaded = loadHealthDocumentResult();
      return loaded.document ? canonicalizeSleepSnapshot(loaded.document.sleep, nowMs) : null;
    },
    recordSleep(sleep) {
      if (!sleep) return;
      const canonical = canonicalizeSleepSnapshot(sleep, now());
      if (!canonical) return;
      const loaded = loadHealthDocumentResult();
      if (!loaded.ok || !loaded.document) return;
      if ((loaded.document.sleep?.endTs ?? -1) >= canonical.endTs) return;
      replaceHealthDocument({ ...loaded.document, sleep: canonical });
    },
    loadBattery(ringId) {
      if (!isValidRingId(ringId)) return null;
      const loaded = loadHealthDocumentResult();
      const battery = loaded.document?.battery ?? null;
      return battery?.ringId === normalizeRingId(ringId) ? battery : null;
    },
    recordBattery(ringId, percent, updatedAtMs) {
      const nowMs = now();
      if (!isValidRingId(ringId) || !Number.isInteger(percent) ||
        (percent as number) < 0 || (percent as number) > 100 ||
        typeof updatedAtMs !== "number" || !Number.isFinite(updatedAtMs) || updatedAtMs < 0 ||
        updatedAtMs > nowMs + BATTERY_FUTURE_SKEW_MS) return;
      const loaded = loadHealthDocumentResult();
      if (!loaded.ok || !loaded.document) return;
      const battery = { ringId: normalizeRingId(ringId), percent: percent as number, updatedAtMs };
      const previous = loaded.document.battery;
      if (previous?.ringId === battery.ringId && previous.percent === battery.percent &&
        updatedAtMs - previous.updatedAtMs < BATTERY_PERSIST_INTERVAL_MS) return;
      replaceHealthDocument({ ...loaded.document, battery });
    },
    getHermesConsent: () => settings.getBoolean(HERMES_CONSENT_KEY, false),
    setHermesConsent(on) {
      durabilityPending = Boolean(settings.flush);
      settings.setBoolean(HERMES_CONSENT_KEY, on);
      const durabilityError = ensureDurable();
      if (durabilityError || settings.getBoolean(HERMES_CONSENT_KEY, !on) !== on) {
        throw new Error(durabilityError ?? "health consent write could not be verified");
      }
    },
    clearHealthData() {
      durabilityPending = Boolean(settings.flush);
      settings.remove(HEALTH_STORE_KEY);
      removeLegacy();
      const durabilityError = ensureDurable();
      const canonicalRemains = settings.hasKey
        ? settings.hasKey(HEALTH_STORE_KEY)
        : settings.getString(HEALTH_STORE_KEY, "") !== "";
      const legacyRemains = LEGACY_KEYS.some((key) => settings.hasKey
        ? settings.hasKey(key)
        : settings.getString(key, "") !== "");
      if (durabilityError || canonicalRemains || legacyRemains) {
        throw new Error(durabilityError ?? "health data removal could not be verified");
      }
    },
  };
}
const healthPersistence = createHealthPersistence(ApplicationSettings);
export const loadHealthDocument = healthPersistence.loadHealthDocument;
export const loadHealthDocumentResult = healthPersistence.loadHealthDocumentResult;
export const replaceHealthDocument = healthPersistence.replaceHealthDocument;
export const loadHealthHistory = healthPersistence.loadHealthHistory;
export const recordHealthDay = healthPersistence.recordHealthDay;
export const loadHourly = healthPersistence.loadHourly;
export const recordHourly = healthPersistence.recordHourly;
export const loadActivity = healthPersistence.loadActivity;
export const recordActivity = healthPersistence.recordActivity;
export const loadSleep = healthPersistence.loadSleep;
export const recordSleep = healthPersistence.recordSleep;
export const loadBattery = healthPersistence.loadBattery;
export const recordBattery = healthPersistence.recordBattery;
export const transitionHealthRingIdentity = healthPersistence.transitionRingIdentity;
export const getHermesConsent = healthPersistence.getHermesConsent;
export const setHermesConsent = healthPersistence.setHermesConsent;
export const clearHealthData = healthPersistence.clearHealthData;
