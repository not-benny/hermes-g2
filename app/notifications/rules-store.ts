import {
  getStringSetting,
  hasStoredSecretSetting,
  onSettingsStoreChanged,
  removeSecretSetting,
  removeStringSetting,
  setStringSetting,
} from "../native/settings-store";
import type { NotificationRule, NotificationTier } from "./triage-policy";
import { notificationRulesSetting } from "../ui/dashboard-settings";

export const NOTIFICATION_RULES_STORAGE_KEY = "notifications.rules.v2";
const LEGACY_KEY = "notifications.rules";
const MAX_RULES = 256;
const MAX_ENCODED_BYTES = 32 * 1024;
const TIERS = new Set<NotificationTier>(["mute", "digest", "immediate", "urgent"]);
const SCOPES = new Set<NotificationRule["scope"]>(["sender", "channel", "category", "app", "default"]);

export type NotificationRulesDocument = { version: 2; rules: NotificationRule[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  return normalized && Array.from(normalized).length <= max && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(normalized)
    ? normalized
    : null;
}

function normalizeRule(raw: unknown): NotificationRule | null {
  if (!isRecord(raw)) return null;
  const scope = raw.scope;
  const tier = raw.tier;
  if (typeof scope !== "string" || !SCOPES.has(scope as NotificationRule["scope"]) || typeof tier !== "string" || !TIERS.has(tier as NotificationTier)) return null;
  const typedScope = scope as NotificationRule["scope"];
  const packageName = raw.packageName === undefined ? undefined : bounded(raw.packageName, 256);
  const value = raw.value === undefined ? undefined : bounded(raw.value, 128);
  if (raw.packageName !== undefined && !packageName) return null;
  if (typedScope === "default") {
    if (raw.packageName !== undefined || raw.value !== undefined) return null;
    return { scope: "default", tier: tier as NotificationTier };
  }
  if (typedScope === "app") {
    if (!packageName || raw.value !== undefined) return null;
    return { scope: "app", packageName, tier: tier as NotificationTier };
  }
  if (!value || (typedScope !== "category" && !packageName)) return null;
  return { scope: typedScope, ...(packageName ? { packageName } : {}), value, tier: tier as NotificationTier };
}

function key(rule: NotificationRule): string {
  return `${rule.scope}\0${rule.packageName ?? ""}\0${rule.value ?? ""}`;
}

export function decodeNotificationRulesDocument(encoded: string): NotificationRulesDocument | null {
  if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_ENCODED_BYTES) return null;
  let raw: unknown;
  try { raw = JSON.parse(encoded); } catch { return null; }
  if (!isRecord(raw) || !exact(raw, ["version", "rules"]) || raw.version !== 2 || !Array.isArray(raw.rules) || raw.rules.length > MAX_RULES) return null;
  const seen = new Set<string>();
  const rules: NotificationRule[] = [];
  for (const candidate of raw.rules) {
    const rule = normalizeRule(candidate);
    if (!rule || seen.has(key(rule))) return null;
    seen.add(key(rule));
    rules.push(rule);
  }
  return { version: 2, rules };
}

function encode(document: NotificationRulesDocument): string {
  const encoded = JSON.stringify(document);
  if (new TextEncoder().encode(encoded).byteLength > MAX_ENCODED_BYTES) throw new Error("notification rules capacity");
  return encoded;
}

export class NotificationRulesStore {
  private document: NotificationRulesDocument = { version: 2, rules: [] };
  private available = true;
  private lastEncoded = "";
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null;

  constructor() {
    this.reload();
    this.unsubscribe = onSettingsStoreChanged((changed) => {
      if (changed === NOTIFICATION_RULES_STORAGE_KEY || changed === LEGACY_KEY) this.reload();
    });
  }

  dispose(): void { this.unsubscribe?.(); this.unsubscribe = null; this.listeners.clear(); }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  snapshot(): { available: boolean; rules: NotificationRule[] } {
    return { available: this.available, rules: this.document.rules.map((rule) => ({ ...rule })) };
  }

  get(): NotificationRule[] { return this.snapshot().rules; }

  upsert(rule: unknown): NotificationRule[] {
    if (!this.available) throw new Error("notification rules unavailable");
    const normalized = normalizeRule(rule);
    if (!normalized) throw new Error("invalid notification rule");
    const rules = this.document.rules.filter((candidate) => key(candidate) !== key(normalized));
    rules.push(normalized);
    if (rules.length > MAX_RULES) throw new Error("notification rules capacity");
    this.commit({ version: 2, rules });
    return this.get();
  }

  remove(rule: unknown): NotificationRule[] {
    if (!this.available) throw new Error("notification rules unavailable");
    const normalized = normalizeRule(rule);
    if (!normalized) throw new Error("invalid notification rule");
    const rules = this.document.rules.filter((candidate) => key(candidate) !== key(normalized));
    if (rules.length !== this.document.rules.length) this.commit({ version: 2, rules });
    return this.get();
  }

  reset(): void { this.commit({ version: 2, rules: [] }); }

  private commit(document: NotificationRulesDocument): void {
    const encoded = encode(document);
    setStringSetting(NOTIFICATION_RULES_STORAGE_KEY, encoded);
    this.document = document;
    this.lastEncoded = encoded;
    this.available = true;
    this.emit();
  }

  private reload(): void {
    let present = false;
    try { present = hasStoredSecretSetting(NOTIFICATION_RULES_STORAGE_KEY); } catch { this.markUnavailable(); return; }
    const encoded = getStringSetting(NOTIFICATION_RULES_STORAGE_KEY, "");
    if (present && !encoded) { this.markUnavailable(); return; }
    if (encoded) {
      const decoded = decodeNotificationRulesDocument(encoded);
      if (!decoded) { this.markUnavailable(); return; }
      this.document = decoded;
      this.lastEncoded = encoded;
      this.available = true;
      this.emit();
      return;
    }
    // One-time migration: the existing normalizer supplies a safe legacy list.
    const legacy = notificationRulesSetting.get();
    let legacyRules: NotificationRule[] = [];
    try {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed)) legacyRules = parsed.map(normalizeRule).filter((rule): rule is NotificationRule => rule !== null);
    } catch { /* legacy corruption becomes an empty secure rule set */ }
    const migrated = { version: 2 as const, rules: legacyRules.slice(0, MAX_RULES) };
    try {
      const migratedEncoded = encode(migrated);
      setStringSetting(NOTIFICATION_RULES_STORAGE_KEY, migratedEncoded);
      try { removeStringSetting(LEGACY_KEY); } catch { /* secure copy remains authoritative */ }
      this.document = migrated;
      this.lastEncoded = migratedEncoded;
      this.available = true;
      this.emit();
    } catch { this.markUnavailable(); }
  }

  private markUnavailable(): void { this.document = { version: 2, rules: [] }; this.available = false; this.lastEncoded = ""; this.emit(); }

  private emit(): void { for (const listener of Array.from(this.listeners)) { try { listener(); } catch { /* observer boundary */ } } }
}

export const notificationRulesStore = new NotificationRulesStore();

export type NotificationDecisionExplanation = {
  tier: NotificationTier;
  matchedRule: NotificationRule | null;
  reasonCode: string;
  quietHoursApplied: boolean;
  rateLimited: boolean;
  digestDueAtMs: number | null;
};

export function explainNotificationDecision(
  rule: NotificationRule | null,
  tier: NotificationTier,
  options: { quietHoursApplied?: boolean; rateLimited?: boolean; digestDueAtMs?: number | null } = {},
): NotificationDecisionExplanation {
  return {
    tier,
    matchedRule: rule ? { ...rule } : null,
    reasonCode: rule ? `${rule.scope}_rule_${rule.tier}` : `default_${tier}`,
    quietHoursApplied: options.quietHoursApplied === true,
    rateLimited: options.rateLimited === true,
    digestDueAtMs: options.digestDueAtMs ?? null,
  };
}
