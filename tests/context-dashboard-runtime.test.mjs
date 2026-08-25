import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { ContextDashboardRuntime } from "../hermes-host/context-dashboard-runtime.mjs";

const managerLayoutSource = readFileSync(new URL("../app/assistant/dynamic-app-layout.ts", import.meta.url), "utf8")
  .replace(/^import type .*;\n/gm, "");
const managerSource = readFileSync(new URL("../app/assistant/context-dashboard.ts", import.meta.url), "utf8")
  .replace('import type { ToolExecutionContext, ToolResult } from "./tool-registry";', "")
  .replace(/import \{\n  DYNAMIC_APP_DECK_COMPONENT_BUDGET,\n  DYNAMIC_APP_SMALL_LINE_HEIGHT,\n  dynamicAppComponentHeight,\n\} from "\.\/dynamic-app-layout";\n/, "");
const managerJs = ts.transpileModule(`${managerLayoutSource}\n${managerSource}`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { ContextDashboardManager } = await import(
  "data:text/javascript;base64," + Buffer.from(managerJs).toString("base64")
);

const identity = { profile: "even-g2", device: "phone-1", connectionGeneration: "socket-1", turnGeneration: "turn-1" };

function projectCurrentAnswer(input) {
  if (!input || !Array.isArray(input.items) || input.items.length === 0) throw new Error("a bounded current-turn answer is required");
  return {
    version: 2,
    presentation_mode: "deck",
    dashboard_key: "context-tomorrow-plan",
    title: "Tomorrow plan",
    state: "ready",
    privacy: "private",
    summary: { primary: "Three steps for tomorrow", uncertainty: "estimated" },
    sections: [{
      id: "steps", order: 0, type: "list", title: "Plan", load_state: "ready",
      source_ids: ["assistant"], uncertainty: "estimated", items: input.items,
    }],
    sources: [{ id: "assistant", label: "Hermes reasoning", stale_after_seconds: 86400, status: "unknown" }],
    local_actions: [],
    ttl_seconds: 300,
  };
}

function exactPhone(manager, turnGeneration) {
  const context = { caller: "mcp", profileId: "even-g2", connectionGeneration: "socket-1", turnGeneration };
  return { callTool: async (name, args, options = {}) => {
    const allowed = () => !options.signal?.aborted;
    let response;
    if (name === "glasses.context_dashboard.begin") response = await manager.begin(args, options.signal, allowed, context);
    else if (name === "glasses.context_dashboard.publish") response = await manager.publish(args, options.signal, allowed, context);
    else if (name === "glasses.context_dashboard.open_pin") response = await manager.openPin(args, options.signal, allowed, context);
    else throw new Error(`unexpected ${name}`);
    if (!response.ok) throw new Error(response.error);
    return JSON.parse(response.content);
  } };
}

function focusPhonePin(manager) {
  if (manager.snapshot().presentationMode === "deck") {
    assert.equal(manager.snapshot().pageId, "cover");
    assert.equal(manager.snapshot().deckActionLabel, "Pin");
    return;
  }
  const target = manager.snapshot().components.findIndex((component) => component.id === "phone:pin");
  assert.ok(target >= 0, "phone-owned Pin control is required");
  while (manager.snapshot().scrollOffset < target) manager.handleInput("scroll-down", true);
}

test("runtime presents a current-turn answer without a domain app, adapter, or API", async () => {
  const calls = [];
  let release;
  const gather = new Promise((resolve) => { release = resolve; });
  const phone = { callTool: async (name, args) => {
    calls.push({ name, args });
    if (name.endsWith("begin")) return { status: "reserved", dashboard_id: "dashboard_abcdefghijkl", presentation_generation: 1, refresh_generation: 1, revision: 1 };
    if (name.endsWith("publish")) return { status: "acknowledged", dashboard_id: args.dashboard_id, presentation_generation: 1, refresh_generation: 1, revision: 2, frame_id: 11 };
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, now: () => 1_000_000 });
  const opening = runtime.open(identity, {
    operationId: "plan-open", dashboardKey: "context-tomorrow-plan", title: "Tomorrow plan", privacy: "private",
    intent: "Show me a three-step plan for tomorrow", refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent",
    gather: async () => gather,
    project: projectCurrentAnswer,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "glasses.context_dashboard.begin");
  release({ items: ["Choose the priority", "Prepare the inputs", "Set the start time"] });
  const receipt = await opening;
  assert.equal(calls[1].name, "glasses.context_dashboard.publish");
  assert.equal(calls[1].args.refresh_generation, 1);
  assert.equal(receipt.revision, 2);
});

test("generic host output passes the real phone validator and intent-only pin reopen regenerates from scratch", async () => {
  let savedPins = [];
  let frame = 0;
  const firstManager = new ContextDashboardManager({
    isDisplayAvailable: () => true, createId: () => "endtoenddashboard001",
    deliver: async () => ({ status: "acknowledged", frameId: ++frame }), clear: () => {},
    loadPins: () => [], savePins: (pins) => { savedPins = structuredClone(pins); },
    now: () => 1_000_000, setTimer: () => 1, clearTimer: () => {},
  });
  const runtime = new ContextDashboardRuntime({ phone: exactPhone(firstManager, "turn-1"), now: () => 1_000_000 });
  const intent = "Show me a three-step plan for tomorrow";
  const opened = await runtime.open(identity, {
    operationId: "generic-e2e", dashboardKey: "context-tomorrow-plan", title: "Tomorrow plan", privacy: "private",
    intent, refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent",
    gather: async () => ({ items: ["Choose the priority", "Prepare the inputs", "Set the start time"] }),
    project: projectCurrentAnswer,
  });
  assert.equal(opened.revision, 2);
  assert.equal(firstManager.snapshot().presentationMode, "deck");
  assert.equal(firstManager.snapshot().pageCount, 2);
  assert.equal(firstManager.snapshot().components[0].text, "Three steps for tomorrow · Est.");
  focusPhonePin(firstManager);
  assert.equal(firstManager.handleInput("click", true), true);
  assert.equal(savedPins.length, 1);

  const secondManager = new ContextDashboardManager({
    isDisplayAvailable: () => true, createId: () => "reopenedendtoend001",
    deliver: async () => ({ status: "acknowledged", frameId: ++frame }), clear: () => {},
    loadPins: () => structuredClone(savedPins), savePins: () => {},
    now: () => 1_100_000, setTimer: () => 1, clearTimer: () => {},
  });
  const pin = JSON.parse(secondManager.listPins({ caller: "mcp", profileId: "even-g2",
    connectionGeneration: "socket-1", turnGeneration: "turn-2" }).content).pins[0];
  let selectedIntent;
  const reopened = await new ContextDashboardRuntime({ phone: exactPhone(secondManager, "turn-2"), now: () => 1_100_000 })
    .reopenPinned({ ...identity, turnGeneration: "turn-2" }, pin, {
      gather: async ({ intent: currentIntent }) => {
        selectedIntent = currentIntent;
        return { items: ["Pick one goal", "Block the time", "Start with five minutes"] };
      },
      project: projectCurrentAnswer,
    });
  assert.equal(selectedIntent, intent);
  assert.equal(reopened.revision, 2);
  assert.equal(secondManager.snapshot().pageId, "cover");
  assert.equal(secondManager.handleInput("scroll-down", true), true);
  assert.equal(secondManager.snapshot().components.some((component) => component.text === "Pick one goal"), true);
});

test("runtime is dedicated-profile and read-only fail closed", async () => {
  const runtime = new ContextDashboardRuntime({ phone: { callTool: async () => { throw new Error("must not call"); } } });
  await assert.rejects(() => runtime.open({ ...identity, profile: "default" }, {
    operationId: "x", dashboardKey: "x", title: "X", privacy: "private", intent: "X",
    refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", gather: async () => ({}), project: () => ({}),
  }), /even-g2/);
});

test("a local refresh event starts a new generation and reruns only the saved read-only intent", async () => {
  const calls = [];
  const phone = { callTool: async (name, args) => {
    calls.push({ name, args });
    if (name.endsWith("start_refresh")) return { status: "acknowledged", dashboard_id: args.dashboard_id,
      presentation_generation: args.presentation_generation, refresh_generation: 2, revision: args.expected_revision + 1, frame_id: 20 };
    if (name.endsWith("publish")) return { status: "acknowledged", dashboard_id: args.dashboard_id,
      presentation_generation: args.presentation_generation, refresh_generation: args.refresh_generation, revision: args.expected_revision + 1, frame_id: 21 };
    if (name.endsWith("ack_events")) return { status: "acknowledged", through_event_id: args.through_event_id };
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, now: () => 1_000_000 });
  const receipt = await runtime.refreshFromLocalEvent(identity, {
    version: 2, event_id: "dashboard.1.1", dashboard_id: "dashboard_abcdefghijkl", presentation_generation: 1,
    revision: 2, kind: "refresh", intent: "Show me a three-step plan for tomorrow",
    dashboard_key: "context-tomorrow-plan", title: "Tomorrow plan", privacy: "private",
  }, {
    operationId: "local-refresh", gather: async () => ({ items: ["Choose the priority", "Prepare the inputs", "Set the start time"] }),
    project: projectCurrentAnswer,
  });
  assert.deepEqual(calls.map((call) => call.name), ["glasses.context_dashboard.start_refresh", "glasses.context_dashboard.publish", "glasses.context_dashboard.ack_events"]);
  assert.equal(calls[1].args.refresh_generation, 2);
  assert.equal(receipt.revision, 4);
});

test("pre-aborted opens do not touch the phone and refresh deadlines abort gathering then publish an honest terminal state", async () => {
  const calls = [];
  const phone = { callTool: async (name, args) => {
    calls.push({ name, args });
    if (name.endsWith("start_refresh")) return { status: "acknowledged", dashboard_id: args.dashboard_id,
      presentation_generation: 1, refresh_generation: 2, revision: 3, frame_id: 30 };
    if (name.endsWith("publish")) return { status: "acknowledged", dashboard_id: args.dashboard_id,
      presentation_generation: 1, refresh_generation: 2, revision: 4, frame_id: 31 };
    if (name.endsWith("ack_events")) return { status: "acknowledged" };
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, usefulDeadlineMs: 10, now: () => 0 });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => runtime.open(identity, { operationId: "aborted", dashboardKey: "x", title: "X", privacy: "private", intent: "X",
    refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", signal: aborted.signal, gather: async () => ({}), project: () => ({}) }), /cancelled/);
  assert.equal(calls.length, 0);
  let gatherAborted = false;
  await runtime.refreshFromLocalEvent(identity, { version: 2, event_id: "dashboard.1.2", dashboard_id: "dashboard_abcdefghijkl",
    presentation_generation: 1, revision: 2, kind: "refresh", intent: "Train departures", dashboard_key: "rail-liverpool-lime-street",
    title: "Liverpool Lime Street", privacy: "private" }, { operationId: "deadline", gather: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { gatherAborted = true; resolve({}); }, { once: true });
    }), project: () => ({}) });
  assert.equal(gatherAborted, true);
  assert.equal(calls[1].args.spec.state, "error");
});

test("reopening the same pin twice uses fresh operation identities for both offscreen reservation and useful publication", async () => {
  const calls = [];
  const publishSignals = [];
  const gatheredIntents = [];
  let dashboard = 0;
  const phone = { callTool: async (name, args, options) => {
    calls.push({ name, args });
    if (name.endsWith("open_pin")) return { status: "reserved", dashboard_id: `pinneddashboard${++dashboard}xx`,
      presentation_generation: 1, refresh_generation: 1, revision: 1,
      intent: "When is the next train at Liverpool Lime Street?" };
    if (name.endsWith("publish")) {
      publishSignals.push(options.signal);
      return { status: "acknowledged", dashboard_id: args.dashboard_id,
        presentation_generation: 1, refresh_generation: 1, revision: 2, frame_id: dashboard + 10 };
    }
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, now: () => 1_000_000 });
  const pin = { dashboard_key: "rail-liverpool-lime-street", title: "Liverpool Lime Street", privacy: "private",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 } };
  const options = { gather: async ({ intent }) => { gatheredIntents.push(intent); return {}; }, project: () => ({ local_actions: [] }) };
  await runtime.reopenPinned(identity, pin, options);
  await runtime.reopenPinned(identity, pin, options);
  const opens = calls.filter((call) => call.name.endsWith("open_pin"));
  const publishes = calls.filter((call) => call.name.endsWith("publish"));
  assert.equal(opens.length, 2);
  assert.equal(publishes.length, 2);
  assert.notEqual(opens[0].args.operation_id, opens[1].args.operation_id);
  assert.equal(publishes[0].args.operation_id, `${opens[0].args.operation_id}.useful`);
  assert.equal(publishes[1].args.operation_id, `${opens[1].args.operation_id}.useful`);
  assert.deepEqual(gatheredIntents, ["When is the next train at Liverpool Lime Street?", "When is the next train at Liverpool Lime Street?"]);
  assert.equal(publishSignals.every((signal) => !signal.aborted), true, "a completed publish controller must not be aborted by replacement");
});

test("a replacement aborts pinned regathering before the stale presentation can publish", async () => {
  const calls = [];
  let dashboard = 0;
  const phone = { callTool: async (name, args) => {
    calls.push({ name, args });
    if (name.endsWith("open_pin")) return { status: "reserved", dashboard_id: `replacementpin${++dashboard}xxx`,
      presentation_generation: 1, refresh_generation: 1, revision: 1,
      intent: "When is the next train at Liverpool Lime Street?" };
    if (name.endsWith("publish")) return { status: "acknowledged", dashboard_id: args.dashboard_id,
      presentation_generation: 1, refresh_generation: 1, revision: 2, frame_id: 20 };
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, now: () => 1_000_000 });
  const pin = { dashboard_key: "rail-liverpool-lime-street", title: "Liverpool Lime Street", privacy: "private",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 } };
  let firstGatherAborted = false;
  const first = runtime.reopenPinned(identity, pin, { gather: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { firstGatherAborted = true; reject(new Error("aborted")); }, { once: true });
  }), project: () => ({}) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = runtime.reopenPinned(identity, pin, { gather: async () => ({}), project: () => ({}) });
  await assert.rejects(first, /stale pinned dashboard reopen/);
  await second;
  assert.equal(firstGatherAborted, true);
  assert.equal(calls.filter((call) => call.name.endsWith("open_pin")).length, 2);
  assert.equal(calls.filter((call) => call.name.endsWith("publish")).length, 1);
});

test("a replacement aborts stalled open_pin ownership and exactly closes a late reserved identity", async () => {
  const calls = [];
  let releasePinned;
  let pinnedSignal;
  const staleId = "staleopenpindashboard01";
  const phone = { callTool: async (name, args, options) => {
    calls.push({ name, args });
    if (name.endsWith("open_pin")) {
      pinnedSignal = options.signal;
      return new Promise((resolve) => { releasePinned = () => resolve({ status: "acknowledged", dashboard_id: staleId,
        presentation_generation: 3, refresh_generation: 1, revision: 1, frame_id: 41,
        intent: "When is the next train at Liverpool Lime Street?" }); });
    }
    if (name.endsWith("begin")) return { status: "reserved", dashboard_id: "replacementdashboard001",
      presentation_generation: 1, refresh_generation: 1, revision: 1 };
    if (name.endsWith("publish")) return { status: "acknowledged", dashboard_id: args.dashboard_id,
      presentation_generation: args.presentation_generation, refresh_generation: args.refresh_generation,
      revision: args.expected_revision + 1, frame_id: 43 };
    if (name.endsWith("close")) return { status: "closed", dashboard_id: args.dashboard_id,
      presentation_generation: args.presentation_generation, revision: args.expected_revision };
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, now: () => 1_000_000 });
  const pin = { dashboard_key: "rail-liverpool-lime-street", title: "Liverpool Lime Street", privacy: "private",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 } };
  const first = runtime.reopenPinned(identity, pin, { gather: async () => ({}), project: () => ({}) });
  const stale = assert.rejects(first, /stale pinned dashboard reopen/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacement = runtime.open(identity, { operationId: "replacement-open", dashboardKey: "replacement",
    title: "Replacement", privacy: "private", intent: "Show replacement",
    refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", gather: async () => ({}), project: () => ({}) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pinnedSignal.aborted, true);
  releasePinned();
  await stale;
  await replacement;
  const cleanup = calls.find((call) => call.name.endsWith("close"));
  assert.deepEqual({ dashboard_id: cleanup.args.dashboard_id, presentation_generation: cleanup.args.presentation_generation,
    expected_revision: cleanup.args.expected_revision }, { dashboard_id: staleId, presentation_generation: 3, expected_revision: 1 });
  assert.match(cleanup.args.operation_id, /^close-[A-Za-z0-9_-]{16,58}$/);
});

test("a replacement aborts stalled start_refresh ownership and exactly closes its late acknowledged revision", async () => {
  const calls = [];
  let releaseRefresh;
  let refreshSignal;
  let staleGatherCalled = false;
  const staleId = "stale_refresh_dashboard01";
  const phone = { callTool: async (name, args, options) => {
    calls.push({ name, args });
    if (name.endsWith("start_refresh")) {
      refreshSignal = options.signal;
      return new Promise((resolve) => { releaseRefresh = () => resolve({ status: "acknowledged", dashboard_id: staleId,
        presentation_generation: 2, refresh_generation: 4, revision: 8, frame_id: 51 }); });
    }
    if (name.endsWith("begin")) return { status: "reserved", dashboard_id: "refreshreplacement001",
      presentation_generation: 1, refresh_generation: 1, revision: 1 };
    if (name.endsWith("publish")) return { status: "acknowledged", dashboard_id: args.dashboard_id,
      presentation_generation: args.presentation_generation, refresh_generation: args.refresh_generation,
      revision: args.expected_revision + 1, frame_id: 53 };
    if (name.endsWith("close")) return { status: "closed", dashboard_id: args.dashboard_id,
      presentation_generation: args.presentation_generation, revision: args.expected_revision };
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, now: () => 1_000_000 });
  const event = { version: 2, event_id: "stalled.refresh.event", dashboard_id: staleId, presentation_generation: 2,
    revision: 7, kind: "refresh", intent: "Refresh current context", dashboard_key: "stalled-refresh",
    title: "Stalled refresh", privacy: "private" };
  const first = runtime.refreshFromLocalEvent(identity, event, { operationId: "stalled-refresh",
    gather: async () => { staleGatherCalled = true; return {}; }, project: () => ({}) });
  const stale = assert.rejects(first, /stale local dashboard refresh/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacement = runtime.open(identity, { operationId: "refresh-replacement", dashboardKey: "replacement",
    title: "Replacement", privacy: "private", intent: "Show replacement",
    refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", gather: async () => ({}), project: () => ({}) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(refreshSignal.aborted, true);
  releaseRefresh();
  await stale;
  await replacement;
  assert.equal(staleGatherCalled, false);
  assert.equal(calls.some((call) => call.name.endsWith("ack_events")), false);
  const cleanup = calls.find((call) => call.name.endsWith("close"));
  assert.deepEqual({ dashboard_id: cleanup.args.dashboard_id, presentation_generation: cleanup.args.presentation_generation,
    expected_revision: cleanup.args.expected_revision }, { dashboard_id: staleId, presentation_generation: 2, expected_revision: 8 });
  assert.match(cleanup.args.operation_id, /^close-[A-Za-z0-9_-]{16,58}$/);
});

test("a failed replacement still closes the pinned reservation after cancelling gather, with bounded non-masking cleanup", async () => {
  const calls = [];
  const pinnedId = "pinnedgathercleanup01";
  let gatherAborted = false;
  let cleanupSignal;
  const phone = { callTool: async (name, args, options) => {
    calls.push({ name, args });
    if (name.endsWith("open_pin")) return { status: "reserved", dashboard_id: pinnedId,
      presentation_generation: 4, refresh_generation: 1, revision: 1,
      intent: "When is the next train at Liverpool Lime Street?" };
    if (name.endsWith("begin")) throw new Error("replacement begin failed");
    if (name.endsWith("close")) {
      cleanupSignal = options.signal;
      return new Promise(() => {});
    }
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, loadingDeadlineMs: 10, now: () => 1_000_000 });
  const pin = { dashboard_key: "rail-liverpool-lime-street", title: "Liverpool Lime Street", privacy: "private",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 } };
  const first = runtime.reopenPinned(identity, pin, { gather: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => { gatherAborted = true; reject(new Error("gather aborted")); }, { once: true });
  }), project: () => ({}) });
  const stale = assert.rejects(first, /stale pinned dashboard reopen/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replacement = runtime.open(identity, { operationId: "failed-replacement", dashboardKey: "replacement",
    title: "Replacement", privacy: "private", intent: "Show replacement",
    refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", gather: async () => ({}), project: () => ({}) });
  await assert.rejects(replacement, /replacement begin failed/);
  await stale;
  assert.equal(gatherAborted, true);
  assert.equal(cleanupSignal.aborted, true, "a close implementation that ignores cancellation must not stall stale ownership cleanup");
  const cleanup = calls.find((call) => call.name.endsWith("close"));
  assert.deepEqual({ dashboard_id: cleanup.args.dashboard_id, presentation_generation: cleanup.args.presentation_generation,
    expected_revision: cleanup.args.expected_revision }, { dashboard_id: pinnedId, presentation_generation: 4, expected_revision: 1 });
});

test("a failed replacement closes the exact late useful revision after cancelling pinned publication", async () => {
  const calls = [];
  const pinnedId = "pinnedpublishcleanup1";
  let publishSignal;
  let releasePublish;
  const phone = { callTool: async (name, args, options) => {
    calls.push({ name, args });
    if (name.endsWith("open_pin")) return { status: "reserved", dashboard_id: pinnedId,
      presentation_generation: 5, refresh_generation: 1, revision: 1,
      intent: "When is the next train at Liverpool Lime Street?" };
    if (name.endsWith("publish")) {
      publishSignal = options.signal;
      return new Promise((resolve) => { releasePublish = () => resolve({ status: "acknowledged", dashboard_id: pinnedId,
        presentation_generation: 5, refresh_generation: 1, revision: 2, frame_id: 72 }); });
    }
    if (name.endsWith("begin")) throw new Error("replacement begin failed");
    if (name.endsWith("close")) return { status: "closed", dashboard_id: args.dashboard_id,
      presentation_generation: args.presentation_generation, revision: args.expected_revision };
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, now: () => 1_000_000 });
  const pin = { dashboard_key: "rail-liverpool-lime-street", title: "Liverpool Lime Street", privacy: "private",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 } };
  const first = runtime.reopenPinned(identity, pin, { gather: async () => ({}), project: () => ({}) });
  const stale = assert.rejects(first, /contextual dashboard publication was cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof releasePublish, "function");
  const replacement = runtime.open(identity, { operationId: "failed-publish-replacement", dashboardKey: "replacement",
    title: "Replacement", privacy: "private", intent: "Show replacement",
    refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", gather: async () => ({}), project: () => ({}) });
  await assert.rejects(replacement, /replacement begin failed/);
  assert.equal(publishSignal.aborted, true);
  releasePublish();
  await stale;
  const cleanup = calls.find((call) => call.name.endsWith("close"));
  assert.deepEqual({ dashboard_id: cleanup.args.dashboard_id, presentation_generation: cleanup.args.presentation_generation,
    expected_revision: cleanup.args.expected_revision }, { dashboard_id: pinnedId, presentation_generation: 5, expected_revision: 2 });
});

test("an aborted lost publish reply closes the predicted committed successor without touching a later revision", async () => {
  const calls = [];
  const dashboardId = "ambiguousdashboard001";
  const closeRevisions = [];
  let phoneRevision = 1;
  let markPublishStarted;
  const publishStarted = new Promise((resolve) => { markPublishStarted = resolve; });
  const phone = { callTool: async (name, args, options) => {
    calls.push({ name, args });
    if (name.endsWith("begin")) return { status: "reserved", dashboard_id: dashboardId,
      presentation_generation: 1, refresh_generation: 1, revision: 1 };
    if (name.endsWith("publish")) {
      markPublishStarted();
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          // The phone committed revision 2, but transport lost its receipt.
          phoneRevision = 2;
          reject(new Error("publish reply was lost after commit"));
        }, { once: true });
      });
    }
    if (name.endsWith("close")) {
      closeRevisions.push(args.expected_revision);
      if (args.expected_revision === phoneRevision) {
        phoneRevision = null;
        return { status: "closed", dashboard_id: args.dashboard_id,
          presentation_generation: args.presentation_generation, revision: args.expected_revision };
      }
      return { status: "historical_acknowledgement", dashboard_id: args.dashboard_id,
        presentation_generation: args.presentation_generation, revision: args.expected_revision };
    }
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, now: () => 1_000_000 });
  const external = new AbortController();
  const opening = runtime.open(identity, { operationId: "ambiguous-publish", dashboardKey: "ambiguous",
    title: "Ambiguous", privacy: "private", intent: "Show ambiguous context", signal: external.signal,
    refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", gather: async () => ({}), project: () => ({}) });
  await publishStarted;
  external.abort();
  await assert.rejects(opening, /contextual dashboard publication was cancelled/);
  assert.deepEqual(closeRevisions, [2, 1], "cleanup must try the possibly committed successor before its known predecessor");
  assert.equal(phoneRevision, null);
  assert.equal(closeRevisions.some((revision) => revision > 2), false, "exact cleanup must never close an unknown N+2 revision");
});
