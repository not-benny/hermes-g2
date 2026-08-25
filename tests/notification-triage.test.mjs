import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/notifications/triage-policy.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const policyModule = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const {
  DEFAULT_NOTIFICATION_POLICY,
  createNotificationTriageState,
  hydrateNotificationTriage,
  reduceNotificationTriage,
  serializeNotificationTriageMetadata,
} = policyModule;

const clock = (wallMs, elapsedMs = wallMs, localMinute = 12 * 60, timezoneOffsetMinutes = 0) => ({
  wallMs,
  elapsedMs,
  localMinute,
  timezoneOffsetMinutes,
});
const item = (overrides = {}) => ({
  key: "key-1",
  packageName: "chat.example",
  appName: "Chat",
  revision: "rev-1",
  duplicateKey: "dup-1",
  displayable: true,
  category: "msg",
  channelId: "messages",
  sender: "Alice",
  groupKey: "",
  groupSummary: false,
  clearable: true,
  ...overrides,
});

function post(state, notification, at, policy = DEFAULT_NOTIFICATION_POLICY) {
  return reduceNotificationTriage(state, { kind: "posted", notification, clock: at }, policy);
}

test("a default notification is immediate exactly once", () => {
  const initial = createNotificationTriageState();
  const first = post(initial, item(), clock(1_000));
  assert.deepEqual(first.effects, [{ kind: "immediate", key: "key-1", revision: "rev-1", reason: "default immediate" }]);

  const duplicate = post(first.state, item(), clock(1_001));
  assert.deepEqual(duplicate.effects, []);
});

test("specific rules win and quiet hours digest non-urgent notifications", () => {
  const policy = {
    ...DEFAULT_NOTIFICATION_POLICY,
    rules: [
      { scope: "default", tier: "digest" },
      { scope: "category", value: "msg", tier: "immediate" },
      { scope: "app", packageName: "chat.example", tier: "digest" },
      { scope: "channel", packageName: "chat.example", value: "messages", tier: "urgent" },
      { scope: "sender", packageName: "chat.example", value: "Alice", tier: "mute" },
    ],
  };
  const muted = post(createNotificationTriageState(), item(), clock(1_000), policy);
  assert.deepEqual(muted.effects, []);
  assert.equal(muted.state.active["key-1"].reason, "sender rule: mute");

  const quiet = post(createNotificationTriageState(), item({ sender: "Bob", channelId: "other" }), clock(2_000, 2_000, 23 * 60), policy);
  assert.deepEqual(quiet.effects, []);
  assert.equal(quiet.state.queue[0].reason, "quiet hours");

  const urgent = post(createNotificationTriageState(), item({ sender: "Bob" }), clock(3_000, 3_000, 23 * 60), policy);
  assert.deepEqual(urgent.effects, [{ kind: "immediate", key: "key-1", revision: "rev-1", reason: "channel rule: urgent" }]);
});

test("a selected Codex final wakes during quiet hours while authored policy remains authoritative", () => {
  const final = item({
    packageName: "com.openai.chatgpt",
    appName: "ChatGPT",
    channelId: "codex",
    clearable: true,
    category: "",
  });
  const delivered = post(createNotificationTriageState(), final, clock(1_000, 1_000, 23 * 60));
  assert.deepEqual(delivered.effects, [{ kind: "immediate", key: "key-1", revision: "rev-1", reason: "Codex final result: urgent" }]);

  const muted = post(createNotificationTriageState(), final, clock(2_000, 2_000, 12 * 60), {
    ...DEFAULT_NOTIFICATION_POLICY,
    rules: [{ scope: "channel", packageName: "com.openai.chatgpt", value: "codex", tier: "mute" }],
  });
  assert.deepEqual(muted.effects, []);
  assert.equal(muted.state.active["key-1"].reason, "channel rule: mute");

  const progress = post(createNotificationTriageState(), { ...final, channelId: "codex_remote_session", clearable: false }, clock(3_000));
  assert.equal(progress.effects[0]?.reason, "default immediate", "pure reducer does not infer lifecycle from text");
});

test("updates replace queued revisions and removal or dismissal prevents stale resurfacing", () => {
  const policy = { ...DEFAULT_NOTIFICATION_POLICY, rules: [{ scope: "default", tier: "digest" }] };
  const first = post(createNotificationTriageState(), item(), clock(1_000), policy);
  const updated = post(first.state, item({ revision: "rev-2", duplicateKey: "dup-2" }), clock(2_000), policy);
  assert.equal(updated.state.queue.length, 1);
  assert.equal(updated.state.queue[0].revision, "rev-2");
  assert.equal(updated.state.queue[0].firstQueuedElapsedMs, 1_000);

  const removed = reduceNotificationTriage(updated.state, { kind: "removed", key: "key-1", clock: clock(3_000) }, policy);
  assert.equal(removed.state.queue.length, 0);
  assert.equal(removed.state.active["key-1"], undefined);
  assert.deepEqual(removed.effects, [{ kind: "removed", key: "key-1" }]);

  const reposted = post(removed.state, item({ revision: "rev-3" }), clock(4_000), policy);
  const dismissed = reduceNotificationTriage(reposted.state, { kind: "dismissed", key: "key-1", clock: clock(5_000) }, policy);
  const lateUpdate = post(dismissed.state, item({ revision: "rev-4" }), clock(5_001), { ...policy, rules: [] });
  assert.deepEqual(lateUpdate.effects, []);
  assert.equal(lateUpdate.state.queue.length, 0);
});

test("cooldown, deduplication, rate caps, and digest draining are bounded and fair", () => {
  const policy = {
    ...DEFAULT_NOTIFICATION_POLICY,
    quietStartMinute: 0,
    quietEndMinute: 0,
    cooldownMs: 100,
    duplicateWindowMs: 100,
    rateWindowMs: 100,
    immediateRateCap: 2,
    perAppRateCap: 1,
    digestIntervalMs: 10,
    maxDigestItems: 3,
  };
  let state = createNotificationTriageState();
  let result = post(state, item({ key: "a1", revision: "a1", duplicateKey: "d1" }), clock(0), policy);
  state = result.state;
  result = post(state, item({ key: "a2", revision: "a2", duplicateKey: "d2" }), clock(1), policy);
  assert.deepEqual(result.effects, [], "one app cannot monopolize the immediate cap");
  state = result.state;
  result = post(state, item({ key: "b1", packageName: "mail.example", revision: "b1", duplicateKey: "d3" }), clock(2), policy);
  assert.equal(result.effects[0].kind, "immediate");
  state = result.state;
  result = post(state, item({ key: "c1", packageName: "news.example", revision: "c1", duplicateKey: "d4" }), clock(3), policy);
  assert.deepEqual(result.effects, []);
  state = result.state;

  result = post(state, item({ key: "duplicate", packageName: "other.example", revision: "x", duplicateKey: "d1" }), clock(4), policy);
  assert.deepEqual(result.effects, []);
  state = result.state;

  const early = reduceNotificationTriage(state, { kind: "tick", clock: clock(9) }, policy);
  assert.deepEqual(early.effects, []);
  const due = reduceNotificationTriage(early.state, { kind: "tick", clock: clock(200) }, policy);
  assert.equal(due.effects[0].kind, "digest-ready");
  assert.deepEqual(due.effects[0].items.map((entry) => entry.key), ["a2", "c1"], "round-robin keeps app order and drops duplicate content");
  assert.ok(due.state.queue.length <= policy.maxQueue);
});

test("empty/group summaries stay silent and restart persistence contains no notification content", () => {
  const empty = post(createNotificationTriageState(), item({ displayable: false }), clock(1_000));
  assert.deepEqual(empty.effects, []);
  const summary = post(createNotificationTriageState(), item({ groupSummary: true }), clock(1_000));
  assert.deepEqual(summary.effects, []);

  const privateItem = item({ key: "PRIVATE-KEY", packageName: "private.package", sender: "PRIVATE-SENDER", revision: "PRIVATE-BODY" });
  const queued = post(createNotificationTriageState(), privateItem, clock(2_000), {
    ...DEFAULT_NOTIFICATION_POLICY,
    rules: [{ scope: "default", tier: "digest" }],
  });
  const persisted = serializeNotificationTriageMetadata(queued.state, clock(2_500));
  assert.ok(persisted.length < 512);
  for (const marker of ["PRIVATE-KEY", "private.package", "PRIVATE-SENDER", "PRIVATE-BODY"]) {
    assert.equal(persisted.includes(marker), false, marker);
  }

  const restored = hydrateNotificationTriage([privateItem], clock(3_000));
  assert.deepEqual(restored.effects, [], "active notifications at process restart never wake the glasses");
  assert.equal(restored.state.queue.length, 0, "stale digest content is not resurrected");
});

test("clear-all is idempotent and wall/timezone changes never cause an early digest", () => {
  const policy = { ...DEFAULT_NOTIFICATION_POLICY, digestIntervalMs: 100, rules: [{ scope: "default", tier: "digest" }] };
  const queued = post(createNotificationTriageState(), item(), clock(10_000, 10, 12 * 60), policy);
  const wallRollback = reduceNotificationTriage(queued.state, { kind: "tick", clock: clock(1, 99, 12 * 60) }, policy);
  assert.deepEqual(wallRollback.effects, []);
  const timezoneQuiet = reduceNotificationTriage(wallRollback.state, { kind: "tick", clock: clock(20_000, 200, 23 * 60, 60) }, policy);
  assert.deepEqual(timezoneQuiet.effects, []);

  const cleared = reduceNotificationTriage(timezoneQuiet.state, { kind: "clear-all", operationId: "clear-1", clock: clock(21_000, 201) }, policy);
  assert.equal(cleared.state.queue.length, 0);
  assert.deepEqual(cleared.effects, [{ kind: "dismiss-all", operationId: "clear-1" }]);
  const repeated = reduceNotificationTriage(cleared.state, { kind: "clear-all", operationId: "clear-1", clock: clock(21_001, 202) }, policy);
  assert.deepEqual(repeated.effects, []);
});

test("queued duplicates coalesce, urgent obeys policy, and digest waits for acknowledgement", () => {
  const digestPolicy = {
    ...DEFAULT_NOTIFICATION_POLICY,
    digestIntervalMs: 10,
    quietStartMinute: 0,
    quietEndMinute: 0,
    rules: [{ scope: "default", tier: "digest" }],
  };
  const first = post(createNotificationTriageState(), item({ key: "one" }), clock(0), digestPolicy);
  const duplicate = post(first.state, item({ key: "two" }), clock(1), digestPolicy);
  assert.equal(duplicate.state.queue.length, 1);
  const due = reduceNotificationTriage(duplicate.state, { kind: "tick", clock: clock(20) }, digestPolicy);
  assert.equal(due.effects[0].kind, "digest-ready");
  assert.equal(due.state.queue.length, 1, "failed/unacknowledged display remains retryable");
  const replaced = post(due.state, item({ key: "one", revision: "rev-2", duplicateKey: "dup-2" }), clock(20.5), digestPolicy);
  const staleAck = reduceNotificationTriage(replaced.state, { kind: "digest-presented", items: due.effects[0].items, clock: clock(21) }, digestPolicy);
  assert.equal(staleAck.state.queue[0].revision, "rev-2", "stale acknowledgement cannot consume a replacement revision");
  const acked = reduceNotificationTriage(due.state, { kind: "digest-presented", items: due.effects[0].items, clock: clock(21) }, digestPolicy);
  assert.equal(acked.state.queue.length, 0);

  const quietUrgentPolicy = {
    ...DEFAULT_NOTIFICATION_POLICY,
    urgentBypassesQuiet: false,
    rules: [{ scope: "default", tier: "urgent" }],
  };
  const quietUrgent = post(createNotificationTriageState(), item(), clock(1_000, 1_000, 23 * 60), quietUrgentPolicy);
  assert.deepEqual(quietUrgent.effects, []);
  assert.equal(quietUrgent.state.queue[0].reason, "quiet hours");
});
