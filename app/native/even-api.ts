/**
 * Even Realities cloud API client — fetches ring health (steps, heart rate,
 * HRV, SpO2, sleep) that the official app syncs to Even's cloud, so Hermes can
 * show it on the glasses without a live BLE ring session.
 *
 * Auth mirrors com.even.sg: every request carries HMAC-SHA256 device headers,
 * and the login password is AES-256-CBC encrypted. The signing credentials
 * (app_id / accessKey / accessKeySecret) and the password AES key/iv are the
 * app's embedded constants, supplied by the user via settings (masked).
 *
 * STATUS: EXPERIMENTAL and UNVALIDATED — this has never succeeded against the
 * real API and probably does not work as-is. The live server requires a full
 * device-identity handshake (deviceId/openUdid/sn/os/channel/versions + the
 * `sign`/`ts`/`token`/`API-Auth` headers, per glasses_even_api_authenticator in
 * the decompile) that this only partially reproduces, so expect a 403 "device
 * went wrong". The tunable bits are isolated in buildCanonicalString /
 * signedHeaders.
 *
 * This cloud path is the ONLY remaining avenue: the direct-BLE path was driven
 * to a conclusive dead end (2026-08-19) — the ring gates health on host-MAC
 * binding to the glasses, so it accepts but ignores every command Hermes sends
 * (RING_HEALTH_PROBE_ENABLED is gated off). To finish THIS path you need the
 * app's embedded signing constants (app_id / accessKey / accessKeySecret + the
 * password AES key/iv) plus live iteration of the signature against a real
 * login. Those constants lived only in the com.even.sg decompile, which is no
 * longer on disk — re-extracting means re-pulling the APK from a device.
 */

import {
  evenAccountEmailSetting,
  evenAccountPasswordSetting,
  evenApiAccessKeySetting,
  evenApiAccessSecretSetting,
  evenApiAesIvSetting,
  evenApiAesKeySetting,
  evenApiAppIdSetting,
  evenAuthTokenSetting,
} from "../ui/dashboard-settings";

declare const com: any;

const BASE_URL = "https://api.evenrealities.com";

// Flat (not discriminated) so it narrows under the project's non-strict tsconfig:
// on success `data` is set, on failure `error` (and maybe `code`) are.
export type EvenResult<T> = { ok: boolean; data?: T; error?: string; code?: number };

export type EvenHealthLatest = {
  steps: number | null;
  heartRate: number | null;
  hrv: number | null;
  spo2: number | null;
  bodyTempC: number | null;
  caloriesKcal: number | null;
  sleepMinutes: number | null;
  updatedAt: number | null;
  /** The raw `data` object, so the UI can surface fields we didn't map yet. */
  raw: Record<string, unknown>;
};

type EvenEnvelope<T> = { code: number; msg: string; data: T | null };

/** All Even signing credentials are present (login can be attempted). */
export function evenApiConfigured(): boolean {
  return (
    evenApiAppIdSetting.get().trim().length > 0 &&
    evenApiAccessKeySetting.get().trim().length > 0 &&
    evenApiAccessSecretSetting.get().trim().length > 0
  );
}

export function evenAccountConfigured(): boolean {
  return evenAccountEmailSetting.get().trim().length > 0 && evenAccountPasswordSetting.get().length > 0;
}

export function evenIsSignedIn(): boolean {
  return evenAuthTokenSetting.get().trim().length > 0;
}

function hmacSha256Base64(key: string, message: string): string {
  return String(com.faceclaw.app.FaceclawEvenCrypto.hmacSha256Base64(key, message));
}

function aesEncryptPassword(plaintext: string): string {
  const key = evenApiAesKeySetting.get();
  const iv = evenApiAesIvSetting.get();
  return String(com.faceclaw.app.FaceclawEvenCrypto.aesCbcEncryptBase64(key, iv, plaintext));
}

function nonce(): string {
  let out = "";
  for (let i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/**
 * The string the signature is computed over. The app sorts the request
 * parameters (including app_id / timestamp / nonce) by key, formats each as
 * `key=value`, and joins with `&`. If the API rejects this, the likely fixes
 * are: include/exclude the HTTP method or path, or switch the signature
 * encoding to hex — all localized here.
 */
function buildCanonicalString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

/** Device/signing headers every request carries, plus the bearer token if signed in. */
function signedHeaders(
  method: string,
  bodyParams: Record<string, string>,
  authed: boolean,
): Record<string, string> {
  const appId = evenApiAppIdSetting.get().trim();
  const secret = evenApiAccessSecretSetting.get();
  const timestamp = String(Date.now());
  const n = nonce();

  const signParams: Record<string, string> = {
    ...bodyParams,
    app_id: appId,
    access_key: evenApiAccessKeySetting.get().trim(),
    timestamp,
    nonce: n,
  };
  const signature = hmacSha256Base64(secret, buildCanonicalString(signParams));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    app_id: appId,
    timestamp,
    nonce: n,
    sign: signature,
  };
  if (authed) {
    const token = evenAuthTokenSetting.get().trim();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function post<T>(path: string, body: Record<string, string>, authed = false): Promise<EvenResult<T>> {
  return request<T>("POST", path, body, authed);
}

async function get<T>(path: string, query: Record<string, string> = {}, authed = true): Promise<EvenResult<T>> {
  return request<T>("GET", path, query, authed);
}

async function request<T>(
  method: string,
  path: string,
  params: Record<string, string>,
  authed: boolean,
): Promise<EvenResult<T>> {
  const headers = signedHeaders(method, params, authed);
  let url = `${BASE_URL}${path}`;
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
  if (method === "GET") {
    const qs = Object.keys(params)
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
      .join("&");
    if (qs) url += `?${qs}`;
  } else {
    init.body = JSON.stringify(params);
  }

  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let envelope: EvenEnvelope<T>;
    try {
      envelope = JSON.parse(text) as EvenEnvelope<T>;
    } catch {
      return { ok: false, error: `Non-JSON response (HTTP ${response.status}): ${text.slice(0, 120)}` };
    }
    if (envelope.code !== 0 && envelope.code !== 200) {
      return { ok: false, error: envelope.msg || `Even API error ${envelope.code}`, code: envelope.code };
    }
    return { ok: true, data: (envelope.data as T) ?? ({} as T) };
  } catch (error) {
    return { ok: false, error: `Network error: ${(error as Error)?.message ?? String(error)}` };
  }
}

/**
 * Log in with the configured account, storing the returned bearer token. The
 * token field name inside `data` varies; we accept the common ones.
 */
export async function evenLogin(): Promise<EvenResult<{ token: string }>> {
  if (!evenApiConfigured()) return { ok: false, error: "Set the Even API signing credentials first." };
  if (!evenAccountConfigured()) return { ok: false, error: "Set your Even account email and password first." };

  const body = {
    account: evenAccountEmailSetting.get().trim(),
    password: aesEncryptPassword(evenAccountPasswordSetting.get()),
  };
  const result = await post<Record<string, unknown>>("/v2/g/login", body, false);
  if (!result.ok) return { ok: false, error: result.error, code: result.code };

  const data = result.data ?? {};
  const token = String(data.token ?? data.access_token ?? data.accessToken ?? data.jwt ?? "");
  if (!token) return { ok: false, error: "Login succeeded but no token was returned." };
  evenAuthTokenSetting.set(token);
  return { ok: true, data: { token } };
}

export function evenSignOut(): void {
  evenAuthTokenSetting.set("");
}

function numOrNull(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** Fetch the latest synced health snapshot, mapping the common field names. */
export async function evenGetLatestHealth(): Promise<EvenResult<EvenHealthLatest>> {
  if (!evenIsSignedIn()) {
    const login = await evenLogin();
    if (!login.ok) return { ok: false, error: login.error, code: login.code };
  }
  let result = await get<Record<string, unknown>>("/v2/g/health/get_latest_data");
  // A 401/expired token: re-login once and retry.
  if (!result.ok && (result.code === 401 || /token|login|expire/i.test(result.error))) {
    evenSignOut();
    const login = await evenLogin();
    if (!login.ok) return { ok: false, error: login.error, code: login.code };
    result = await get<Record<string, unknown>>("/v2/g/health/get_latest_data");
  }
  if (!result.ok) return { ok: false, error: result.error, code: result.code };

  const d = result.data ?? {};
  const health: EvenHealthLatest = {
    steps: numOrNull(d.steps ?? d.step ?? d.stepCount),
    heartRate: numOrNull(d.heart_rate ?? d.heartRate ?? d.hr),
    hrv: numOrNull(d.hrv),
    spo2: numOrNull(d.blood_oxygen ?? d.spo2 ?? d.bloodOxygen),
    bodyTempC: numOrNull(d.temperature ?? d.temp ?? d.bodyTemperature),
    caloriesKcal: numOrNull(d.calories ?? d.kcal ?? d.calorie),
    sleepMinutes: numOrNull(d.sleep ?? d.sleepMinutes ?? d.sleep_duration),
    updatedAt: numOrNull(d.updated_at ?? d.updatedAt ?? d.timestamp),
    raw: d,
  };
  return { ok: true, data: health };
}
