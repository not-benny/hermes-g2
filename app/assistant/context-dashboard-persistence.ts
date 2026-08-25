import { getStringSetting, removeSecretSetting, setStringSetting } from "../native/settings-store";

const KEY = "assistant.contextDashboardPins";
const VERSION = 1;
const MAX_ENCODED_CHARS = 8 * 1024;

/** Encrypted, fail-closed storage. The manager independently validates every record. */
export function loadContextDashboardPins(): unknown {
  const encoded = getStringSetting(KEY, "");
  if (!encoded) return [];
  if (encoded.length > MAX_ENCODED_CHARS) {
    purgeInvalidPins();
    return [];
  }
  try {
    const parsed = JSON.parse(encoded) as { version?: unknown; pins?: unknown };
    if (parsed?.version === VERSION && Array.isArray(parsed.pins)) return parsed.pins;
  } catch {
    // Invalid encrypted data must not become a hidden, undeletable recipe.
  }
  purgeInvalidPins();
  return [];
}

function purgeInvalidPins(): void {
  try {
    removeSecretSetting(KEY);
  } catch {
    // Fail closed now and retry on the next load if secure deletion failed.
  }
}

export function saveContextDashboardPins(pins: unknown[]): void {
  const encoded = JSON.stringify({ version: VERSION, pins });
  if (encoded.length > MAX_ENCODED_CHARS) throw new Error("context dashboard pin storage exceeds its local bound");
  setStringSetting(KEY, encoded);
}
