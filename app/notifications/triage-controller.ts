import {
  readActiveNotifications,
  readNotificationByKey,
  type AndroidNotification,
  type AndroidNotificationEvent,
} from "../native/notification-icons";
import {
  notificationQuietEndSetting,
  notificationQuietStartSetting,
  notificationRulesSetting,
  notificationTriageMetadataSetting,
  parseNotificationAppTiers,
} from "../ui/dashboard-settings";
import {
  DEFAULT_NOTIFICATION_POLICY,
  hydrateNotificationTriage,
  reduceNotificationTriage,
  serializeNotificationTriageMetadata,
  type NotificationClock,
  type NotificationPolicyInput,
  type NotificationRule,
  type NotificationTriageEffect,
  type NotificationTriagePolicy,
  type NotificationTriageState,
} from "./triage-policy";

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function bounded(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function primaryBody(item: AndroidNotification): string {
  return bounded(item.bigText || item.text || item.lines.join(" ") || item.summaryText, 2048);
}

function toPolicyInput(item: AndroidNotification): NotificationPolicyInput {
  const title = bounded(item.title, 256);
  const body = primaryBody(item);
  const sender = bounded(item.sender, 128);
  const revisionSeed = [title, body, item.subText, item.infoText, item.summaryText, item.category, item.channelId, sender, item.groupSummary].join("\u001f");
  const duplicateSeed = [item.packageName, sender, item.category, title, body].join("\u001f");
  return {
    key: item.key,
    packageName: item.packageName,
    appName: item.appName,
    revision: hashText(revisionSeed),
    duplicateKey: hashText(duplicateSeed),
    displayable: Boolean(title || body),
    category: bounded(item.category, 64),
    channelId: bounded(item.channelId, 128),
    sender,
    groupKey: bounded(item.groupKey, 256),
    groupSummary: item.groupSummary,
    clearable: item.clearable,
  };
}

function minuteSetting(value: string, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60 ? hours * 60 + minutes : fallback;
}

function configuredRules(): NotificationRule[] {
  const rules: NotificationRule[] = [];
  try {
    const parsed = JSON.parse(notificationRulesSetting.get());
    if (Array.isArray(parsed)) {
      for (const candidate of parsed.slice(0, 256)) {
        const scope = String(candidate?.scope ?? "");
        const tier = String(candidate?.tier ?? "");
        if (!["sender", "channel", "category"].includes(scope)) continue;
        if (!["mute", "digest", "immediate", "urgent"].includes(tier)) continue;
        rules.push({
          scope: scope as NotificationRule["scope"],
          packageName: bounded(String(candidate.packageName ?? ""), 256) || undefined,
          value: bounded(String(candidate.value ?? ""), 128),
          tier: tier as NotificationRule["tier"],
        });
      }
    }
  } catch {
    // Corrupt rule configuration fails closed to per-app/default behavior.
  }
  for (const [packageName, tier] of Object.entries(parseNotificationAppTiers())) {
    if (tier !== "default") rules.push({ scope: "app", packageName, tier });
  }
  return rules;
}

function currentPolicy(): NotificationTriagePolicy {
  return {
    ...DEFAULT_NOTIFICATION_POLICY,
    rules: configuredRules(),
    quietStartMinute: minuteSetting(notificationQuietStartSetting.get(), DEFAULT_NOTIFICATION_POLICY.quietStartMinute),
    quietEndMinute: minuteSetting(notificationQuietEndSetting.get(), DEFAULT_NOTIFICATION_POLICY.quietEndMinute),
  };
}

function currentClock(): NotificationClock {
  const now = new Date();
  return {
    wallMs: now.getTime(),
    elapsedMs: typeof performance === "undefined" ? now.getTime() : performance.now(),
    localMinute: now.getHours() * 60 + now.getMinutes(),
    timezoneOffsetMinutes: -now.getTimezoneOffset(),
  };
}

class NotificationTriageController {
  private state: NotificationTriageState;

  constructor() {
    const clock = currentClock();
    const active = readActiveNotifications(100).map(toPolicyInput);
    this.state = hydrateNotificationTriage(active, clock).state;
    this.persist(clock);
  }

  handleAndroidEvent(event: AndroidNotificationEvent): NotificationTriageEffect[] {
    const clock = currentClock();
    if (event.kind === "removed") {
      return this.apply({ kind: "removed", key: event.key, clock }, clock);
    }
    const notification = readNotificationByKey(event.key);
    if (!notification) return this.apply({ kind: "removed", key: event.key, clock }, clock);
    return this.apply({ kind: "posted", notification: toPolicyInput(notification), clock }, clock);
  }

  tick(): NotificationTriageEffect[] {
    const clock = currentClock();
    return this.apply({ kind: "tick", clock }, clock);
  }

  dismiss(key: string): void {
    const clock = currentClock();
    this.apply({ kind: "dismissed", key, clock }, clock);
  }

  clearAll(operationId: string): NotificationTriageEffect[] {
    const clock = currentClock();
    return this.apply({ kind: "clear-all", operationId, clock }, clock);
  }

  reasonFor(key: string): string {
    return this.state.active[key]?.reason ?? "Android notification";
  }

  isCurrent(key: string, revision?: string, requireQueued = false): boolean {
    const active = this.state.active[key];
    if (!active || (this.state.tombstones[key] ?? 0) > currentClock().elapsedMs) return false;
    if (revision !== undefined && active.revision !== revision) return false;
    if (requireQueued && !this.state.queue.some((entry) => entry.key === key && entry.revision === revision)) return false;
    const notification = readNotificationByKey(key);
    if (!notification) return false;
    return revision === undefined || toPolicyInput(notification).revision === revision;
  }

  acknowledgeDigest(items: Array<{ key: string; revision: string }>): void {
    const clock = currentClock();
    this.apply({ kind: "digest-presented", items, clock }, clock);
  }

  presentationFailed(key: string): void {
    const clock = currentClock();
    this.apply({ kind: "presentation-failed", key, clock }, clock);
  }

  private apply(event: Parameters<typeof reduceNotificationTriage>[1], clock: NotificationClock): NotificationTriageEffect[] {
    const result = reduceNotificationTriage(this.state, event, currentPolicy());
    this.state = result.state;
    this.persist(clock);
    return result.effects;
  }

  private persist(clock: NotificationClock): void {
    notificationTriageMetadataSetting.set(serializeNotificationTriageMetadata(this.state, clock));
  }
}

export const notificationTriageController = new NotificationTriageController();

export function notificationTriageReason(key: string): string {
  return notificationTriageController.reasonFor(key);
}
