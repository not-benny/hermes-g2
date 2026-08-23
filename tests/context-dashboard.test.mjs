import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/assistant/context-dashboard.ts", import.meta.url), "utf8")
  .replace('import type { ToolExecutionContext, ToolResult } from "./tool-registry";', "");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { ContextDashboardManager, validateContextDashboardSpec, CONTEXT_DASHBOARD_CAPABILITIES } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

const owner = { caller: "mcp", profileId: "even-g2", connectionGeneration: "socket-1", turnGeneration: "turn-1" };
const baseSpec = {
  version: 2,
  dashboard_key: "rail-liverpool-lime-street",
  title: "Liverpool Lime Street",
  state: "ready",
  privacy: "private",
  summary: { primary: "Next: 14:32 Manchester Airport", uncertainty: "exact" },
  sections: [{
    id: "departures", order: 0, type: "departures", title: "Departures", load_state: "ready",
    source_ids: ["rail"], uncertainty: "exact", rows: [{
      id: "service-1", destination: "Manchester Airport", scheduled_departure_ms: 1_800_000,
      expected_departure_ms: 1_800_000, status: "on_time", platform: "6",
    }],
  }],
  sources: [{ id: "rail", label: "National Rail", observed_at_ms: 1_000_000, stale_after_seconds: 120, status: "current" }],
  local_actions: [{ id: "refresh", kind: "refresh", label: "Refresh", enabled: true }, { id: "pin", kind: "pin", label: "Pin", enabled: true }],
  announcement: { id: "rail-first-useful", text: "Liverpool Lime Street: next is the 14:32 to Manchester Airport, expected on time.", policy: "once_when_useful" },
  ttl_seconds: 300,
};

function setup() {
  let id = 0;
  const deliveries = [];
  const persisted = [];
  const manager = new ContextDashboardManager({
    isDisplayAvailable: () => true,
    deliver: async (state) => { deliveries.push(structuredClone(state)); return { status: "acknowledged", frameId: deliveries.length }; },
    clear: () => {},
    createId: () => `contextdashboard${String(++id).padStart(3, "0")}`,
    loadPins: () => [],
    savePins: (pins) => persisted.push(structuredClone(pins)),
    now: () => 1_000_000,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  return { manager, deliveries, persisted };
}

test("V2 contextual dashboard schema is read-only, bounded, and provenance-explicit", () => {
  assert.equal(validateContextDashboardSpec(baseSpec), null);
  assert.equal(CONTEXT_DASHBOARD_CAPABILITIES.protocolVersion, 2);
  assert.deepEqual(CONTEXT_DASHBOARD_CAPABILITIES.localActions, ["refresh", "pin", "unpin", "section", "follow_up"]);
  for (const bad of [
    { ...baseSpec, script: "run()" },
    { ...baseSpec, local_actions: [{ id: "x", kind: "toggle", label: "Toggle", enabled: true }] },
    { ...baseSpec, sources: [] },
    { ...baseSpec, sections: [{ ...baseSpec.sections[0], source_ids: ["missing"] }] },
    { ...baseSpec, summary: { ...baseSpec.summary, primary: "https://secret.example" } },
    { ...baseSpec, sections: Array.from({ length: 5 }, (_, order) => ({ id: `s${order}`, order, type: "message", load_state: "ready", source_ids: ["rail"], uncertainty: "exact", body: "x" })) },
  ]) assert.ok(validateContextDashboardSpec(bad), JSON.stringify(bad));
});

test("begin acknowledges loading before useful publish and a later exact turn may refresh the same presentation", async () => {
  const { manager, deliveries } = setup();
  const begun = await manager.begin({
    operation_id: "begin-1", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "on_visible", min_interval_seconds: 30 }, ttl_seconds: 300,
  }, undefined, () => true, owner);
  const beginReceipt = JSON.parse(begun.content);
  assert.equal(deliveries[0].state, "loading");
  assert.equal(beginReceipt.revision, 1);

  const published = await manager.publish({
    operation_id: "publish-1", dashboard_id: beginReceipt.dashboard_id,
    presentation_generation: beginReceipt.presentation_generation, refresh_generation: 1,
    expected_revision: 1, spec: baseSpec,
  }, undefined, () => true, owner);
  assert.equal(JSON.parse(published.content).revision, 2);

  const refreshed = await manager.startRefresh({ operation_id: "refresh-1", dashboard_id: beginReceipt.dashboard_id,
    presentation_generation: beginReceipt.presentation_generation, expected_revision: 2 },
  undefined, () => true, { ...owner, turnGeneration: "turn-2" });
  assert.equal(JSON.parse(refreshed.content).refresh_generation, 2);
  assert.equal(deliveries.at(-1).state, "loading");
});

test("phone integration exposes only read-only contextual dashboard publication and contextual voice", () => {
  const tools = readFileSync(new URL("../app/assistant/system-tools.ts", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../app/ui/shell/shell.ts", import.meta.url), "utf8");
  const mcp = readFileSync(new URL("../app/assistant/mcp-server.ts", import.meta.url), "utf8");
  for (const name of [
    "glasses.context_dashboard.capabilities",
    "glasses.context_dashboard.begin",
    "glasses.context_dashboard.publish",
    "glasses.context_dashboard.start_refresh",
  ]) assert.ok(tools.includes(`name: "${name}"`), name);
  assert.doesNotMatch(tools, /glasses\.context_dashboard\.(?:toggle|mutate|execute)/);
  assert.match(shell, /contextDashboardVoicePrefix/);
  assert.match(shell, /this\.openVoiceDialog\(\{ defaultTarget: "assistant" \}\)/);
  assert.match(shell, /prior\.state\.viewId !== state\.viewId[\s\S]*?prior\.close\(\)/);
  assert.match(mcp, /profilePolicyError/);
  assert.match(mcp, /this\.options\.getProfileId\?\.\(\) \?\? this\.options\.profileId/);
});

test("local refresh emits one replay-safe read-only rerun intent and pin persistence contains no rendered data", async () => {
  const { manager, persisted } = setup();
  const begun = JSON.parse((await manager.begin({
    operation_id: "begin-local", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "on_visible", min_interval_seconds: 30 }, ttl_seconds: 300,
  }, undefined, () => true, owner)).content);
  const localSpec = { ...baseSpec, local_actions: [
    { id: "refresh", kind: "refresh", label: "Refresh", enabled: true },
    { id: "pin", kind: "pin", label: "Pin", enabled: true },
  ] };
  await manager.publish({ operation_id: "publish-local", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: localSpec }, undefined, () => true, owner);

  const refreshIndex = manager.snapshot().components.findIndex((component) => component.id === "local-refresh");
  for (let index = 0; index < refreshIndex; index++) manager.handleInput("scroll-down", true);
  assert.equal(manager.handleInput("click", true), true);
  const read = manager.readEvents({ ...owner, turnGeneration: "turn-2" }, begun.dashboard_id, 1, 2, null);
  const event = JSON.parse(read.content).events[0];
  assert.equal(event.kind, "refresh");
  assert.equal(event.intent, "When is the next train at Liverpool Lime Street?");
  assert.equal(manager.ackEvents({ ...owner, turnGeneration: "turn-2" }, begun.dashboard_id, 1, 2, event.event_id).ok, true);
  assert.equal(JSON.parse(manager.readEvents({ ...owner, turnGeneration: "turn-2" }, begun.dashboard_id, 1, 2, event.event_id).content).events.length, 0);

  manager.handleInput("scroll-down", true);
  manager.handleInput("click", true);
  assert.equal(persisted.length, 1);
  const encoded = JSON.stringify(persisted[0]);
  assert.doesNotMatch(encoded, /Manchester Airport|National Rail|service-1|announcement|rows|sources/);
  assert.match(encoded, /When is the next train at Liverpool Lime Street/);
  const reopened = await manager.openPin({ operation_id: "reopen-pin", dashboard_key: baseSpec.dashboard_key, ttl_seconds: 300 },
    undefined, () => true, { ...owner, turnGeneration: "turn-3" });
  assert.equal(reopened.ok, true);
  assert.equal(manager.snapshot().dashboardState, "loading");
});

test("phone rejects non-MCP callers before displaying a contextual dashboard", async () => {
  const { manager, deliveries } = setup();
  const denied = await manager.begin({
    operation_id: "direct-denied", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, ttl_seconds: 300,
  }, undefined, () => true, { caller: "direct", turnGeneration: "turn-direct" });
  assert.equal(denied.ok, false);
  assert.equal(deliveries.length, 0);
});

test("phone rejects a non-even-g2 MCP profile and pin reads require the exact profile turn", async () => {
  const { manager, deliveries } = setup();
  const args = { operation_id: "profile-denied", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, ttl_seconds: 300 };
  assert.equal((await manager.begin(args, undefined, () => true, { ...owner, profileId: "default" })).ok, false);
  assert.equal(manager.listPins({ ...owner, profileId: "default" }).ok, false);
  assert.equal(deliveries.length, 0);
});

test("disconnect tombstones an in-flight delivery and stale turns cannot publish without starting refresh", async () => {
  let release;
  const deliveries = [];
  const manager = new ContextDashboardManager({
    isDisplayAvailable: () => true, createId: () => "contextdashboardpending001", clear: () => {},
    deliver: async (state) => { deliveries.push(state); await new Promise((resolve) => { release = resolve; }); return { status: "acknowledged", frameId: 1 }; },
    loadPins: () => [], savePins: () => {}, setTimer: () => 1, clearTimer: () => {},
  });
  const opening = manager.begin({ operation_id: "pending", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, ttl_seconds: 300 },
  undefined, () => true, owner);
  await new Promise((resolve) => setTimeout(resolve, 0));
  manager.closeConnection({ ...owner, turnGeneration: null });
  release();
  assert.equal((await opening).ok, false);
  assert.equal(manager.snapshot(), null);

  const { manager: live } = setup();
  const begun = JSON.parse((await live.begin({ operation_id: "live", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, ttl_seconds: 300 },
  undefined, () => true, owner)).content);
  const stale = await live.publish({ operation_id: "stale-publish", dashboard_id: begun.dashboard_id, presentation_generation: 1,
    refresh_generation: 1, expected_revision: 1, spec: baseSpec }, undefined, () => true, { ...owner, turnGeneration: "turn-2" });
  assert.equal(stale.ok, false);
});

test("validator rejects inherited specs and manager rejects non-positive delivery receipts", async () => {
  assert.ok(validateContextDashboardSpec(Object.create(baseSpec)));
  const manager = new ContextDashboardManager({ isDisplayAvailable: () => true, createId: () => "contextdashboardreceipt01",
    deliver: async () => ({ status: "acknowledged", frameId: -1 }), clear: () => {}, loadPins: () => [], savePins: () => {} });
  const denied = await manager.begin({ operation_id: "receipt", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, ttl_seconds: 300 },
  undefined, () => true, owner);
  assert.equal(denied.ok, false);
});

test("ring scroll advances through departure rows before reaching fixed local actions", async () => {
  const { manager } = setup();
  const begun = JSON.parse((await manager.begin({ operation_id: "scroll", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, ttl_seconds: 300 },
  undefined, () => true, owner)).content);
  const many = { ...baseSpec, sections: [{ ...baseSpec.sections[0], rows: Array.from({ length: 10 }, (_, index) => ({
    ...baseSpec.sections[0].rows[0], id: `service-${index}`, destination: `Destination ${index}`, scheduled_departure_ms: 1_800_000 + index * 60_000,
    expected_departure_ms: 1_800_000 + index * 60_000,
  })) }] };
  await manager.publish({ operation_id: "scroll-publish", dashboard_id: begun.dashboard_id, presentation_generation: 1,
    refresh_generation: 1, expected_revision: 1, spec: many }, undefined, () => true, owner);
  manager.handleInput("scroll-down", true);
  manager.handleInput("scroll-down", true);
  assert.equal(manager.snapshot().scrollOffset, 2);
});
