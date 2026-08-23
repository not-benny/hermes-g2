import { Utils } from "@nativescript/core";

declare const android: any;

/**
 * Current Android cellular signal level on the platform's standard 0..4 scale.
 * Returns null when telephony is absent, unavailable, or permission-gated.
 * The HUD is best-effort and must never request a broader phone-state permission.
 */
export function readPhoneSignalLevel(): number | null {
  if (!global.isAndroid) return null;
  try {
    if (android.os.Build.VERSION.SDK_INT < 28) return null;
    const context = Utils.android.getApplicationContext();
    if (!context) return null;
    const telephony = context.getSystemService(android.content.Context.TELEPHONY_SERVICE);
    const strength = telephony?.getSignalStrength?.();
    if (!strength) return null;
    const level = Number(strength.getLevel());
    if (!Number.isFinite(level)) return null;
    return Math.max(0, Math.min(4, Math.round(level)));
  } catch {
    return null;
  }
}
