export type NotificationTier = "mute" | "digest" | "immediate" | "urgent";

export type NotificationClock = {
  wallMs: number;
  elapsedMs: number;
  localMinute: number;
  timezoneOffsetMinutes: number;
};

export type NotificationPolicyInput = {
  key: string;
  packageName: string;
  appName: string;
  revision: string;
  duplicateKey: string;
  displayable: boolean;
  category: string;
  channelId: string;
  sender: string;
  groupKey: string;
  groupSummary: boolean;
  clearable: boolean;
};

export type NotificationRule = {
  scope: "sender" | "channel" | "category" | "app" | "default";
  packageName?: string;
  value?: string;
  tier: NotificationTier;
};

export type NotificationTriagePolicy = {
  rules: readonly NotificationRule[];
  quietStartMinute: number;
  quietEndMinute: number;
  urgentBypassesQuiet: boolean;
  cooldownMs: number;
  duplicateWindowMs: number;
  rateWindowMs: number;
  immediateRateCap: number;
  perAppRateCap: number;
  digestIntervalMs: number;
  queueTtlMs: number;
  tombstoneMs: number;
  maxQueue: number;
  maxQueuePerApp: number;
  maxDigestItems: number;
};

export const DEFAULT_NOTIFICATION_POLICY: NotificationTriagePolicy = {
  rules: [],
  quietStartMinute: 22 * 60,
  quietEndMinute: 7 * 60,
  urgentBypassesQuiet: true,
  cooldownMs: 60_000,
  duplicateWindowMs: 120_000,
  rateWindowMs: 60_000,
  immediateRateCap: 4,
  perAppRateCap: 2,
  digestIntervalMs: 15 * 60_000,
  queueTtlMs: 24 * 60 * 60_000,
  tombstoneMs: 10 * 60_000,
  maxQueue: 128,
  maxQueuePerApp: 16,
  maxDigestItems: 8,
};

type ActiveRecord = NotificationPolicyInput & {
  seenElapsedMs: number;
  reason: string;
};

export type QueuedNotification = {
  key: string;
  packageName: string;
  revision: string;
  duplicateKey: string;
  tier: Exclude<NotificationTier, "mute">;
  reason: string;
  firstQueuedWallMs: number;
  firstQueuedElapsedMs: number;
  updatedElapsedMs: number;
  dueElapsedMs: number;
  sequence: number;
};

export type NotificationTriageState = {
  active: Record<string, ActiveRecord>;
  queue: QueuedNotification[];
  tombstones: Record<string, number>;
  deliveries: Array<{ key: string; packageName: string; duplicateKey: string; elapsedMs: number }>;
  clearOperations: string[];
  nextSequence: number;
};

export type NotificationTriageEffect =
  | { kind: "immediate"; key: string; revision: string; reason: string }
  | { kind: "digest-ready"; items: Array<{ key: string; revision: string }>; omittedCount: number; reason: string }
  | { kind: "removed"; key: string }
  | { kind: "dismiss-all"; operationId: string };

export type NotificationTriageEvent =
  | { kind: "posted"; notification: NotificationPolicyInput; clock: NotificationClock }
  | { kind: "removed"; key: string; clock: NotificationClock }
  | { kind: "dismissed"; key: string; clock: NotificationClock }
  | { kind: "clear-all"; operationId: string; clock: NotificationClock }
  | { kind: "digest-presented"; items: Array<{ key: string; revision: string }>; clock: NotificationClock }
  | { kind: "presentation-failed"; key: string; clock: NotificationClock }
  | { kind: "tick"; clock: NotificationClock };

export function createNotificationTriageState(): NotificationTriageState {
  return { active: {}, queue: [], tombstones: {}, deliveries: [], clearOperations: [], nextSequence: 1 };
}

export function hydrateNotificationTriage(
  activeNotifications: readonly NotificationPolicyInput[],
  clock: NotificationClock,
): { state: NotificationTriageState; effects: NotificationTriageEffect[] } {
  const state = createNotificationTriageState();
  for (const notification of activeNotifications) {
    state.active[notification.key] = {
      ...notification,
      seenElapsedMs: clock.elapsedMs,
      reason: "active at restart",
    };
  }
  return { state, effects: [] };
}

/** Persist only bounded aggregate metadata; notification keys, apps, senders and content stay volatile. */
export function serializeNotificationTriageMetadata(state: NotificationTriageState, clock: NotificationClock): string {
  return JSON.stringify({
    v: 1,
    savedWallMs: Math.max(0, Math.floor(clock.wallMs)),
    queuedCount: Math.min(DEFAULT_NOTIFICATION_POLICY.maxQueue, state.queue.length),
    activeCount: Math.min(256, Object.keys(state.active).length),
    clearOperationCount: Math.min(32, state.clearOperations.length),
  });
}

function boundedQueue(queue: QueuedNotification[], policy: NotificationTriagePolicy): QueuedNotification[] {
  const ordered = [...queue].sort((left, right) => left.sequence - right.sequence || left.key.localeCompare(right.key));
  const perApp = new Map<string, number>();
  const kept: QueuedNotification[] = [];
  for (let index = ordered.length - 1; index >= 0; index--) {
    const entry = ordered[index]!;
    const count = perApp.get(entry.packageName) ?? 0;
    if (count >= policy.maxQueuePerApp || kept.length >= policy.maxQueue) continue;
    perApp.set(entry.packageName, count + 1);
    kept.push(entry);
  }
  return kept.sort((left, right) => left.sequence - right.sequence || left.key.localeCompare(right.key));
}

function selectFairDigest(queue: QueuedNotification[], limit: number): QueuedNotification[] {
  const byApp = new Map<string, QueuedNotification[]>();
  for (const entry of [...queue].sort((left, right) => left.sequence - right.sequence || left.key.localeCompare(right.key))) {
    const entries = byApp.get(entry.packageName) ?? [];
    entries.push(entry);
    byApp.set(entry.packageName, entries);
  }
  const selected: QueuedNotification[] = [];
  while (selected.length < limit) {
    let added = false;
    for (const entries of byApp.values()) {
      const entry = entries.shift();
      if (!entry) continue;
      selected.push(entry);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

function quietAt(localMinute: number, policy: NotificationTriagePolicy): boolean {
  const minute = Math.max(0, Math.min(1439, Math.floor(localMinute)));
  if (policy.quietStartMinute === policy.quietEndMinute) return false;
  if (policy.quietStartMinute < policy.quietEndMinute) {
    return minute >= policy.quietStartMinute && minute < policy.quietEndMinute;
  }
  return minute >= policy.quietStartMinute || minute < policy.quietEndMinute;
}

function resolveTier(notification: NotificationPolicyInput, policy: NotificationTriagePolicy): { tier: NotificationTier; reason: string } {
  const matchers: Array<[NotificationRule["scope"], string]> = [
    ["sender", notification.sender],
    ["channel", notification.channelId],
    ["category", notification.category],
    ["app", notification.packageName],
    ["default", ""],
  ];
  for (const [scope, value] of matchers) {
    const rule = policy.rules.find((candidate) => {
      if (candidate.scope !== scope) return false;
      if (scope !== "default" && scope !== "category" && candidate.packageName !== notification.packageName) return false;
      if (scope === "app") return candidate.packageName === notification.packageName;
      return scope === "default" || candidate.value === value;
    });
    if (rule) return { tier: rule.tier, reason: `${scope} rule: ${rule.tier}` };
  }
  // The Android listener admits only the exact clearable, auto-cancel Codex
  // completion channel. Treat that final agent turn as urgent so the user's
  // explicit app selection actually wakes G2 during quiet hours. Any authored
  // sender/channel/app rule above remains authoritative and can mute it.
  if (
    notification.packageName === "com.openai.chatgpt" &&
    notification.channelId === "codex" &&
    notification.clearable &&
    !notification.groupSummary
  ) {
    return { tier: "urgent", reason: "Codex final result: urgent" };
  }
  if (notification.category === "call" || notification.category === "alarm") {
    return { tier: "urgent", reason: `${notification.category} category: urgent` };
  }
  return { tier: "immediate", reason: "default immediate" };
}

export function reduceNotificationTriage(
  state: NotificationTriageState,
  event: NotificationTriageEvent,
  policy: NotificationTriagePolicy = DEFAULT_NOTIFICATION_POLICY,
): { state: NotificationTriageState; effects: NotificationTriageEffect[] } {
  const active = { ...state.active };
  const deliveries = state.deliveries.filter((entry) => event.clock.elapsedMs - entry.elapsedMs <= policy.rateWindowMs);
  state = {
    ...state,
    tombstones: Object.fromEntries(
      Object.entries(state.tombstones).filter(([, expires]) => expires > event.clock.elapsedMs),
    ),
  };
  if (event.kind === "tick") {
    if (quietAt(event.clock.localMinute, policy)) return { state: { ...state, deliveries }, effects: [] };
    const liveQueue = state.queue.filter((entry) => {
      const age = Math.max(0, event.clock.elapsedMs - entry.firstQueuedElapsedMs);
      return age <= policy.queueTtlMs && state.active[entry.key]?.revision === entry.revision;
    });
    const due = liveQueue.filter((entry) => entry.dueElapsedMs <= event.clock.elapsedMs);
    if (!due.length) return { state: { ...state, queue: liveQueue, deliveries }, effects: [] };
    const selected = selectFairDigest(due, policy.maxDigestItems);
    return {
      state: { ...state, queue: liveQueue, deliveries },
      effects: [{
        kind: "digest-ready",
        items: selected.map((entry) => ({ key: entry.key, revision: entry.revision })),
        omittedCount: Math.max(0, due.length - selected.length),
        reason: "scheduled digest",
      }],
    };
  }
  if (event.kind === "digest-presented") {
    for (const presented of event.items) {
      const item = active[presented.key];
      if (item?.revision === presented.revision) deliveries.push({
        key: presented.key,
        packageName: item.packageName,
        duplicateKey: item.duplicateKey,
        elapsedMs: event.clock.elapsedMs,
      });
    }
    return {
      state: {
        ...state,
        queue: state.queue.filter((entry) => !event.items.some(
          (presented) => presented.key === entry.key && presented.revision === entry.revision,
        )),
        deliveries,
      },
      effects: [],
    };
  }
  if (event.kind === "presentation-failed") {
    const item = active[event.key];
    if (!item) {
      return { state: { ...state, deliveries: deliveries.filter((entry) => entry.key !== event.key) }, effects: [] };
    }
    const resolved = resolveTier(item, policy);
    if (resolved.tier === "mute") {
      return { state: { ...state, deliveries: deliveries.filter((entry) => entry.key !== event.key) }, effects: [] };
    }
    const existing = state.queue.find((queued) =>
      queued.key === item.key && queued.revision === item.revision
    );
    const queue = state.queue.filter((queued) => queued.key !== item.key);
    queue.push({
      key: item.key,
      packageName: item.packageName,
      revision: item.revision,
      duplicateKey: item.duplicateKey,
      tier: resolved.tier,
      reason: item.reason,
      firstQueuedWallMs: existing?.firstQueuedWallMs ?? event.clock.wallMs,
      firstQueuedElapsedMs: existing?.firstQueuedElapsedMs ?? event.clock.elapsedMs,
      updatedElapsedMs: event.clock.elapsedMs,
      dueElapsedMs: event.clock.elapsedMs,
      sequence: existing?.sequence ?? state.nextSequence,
    });
    return {
      state: {
        ...state,
        queue: boundedQueue(queue, policy),
        deliveries: deliveries.filter((entry) => entry.key !== event.key),
        nextSequence: existing ? state.nextSequence : state.nextSequence + 1,
      },
      effects: [],
    };
  }
  if (event.kind === "clear-all") {
    if (state.clearOperations.includes(event.operationId)) {
      return { state: { ...state, deliveries }, effects: [] };
    }
    const tombstones = { ...state.tombstones };
    for (const key of Object.keys(active)) {
      tombstones[key] = event.clock.elapsedMs + policy.tombstoneMs;
    }
    return {
      state: {
        ...state,
        queue: [],
        deliveries,
        tombstones,
        clearOperations: [...state.clearOperations.slice(-31), event.operationId],
      },
      effects: [{ kind: "dismiss-all", operationId: event.operationId }],
    };
  }
  if (event.kind === "removed") {
    delete active[event.key];
    const tombstones = { ...state.tombstones };
    delete tombstones[event.key];
    return {
      state: { ...state, active, tombstones, deliveries, queue: state.queue.filter((queued) => queued.key !== event.key) },
      effects: [{ kind: "removed", key: event.key }],
    };
  }
  if (event.kind === "dismissed") {
    delete active[event.key];
    return {
      state: {
        ...state,
        active,
        deliveries,
        queue: state.queue.filter((queued) => queued.key !== event.key),
        tombstones: { ...state.tombstones, [event.key]: event.clock.elapsedMs + policy.tombstoneMs },
      },
      effects: [],
    };
  }
  const current = active[event.notification.key];
  if (current?.revision === event.notification.revision) {
    return { state, effects: [] };
  }
  const resolved = resolveTier(event.notification, policy);
  const quietApplies = quietAt(event.clock.localMinute, policy)
    && (resolved.tier !== "urgent" || !policy.urgentBypassesQuiet);
  const reason = quietApplies
    ? "quiet hours"
    : resolved.reason;
  active[event.notification.key] = {
    ...event.notification,
    seenElapsedMs: event.clock.elapsedMs,
    reason,
  };
  if ((state.tombstones[event.notification.key] ?? 0) > event.clock.elapsedMs) {
    return { state: { ...state, active, deliveries }, effects: [] };
  }
  if (resolved.tier === "mute" || !event.notification.displayable || event.notification.groupSummary) {
    return { state: { ...state, active, deliveries }, effects: [] };
  }
  const duplicate = deliveries.some((entry) =>
    entry.duplicateKey === event.notification.duplicateKey
      && entry.key !== event.notification.key
      && event.clock.elapsedMs - entry.elapsedMs <= policy.duplicateWindowMs,
  );
  const queuedDuplicate = state.queue.some((entry) =>
    entry.duplicateKey === event.notification.duplicateKey && entry.key !== event.notification.key,
  );
  if (duplicate || queuedDuplicate) return { state: { ...state, active, deliveries }, effects: [] };

  const packageDeliveries = deliveries.filter((entry) => entry.packageName === event.notification.packageName);
  const sameKeyRecent = deliveries.some((entry) =>
    entry.key === event.notification.key && event.clock.elapsedMs - entry.elapsedMs <= policy.cooldownMs,
  );
  const capped = deliveries.length >= policy.immediateRateCap || packageDeliveries.length >= policy.perAppRateCap;
  const shouldQueue = resolved.tier === "digest"
    || sameKeyRecent
    || capped
    || quietApplies;
  if (shouldQueue) {
    const existing = state.queue.find((queued) => queued.key === event.notification.key);
    const queue = state.queue.filter((queued) => queued.key !== event.notification.key);
    queue.push({
      key: event.notification.key,
      packageName: event.notification.packageName,
      revision: event.notification.revision,
      duplicateKey: event.notification.duplicateKey,
      tier: resolved.tier,
      reason,
      firstQueuedWallMs: existing?.firstQueuedWallMs ?? event.clock.wallMs,
      firstQueuedElapsedMs: existing?.firstQueuedElapsedMs ?? event.clock.elapsedMs,
      updatedElapsedMs: event.clock.elapsedMs,
      dueElapsedMs: event.clock.elapsedMs + policy.digestIntervalMs,
      sequence: existing?.sequence ?? state.nextSequence,
    });
    return {
      state: {
        ...state,
        active,
        deliveries,
        queue: boundedQueue(queue, policy),
        nextSequence: existing ? state.nextSequence : state.nextSequence + 1,
      },
      effects: [],
    };
  }
  deliveries.push({
    key: event.notification.key,
    packageName: event.notification.packageName,
    duplicateKey: event.notification.duplicateKey,
    elapsedMs: event.clock.elapsedMs,
  });
  return {
    state: { ...state, active, deliveries },
    effects: [{ kind: "immediate", key: event.notification.key, revision: event.notification.revision, reason: resolved.reason }],
  };
}
