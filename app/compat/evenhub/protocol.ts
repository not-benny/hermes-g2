export const EVENHUB_MAX_MESSAGE_BYTES = 16 * 1024;
export const EVENHUB_MAX_STORAGE_VALUE_BYTES = 2 * 1024;
export const EVENHUB_MAX_STORAGE_BYTES = 16 * 1024;
export const EVENHUB_MAX_STORAGE_KEYS = 32;
export const EVENHUB_MAX_TIMERS = 4;
export const EVENHUB_MIN_TIMER_MS = 250;
export const EVENHUB_MAX_TIMER_MS = 60_000;

export type EvenHubPermission =
  | "display"
  | "input"
  | "storage"
  | "timers"
  | "microphone"
  | "location"
  | "accelerometer";

export const LOCAL_ONLY_PERMISSIONS: readonly EvenHubPermission[] = ["display", "input", "storage", "timers"];

export type EvenHubViewBlock =
  | { type: "text"; text: string; emphasis?: "normal" | "strong" }
  | { type: "key_value"; label: string; value: string }
  | { type: "progress"; label: string; value: number }
  | { type: "divider" };

export type EvenHubView = {
  title: string;
  blocks: EvenHubViewBlock[];
  actions: { id: string; label: string }[];
};

export type EvenHubPackageManifest = {
  formatVersion: 1;
  packageId: string;
  version: string;
  title: string;
  permissions: EvenHubPermission[];
  contentSha256: string;
  provenance: {
    source: "bundled";
    sourceRevision: string;
    license: "GPL-3.0-only";
  };
};

export type EvenHubCompatPackage = {
  manifest: EvenHubPackageManifest;
  canonicalContent: string;
  initialView: EvenHubView;
};

export type EvenHubRequest = {
  version: 1;
  generation: number;
  requestId: string;
  method: "display.set" | "storage.get" | "storage.set" | "storage.remove" | "timer.set" | "timer.clear";
  params: Record<string, unknown>;
};

const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>`]/u;
const URL_LIKE = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|org|net|io|dev|app)\b)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(record).every((key) => keys.has(key)) && allowed.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

export function utf8Bytes(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./gi, "x").length;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validText(value: unknown, maxCodePoints: number, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= maxCodePoints &&
    utf8Bytes(value) <= maxBytes && !FORBIDDEN_TEXT.test(value) && !URL_LIKE.test(value);
}

function validateView(value: unknown): string | null {
  if (!isRecord(value) || !exactKeys(value, ["title", "blocks", "actions"])) return "view schema is invalid";
  if (!validText(value.title, 80, 320)) return "view title is invalid";
  if (!Array.isArray(value.blocks) || value.blocks.length > 32) return "view blocks are invalid";
  if (!Array.isArray(value.actions) || value.actions.length > 8) return "view actions are invalid";
  let textBytes = utf8Bytes(value.title);
  for (const block of value.blocks) {
    if (!isRecord(block) || typeof block.type !== "string") return "view block is invalid";
    if (block.type === "divider") {
      if (!exactKeys(block, ["type"])) return "divider is invalid";
    } else if (block.type === "text") {
      if (!exactKeys(block, block.emphasis === undefined ? ["type", "text"] : ["type", "text", "emphasis"]) ||
          !validText(block.text, 1024, 1024) ||
          (block.emphasis !== undefined && block.emphasis !== "normal" && block.emphasis !== "strong")) return "text block is invalid";
      textBytes += utf8Bytes(block.text);
    } else if (block.type === "key_value") {
      if (!exactKeys(block, ["type", "label", "value"]) || !validText(block.label, 80, 320) || !validText(block.value, 160, 640)) {
        return "key value block is invalid";
      }
      textBytes += utf8Bytes(block.label) + utf8Bytes(block.value);
    } else if (block.type === "progress") {
      if (!exactKeys(block, ["type", "label", "value"]) || !validText(block.label, 80, 320) ||
          typeof block.value !== "number" || !Number.isFinite(block.value) || block.value < 0 || block.value > 1) {
        return "progress block is invalid";
      }
      textBytes += utf8Bytes(block.label);
    } else return "view block type is unsupported";
  }
  const actionIds = new Set<string>();
  for (const action of value.actions) {
    if (!isRecord(action) || !exactKeys(action, ["id", "label"]) || !validId(action.id) || !validText(action.label, 40, 160) || actionIds.has(action.id)) {
      return "view action is invalid";
    }
    actionIds.add(action.id);
    textBytes += utf8Bytes(action.label);
  }
  return textBytes <= 8 * 1024 ? null : "view text exceeds 8 KiB";
}

export function validatePackageManifest(value: unknown): string | null {
  if (!isRecord(value) || !exactKeys(value, ["formatVersion", "packageId", "version", "title", "permissions", "contentSha256", "provenance"])) {
    return "manifest schema is invalid";
  }
  if (value.formatVersion !== 1 || !validId(value.packageId) || typeof value.version !== "string" || !VERSION_PATTERN.test(value.version) ||
      !validText(value.title, 80, 320) || typeof value.contentSha256 !== "string" || !SHA256_PATTERN.test(value.contentSha256)) {
    return "manifest identity is invalid";
  }
  if (!Array.isArray(value.permissions) || value.permissions.length > LOCAL_ONLY_PERMISSIONS.length ||
      value.permissions.some((permission) => !LOCAL_ONLY_PERMISSIONS.includes(permission as EvenHubPermission)) ||
      new Set(value.permissions).size !== value.permissions.length) return "manifest requests a prohibited permission";
  if (!isRecord(value.provenance) || !exactKeys(value.provenance, ["source", "sourceRevision", "license"]) ||
      value.provenance.source !== "bundled" || value.provenance.sourceRevision !== "in-repository" ||
      value.provenance.license !== "GPL-3.0-only") return "manifest provenance is invalid";
  return null;
}

export function validateEvenHubRequest(value: unknown): string | null {
  if (!isRecord(value) || !exactKeys(value, ["version", "generation", "requestId", "method", "params"])) return "request schema is invalid";
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return "request is not serializable"; }
  if (utf8Bytes(encoded) > EVENHUB_MAX_MESSAGE_BYTES) return "request exceeds 16 KiB";
  if (value.version !== 1 || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 || !validId(value.requestId) || !isRecord(value.params)) {
    return "request envelope is invalid";
  }
  switch (value.method) {
    case "display.set":
      if (!exactKeys(value.params, ["view"])) return "display parameters are invalid";
      return validateView(value.params.view);
    case "storage.get":
    case "storage.remove":
      return exactKeys(value.params, ["key"]) && validId(value.params.key) ? null : "storage parameters are invalid";
    case "storage.set":
      return exactKeys(value.params, ["key", "value"]) && validId(value.params.key) && typeof value.params.value === "string" &&
        utf8Bytes(value.params.value) <= EVENHUB_MAX_STORAGE_VALUE_BYTES ? null : "storage parameters are invalid";
    case "timer.set":
      return exactKeys(value.params, ["timerId", "delayMs"]) && validId(value.params.timerId) && Number.isInteger(value.params.delayMs) &&
        (value.params.delayMs as number) >= EVENHUB_MIN_TIMER_MS && (value.params.delayMs as number) <= EVENHUB_MAX_TIMER_MS
        ? null : "timer parameters are invalid";
    case "timer.clear":
      return exactKeys(value.params, ["timerId"]) && validId(value.params.timerId) ? null : "timer parameters are invalid";
    default:
      return "request method is unsupported";
  }
}

export const BUNDLED_COUNTER_PACKAGE: EvenHubCompatPackage = Object.freeze({
  manifest: Object.freeze({
    formatVersion: 1,
    packageId: "local-counter",
    version: "1.0.0",
    title: "Local Counter",
    permissions: Object.freeze(["display", "input", "storage", "timers"]),
    contentSha256: "afb4bb9028e1e8e4fba211aeb0bf8c5e3b72573c4c971aaddc444683f95b54ad",
    provenance: Object.freeze({ source: "bundled", sourceRevision: "in-repository", license: "GPL-3.0-only" }),
  }),
  canonicalContent: '{"actions":["increment","reset","timer"],"appId":"local-counter","title":"Local Counter","version":1}',
  initialView: Object.freeze({
    title: "Local Counter",
    blocks: Object.freeze([
      Object.freeze({ type: "text", text: "Audited local compatibility sample", emphasis: "normal" }),
      Object.freeze({ type: "key_value", label: "Count", value: "0" }),
    ]),
    actions: Object.freeze([
      Object.freeze({ id: "increment", label: "Increment" }),
      Object.freeze({ id: "reset", label: "Reset" }),
      Object.freeze({ id: "timer", label: "Start timer" }),
    ]),
  }),
}) as unknown as EvenHubCompatPackage;
