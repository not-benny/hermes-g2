import { getStringSetting, setStringSetting } from "../native/settings-store";

const KEY = "assistant.contextDashboardPins";
const VERSION = 1;

/** Encrypted, fail-closed storage. The manager independently validates every record. */
export function loadContextDashboardPins(): unknown {
  const encoded = getStringSetting(KEY, "");
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(encoded) as { version?: unknown; pins?: unknown };
    return parsed?.version === VERSION && Array.isArray(parsed.pins) ? parsed.pins : [];
  } catch {
    return [];
  }
}

export function saveContextDashboardPins(pins: unknown[]): void {
  setStringSetting(KEY, JSON.stringify({ version: VERSION, pins }));
}