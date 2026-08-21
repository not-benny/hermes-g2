/**
 * Sole persistence adapter for ring health. All health data is stored as one
 * app-private JSON value; the separate consent bit survives data migration and
 * clearing because revocation is an access gate, not a delete operation.
 */
import { ApplicationSettings } from "@nativescript/core";

import {
  canonicalizeHealthDocument,
  type HealthStoreDocument,
} from "../health/health-store";
import { dateKeyOf, summarizeDay, type DailyHealthSummary, type DaySummaryInputs } from "../health/health-history";
import { buildHourlyPoints, type HourlyPoint } from "../health/health-hourly";
import type { RingActivitySnapshot } from "../health/ring-health-store";

export const HEALTH_STORE_KEY = "health.store.v1";
export const LEGACY_HISTORY_KEY = "health.history.v1";
export const LEGACY_HOURLY_KEY = "health.hourly.v1";
export const LEGACY_ACTIVITY_KEY = "health.activity.v1";
export const HERMES_CONSENT_KEY = "health.hermes.consent.v1";

const LEGACY_KEYS = [LEGACY_HISTORY_KEY, LEGACY_HOURLY_KEY, LEGACY_ACTIVITY_KEY] as const;

type RingHour = { hourIdx: number; avg: number; max: number; min: number };

export interface HealthApplicationSettings {
  hasKey?(key: string): boolean;
  getString(key: string, defaultValue?: string): string;
  setString(key: string, value: string): void;
  getBoolean(key: string, defaultValue?: boolean): boolean;
  setBoolean(key: string, value: boolean): void;
  remove(key: string): void;
}

export interface HealthPersistence {
  loadHealthDocument(): HealthStoreDocument;
  replaceHealthDocument(value: unknown): HealthStoreDocument;
  loadHealthHistory(): DailyHealthSummary[];
  recordHealthDay(inputs: DaySummaryInputs): DailyHealthSummary[];
  loadHourly(): HourlyPoint[];
  recordHourly(hr: RingHour[], spo2: RingHour[], hrv: RingHour[], nowMs: number): HourlyPoint[];
  loadActivity(nowMs?: number): RingActivitySnapshot | null;
  recordActivity(activity: RingActivitySnapshot | null): void;
  getHermesConsent(): boolean;
  setHermesConsent(on: boolean): void;
  clearHealthData(): void;
}

function parseJson(raw: string, fallback: unknown): unknown {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function createHealthPersistence(
  settings: HealthApplicationSettings,
  now: () => number = () => Date.now(),
): HealthPersistence {
  const removeLegacy = () => {
    for (const key of LEGACY_KEYS) settings.remove(key);
  };

  const writeVerified = (document: HealthStoreDocument): boolean => {
    const serialized = JSON.stringify(document);
    try {
      settings.setString(HEALTH_STORE_KEY, serialized);
      if (settings.getString(HEALTH_STORE_KEY, "") !== serialized) return false;
      removeLegacy();
      return true;
    } catch (error) {
      console.error(`[health-store] canonical save failed: ${String(error)}`);
      return false;
    }
  };

  const loadHealthDocument = (): HealthStoreDocument => {
    const nowMs = now();
    const canonicalRaw = settings.getString(HEALTH_STORE_KEY, "");
    if (canonicalRaw) {
      const document = canonicalizeHealthDocument(parseJson(canonicalRaw, {}), nowMs);
      const normalized = JSON.stringify(document);
      const hasLegacy = LEGACY_KEYS.some((key) =>
        settings.hasKey ? settings.hasKey(key) : settings.getString(key, "") !== "",
      );
      if (canonicalRaw !== normalized || hasLegacy) writeVerified(document);
      return document;
    }

    // Each legacy fragment is independent: one malformed value must not discard
    // the other two during the one-time migration.
    const migrated = canonicalizeHealthDocument({
      updatedAtMs: nowMs,
      history: parseJson(settings.getString(LEGACY_HISTORY_KEY, ""), []),
      hourly: parseJson(settings.getString(LEGACY_HOURLY_KEY, ""), []),
      activity: parseJson(settings.getString(LEGACY_ACTIVITY_KEY, ""), null),
    }, nowMs);
    if (!writeVerified(migrated)) {
      // This key was absent when migration began, so any value here is only the
      // unverified candidate from this attempt. Remove it so a later process
      // retries from the untouched legacy fragments instead of treating the
      // candidate as authoritative. Never do this for an existing canonical
      // document: a failed normalization write must not delete known data.
      settings.remove(HEALTH_STORE_KEY);
    }
    return migrated;
  };

  const replaceHealthDocument = (value: unknown): HealthStoreDocument => {
    const nowMs = now();
    const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const document = canonicalizeHealthDocument({ ...source, updatedAtMs: nowMs }, nowMs);
    writeVerified(document);
    return document;
  };

  return {
    loadHealthDocument,
    replaceHealthDocument,
    loadHealthHistory: () => loadHealthDocument().history,
    recordHealthDay(inputs: DaySummaryInputs): DailyHealthSummary[] {
      const document = loadHealthDocument();
      const summary = summarizeDay(dateKeyOf(inputs.updatedAtMs), inputs);
      return replaceHealthDocument({ ...document, history: [...document.history, summary] }).history;
    },
    loadHourly: () => loadHealthDocument().hourly,
    recordHourly(hr: RingHour[], spo2: RingHour[], hrv: RingHour[], nowMs: number): HourlyPoint[] {
      const document = loadHealthDocument();
      const incoming = buildHourlyPoints(hr, spo2, hrv, nowMs);
      if (incoming.length === 0) return document.hourly;
      return replaceHealthDocument({ ...document, hourly: [...document.hourly, ...incoming] }).hourly;
    },
    loadActivity(nowMs = now()): RingActivitySnapshot | null {
      const document = loadHealthDocument();
      return canonicalizeHealthDocument(document, nowMs).activity;
    },
    recordActivity(activity: RingActivitySnapshot | null): void {
      if (!activity) return;
      const document = loadHealthDocument();
      replaceHealthDocument({ ...document, activity });
    },
    getHermesConsent: () => settings.getBoolean(HERMES_CONSENT_KEY, false),
    setHermesConsent: (on: boolean) => settings.setBoolean(HERMES_CONSENT_KEY, on),
    clearHealthData(): void {
      settings.remove(HEALTH_STORE_KEY);
      removeLegacy();
    },
  };
}

const healthPersistence = createHealthPersistence(ApplicationSettings);

export const loadHealthDocument = healthPersistence.loadHealthDocument;
export const replaceHealthDocument = healthPersistence.replaceHealthDocument;
export const loadHealthHistory = healthPersistence.loadHealthHistory;
export const recordHealthDay = healthPersistence.recordHealthDay;
export const loadHourly = healthPersistence.loadHourly;
export const recordHourly = healthPersistence.recordHourly;
export const loadActivity = healthPersistence.loadActivity;
export const recordActivity = healthPersistence.recordActivity;
export const getHermesConsent = healthPersistence.getHermesConsent;
export const setHermesConsent = healthPersistence.setHermesConsent;
export const clearHealthData = healthPersistence.clearHealthData;
