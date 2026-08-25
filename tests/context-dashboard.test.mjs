import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const layoutSource = readFileSync(new URL("../app/assistant/dynamic-app-layout.ts", import.meta.url), "utf8")
  .replace(/^import type .*;\n/gm, "");
const source = readFileSync(new URL("../app/assistant/context-dashboard.ts", import.meta.url), "utf8")
  .replace('import type { ToolExecutionContext, ToolResult } from "./tool-registry";', "")
  .replace(/import \{\n  DYNAMIC_APP_DECK_COMPONENT_BUDGET,\n  DYNAMIC_APP_SMALL_LINE_HEIGHT,\n  dynamicAppComponentHeight,\n\} from "\.\/dynamic-app-layout";\n/, "");
const js = ts.transpileModule(`${layoutSource}\n${source}`, {
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
  local_actions: [{ id: "refresh", kind: "refresh", label: "Refresh", enabled: true }],
  announcement: { id: "rail-first-useful", text: "Liverpool Lime Street: next is the 14:32 to Manchester Airport, expected on time.", policy: "once_when_useful" },
  ttl_seconds: 300,
};

const genericSpec = {
  version: 2,
  dashboard_key: "context-tomorrow-plan",
  title: "Tomorrow plan",
  state: "ready",
  privacy: "private",
  summary: { primary: "Three steps for tomorrow", uncertainty: "estimated" },
  sections: [{
    id: "steps", order: 0, type: "list", title: "Plan", load_state: "ready",
    source_ids: ["assistant"], uncertainty: "estimated",
    items: ["Choose the first important task", "Prepare what it needs", "Set a realistic start time"],
  }],
  sources: [{ id: "assistant", label: "Hermes reasoning", stale_after_seconds: 86400, status: "unknown" }],
  local_actions: [],
  ttl_seconds: 300,
};

const weatherSpec = {
  ...genericSpec,
  presentation_mode: "deck",
  dashboard_key: "weather-liverpool",
  title: "Liverpool weather",
  summary: { primary: "Tomorrow: light rain, 12–18°C", uncertainty: "estimated" },
  sections: [{
    id: "forecast", order: 0, type: "status_grid", title: "Tomorrow", load_state: "ready",
    source_ids: ["open-meteo-ukmo"], uncertainty: "estimated", rows: [
      { id: "condition", label: "Conditions", value: "Light rain" },
      { id: "rain", label: "Rain chance", value: "65%" },
    ],
  }],
  sources: [{
    id: "open-meteo-ukmo", label: "Open-Meteo · UK Met Office data", attribution_id: "open_meteo_ukmo",
    observed_at_ms: 1_000_000, stale_after_seconds: 900, status: "current",
  }],
  local_actions: [],
};

const deckSpec = {
  ...baseSpec,
  presentation_mode: "deck",
  local_actions: [],
  announcement: undefined,
  sections: [{
    ...baseSpec.sections[0],
    rows: Array.from({ length: 12 }, (_, index) => ({
      ...baseSpec.sections[0].rows[0],
      id: `deck-service-${index}`,
      destination: `Destination ${index}`,
      scheduled_departure_ms: 1_800_000 + index * 60_000,
      expected_departure_ms: 1_800_000 + index * 60_000,
    })),
  }],
};

const barChartSpec = {
  ...genericSpec,
  presentation_mode: "deck",
  title: "Weekly focus",
  summary: { primary: "Focus was strongest on Thursday", uncertainty: "estimated" },
  sections: [{
    id: "focus", order: 0, type: "bar_chart", title: "Focus by day", load_state: "ready",
    source_ids: ["assistant"], uncertainty: "estimated", bars: [
      { id: "mon", label: "Monday", value: 2, max: 5, unit: "h" },
      { id: "tue", label: "Tuesday", value: 3.25, max: 5, unit: "h" },
      { id: "wed", label: "Wednesday", value: 3.5, max: 5, unit: "h" },
      { id: "thu", label: "Thursday", value: 4.75, max: 5, unit: "h" },
      { id: "fri", label: "Friday", value: 3, max: 5, unit: "h" },
    ],
  }],
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

function focusComponent(manager, componentId) {
  const target = manager.snapshot().components.findIndex((component) => component.id === componentId);
  assert.ok(target >= 0, `missing component ${componentId}`);
  while (manager.snapshot().scrollOffset < target) manager.handleInput("scroll-down", true);
  while (manager.snapshot().scrollOffset > target) manager.handleInput("scroll-up", true);
}

test("departure rendering falls back safely when the Android runtime has no Intl", async () => {
  const saved = globalThis.Intl;
  try {
    globalThis.Intl = undefined;
    const { manager, deliveries } = setup();
    const begun = JSON.parse((await manager.begin({
      operation_id: "begin-no-intl", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title,
      privacy: "private", intent: "Train departures",
      refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
    }, undefined, () => true, owner)).content);
    const published = await manager.publish({
      operation_id: "publish-no-intl", dashboard_id: begun.dashboard_id,
      presentation_generation: begun.presentation_generation, refresh_generation: begun.refresh_generation,
      expected_revision: begun.revision, spec: baseSpec,
    }, undefined, () => true, owner);
    assert.equal(published.ok, true);
    assert.match(deliveries.at(-1).components.find((component) => component.id === "section:departures:row:service-1").value, /^\d{2}:\d{2}/);
  } finally {
    globalThis.Intl = saved;
  }
});

test("offscreen reservation does not depend on the missing NativeScript structuredClone API", async () => {
  const saved = globalThis.structuredClone;
  try {
    globalThis.structuredClone = undefined;
    let deliveredState;
    const manager = new ContextDashboardManager({
      isDisplayAvailable: () => true,
      deliver: async (state) => { deliveredState = JSON.parse(JSON.stringify(state)); return { status: "acknowledged", frameId: 1 }; },
      clear: () => {},
      createId: () => "contextdashboardnoclone01",
      loadPins: () => [],
      savePins: () => {},
      now: () => 1_000_000,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    const begun = await manager.begin({
      operation_id: "begin-no-clone", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title,
      privacy: "private", intent: "Train departures",
      refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
    }, undefined, () => true, owner);
    assert.equal(begun.ok, true);
    const receipt = JSON.parse(begun.content);
    assert.equal(receipt.status, "reserved");
    assert.equal(deliveredState, undefined);
    assert.equal(manager.snapshot(), null);
    const published = await manager.publish({ operation_id: "publish-no-clone", dashboard_id: receipt.dashboard_id,
      presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: baseSpec }, undefined, () => true, owner);
    assert.equal(published.ok, true);
    assert.equal(deliveredState.state, "ready");
  } finally {
    globalThis.structuredClone = saved;
  }
});

test("V2 contextual dashboard schema is read-only, bounded, and provenance-explicit", () => {
  assert.equal(validateContextDashboardSpec(baseSpec), null);
  assert.equal(CONTEXT_DASHBOARD_CAPABILITIES.protocolVersion, 2);
  assert.deepEqual(CONTEXT_DASHBOARD_CAPABILITIES.display,
    { width: 640, height: 480, contentWidth: 536, contentHeight: 232, grayscaleBits: 4 });
  assert.equal(CONTEXT_DASHBOARD_CAPABILITIES.presentationLifetime, "temporary");
  assert.deepEqual(CONTEXT_DASHBOARD_CAPABILITIES.presentationModes, ["single", "deck"]);
  assert.equal(CONTEXT_DASHBOARD_CAPABILITIES.interactionPriority, "visual-first");
  assert.equal(CONTEXT_DASHBOARD_CAPABILITIES.newAnswerPresentation, "atomic-final-only");
  assert.equal(CONTEXT_DASHBOARD_CAPABILITIES.deckNavigation, "ring-scroll-pages");
  assert.equal(CONTEXT_DASHBOARD_CAPABILITIES.maxDeckPages, 7);
  assert.deepEqual(CONTEXT_DASHBOARD_CAPABILITIES.preferredVisualSections, ["bar_chart", "status_grid", "departures"]);
  assert.equal(CONTEXT_DASHBOARD_CAPABILITIES.pinSemantics, "encrypted-intent-bookmark");
  assert.deepEqual(CONTEXT_DASHBOARD_CAPABILITIES.pinStates,
    ["available", "saved", "not_pinnable", "limit", "save_failed", "unpin_failed"]);
  assert.deepEqual(CONTEXT_DASHBOARD_CAPABILITIES.localActions, ["refresh", "pin", "unpin", "section", "follow_up"]);
  assert.deepEqual(CONTEXT_DASHBOARD_CAPABILITIES.providerLocalActions, ["refresh", "section", "follow_up"]);
  assert.deepEqual(CONTEXT_DASHBOARD_CAPABILITIES.phoneLocalActions, ["pin", "unpin"]);
  assert.deepEqual(CONTEXT_DASHBOARD_CAPABILITIES.trustedSourceAttributions, ["open_meteo_ukmo"]);
  for (const bad of [
    { ...baseSpec, script: "run()" },
    { ...baseSpec, local_actions: [{ id: "x", kind: "toggle", label: "Toggle", enabled: true }] },
    { ...baseSpec, sources: [] },
    { ...baseSpec, sections: [{ ...baseSpec.sections[0], source_ids: ["missing"] }] },
    { ...baseSpec, summary: { ...baseSpec.summary, primary: "https://secret.example" } },
    { ...baseSpec, sections: Array.from({ length: 5 }, (_, order) => ({ id: `s${order}`, order, type: "message", load_state: "ready", source_ids: ["rail"], uncertainty: "exact", body: "x" })) },
    { ...baseSpec, sections: [{ ...baseSpec.sections[0], rows: [baseSpec.sections[0].rows[0], { ...baseSpec.sections[0].rows[0] }] }] },
    { ...baseSpec, presentation_mode: "carousel" },
    { ...deckSpec, local_actions: [{ id: "refresh", kind: "refresh", label: "Refresh", enabled: true }] },
    { ...deckSpec, sections: [{ ...deckSpec.sections[0], source_ids: [] }] },
    { ...weatherSpec, sources: [{ ...weatherSpec.sources[0], attribution_id: "caller_supplied" }] },
    { ...weatherSpec, sources: [{ ...weatherSpec.sources[0], attribution_url: "https://open-meteo.com" }] },
    { ...weatherSpec, sources: [{ ...weatherSpec.sources[0], label: "Open-Meteo.com" }] },
  ]) assert.ok(validateContextDashboardSpec(bad), JSON.stringify(bad));
  assert.equal(validateContextDashboardSpec(deckSpec), null);
  assert.equal(validateContextDashboardSpec(barChartSpec), null);
  assert.equal(validateContextDashboardSpec(weatherSpec, 1_000_000), null);
  const firstBar = barChartSpec.sections[0].bars[0];
  for (const bars of [
    [],
    Array.from({ length: 6 }, (_, index) => ({ ...firstBar, id: `bar-${index}` })),
    [firstBar, { ...firstBar }],
    [{ ...firstBar, value: -1 }],
    [{ ...firstBar, value: 6 }],
    [{ ...firstBar, max: 0 }],
    [{ ...firstBar, value: Number.NaN }],
    [{ ...firstBar, value: Number.POSITIVE_INFINITY }],
    [{ ...firstBar, value: 1.2345 }],
    [{ ...firstBar, label: "https://example.com" }],
    [{ ...firstBar, style: "wide" }],
  ]) assert.ok(validateContextDashboardSpec({ ...barChartSpec, sections: [{ ...barChartSpec.sections[0], bars }] }));
  assert.ok(validateContextDashboardSpec({ ...baseSpec, sources: [{ ...baseSpec.sources[0], observed_at_ms: 1_300_001 }] }, 1_000_000),
    "a future source timestamp must not appear freshly observed");
});

test("trusted weather attribution is phone-owned and repeated on every deck page", async () => {
  const { manager } = setup();
  const presented = await manager.present({
    operation_id: "weather-attribution-final",
    intent: "Show tomorrow's Liverpool weather",
    refresh_policy: { mode: "manual", min_interval_seconds: 900 },
    regeneration: "self_contained_intent",
    spec: weatherSpec,
  }, undefined, () => true, owner);
  assert.equal(presented.ok, true);

  const expected = "Weather data by Open-Meteo.com · CC BY-SA 4.0 · UK Met Office: current · 0s ago";
  let snapshot = manager.snapshot();
  assert.equal(snapshot.pageId, "cover");
  assert.equal(snapshot.components.find((component) => component.id === "phone:provenance")?.text, expected);
  assert.equal(manager.handleInput("scroll-down", true), true);
  snapshot = manager.snapshot();
  assert.equal(snapshot.pageId, "section:forecast:page:0");
  assert.equal(snapshot.components.find((component) => component.id === "section:forecast:provenance:0")?.text, expected);
});

test("invalid nonempty persisted pin arrays are purged while a valid empty store is untouched", () => {
  const purges = [];
  const dependencies = {
    isDisplayAvailable: () => true,
    deliver: async () => ({ status: "acknowledged", frameId: 1 }),
    clear: () => {},
    savePins: (pins) => purges.push(structuredClone(pins)),
    setTimer: () => 1,
    clearTimer: () => {},
  };
  const invalid = new ContextDashboardManager({ ...dependencies, loadPins: () => [{
    dashboard_key: "hidden-query", title: "Hidden", privacy: "private", intent: "Hidden wearer query",
    refresh_policy: { mode: "manual", min_interval_seconds: 1 },
  }] });
  assert.deepEqual(JSON.parse(invalid.listPins(owner).content).pins, []);
  assert.deepEqual(purges, [[]]);

  new ContextDashboardManager({ ...dependencies, loadPins: () => [] });
  assert.deepEqual(purges, [[]]);
});

test("begin reserves offscreen before useful publish and a later exact turn may refresh the same presentation", async () => {
  const { manager, deliveries } = setup();
  const begun = await manager.begin({
    operation_id: "begin-1", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "on_visible", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
  }, undefined, () => true, owner);
  const beginReceipt = JSON.parse(begun.content);
  assert.equal(deliveries.length, 0);
  assert.equal(beginReceipt.status, "reserved");
  assert.equal(beginReceipt.revision, 1);

  const published = await manager.publish({
    operation_id: "publish-1", dashboard_id: beginReceipt.dashboard_id,
    presentation_generation: beginReceipt.presentation_generation, refresh_generation: 1,
    expected_revision: 1, spec: baseSpec,
  }, undefined, () => true, owner);
  assert.equal(JSON.parse(published.content).revision, 2);
  assert.equal(deliveries[0].state, "ready");

  const refreshed = await manager.startRefresh({ operation_id: "refresh-1", dashboard_id: beginReceipt.dashboard_id,
    presentation_generation: beginReceipt.presentation_generation, expected_revision: 2 },
  undefined, () => true, { ...owner, turnGeneration: "turn-2" });
  assert.equal(JSON.parse(refreshed.content).refresh_generation, 2);
  assert.equal(deliveries.at(-1).state, "loading");
});

test("atomic present installs exactly one terminal final card and rejects intermediate states before delivery", async () => {
  const { manager, deliveries } = setup();
  const args = {
    operation_id: "atomic-final-1",
    intent: "Show the next Liverpool departure",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 },
    regeneration: "self_contained_intent",
    spec: deckSpec,
  };
  const presented = await manager.present(args, undefined, () => true, owner);
  assert.equal(presented.ok, true);
  const receipt = JSON.parse(presented.content);
  assert.equal(receipt.status, "acknowledged");
  assert.equal(receipt.revision, 1);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].dashboardState, "ready");
  assert.equal(deliveries[0].answerPresentation, "atomic-final-only");
  assert.equal(manager.snapshot().revision, 1);
  assert.equal((await manager.present(args, undefined, () => true, owner)).ok, true);
  assert.equal(deliveries.length, 1, "an identical operation replay cannot emit a duplicate final frame");

  const blocked = setup();
  let sequence = 0;
  for (const spec of [
    { ...genericSpec, state: "loading", sections: [{ ...genericSpec.sections[0], load_state: "pending" }] },
    { ...genericSpec, state: "ready", sections: [{ ...genericSpec.sections[0], load_state: "pending" }] },
  ]) {
    const denied = await blocked.manager.present({ ...args, operation_id: `blocked-${++sequence}`, spec },
      undefined, () => true, owner);
    assert.equal(denied.ok, false);
  }
  assert.equal(blocked.deliveries.length, 0);
  assert.equal(blocked.manager.snapshot(), null);

  const failed = new ContextDashboardManager({
    isDisplayAvailable: () => true, createId: () => "atomicreceiptfailure01",
    deliver: async () => ({ status: "acknowledged", frameId: 0 }), clear: () => {},
    loadPins: () => [], savePins: () => {}, setTimer: () => 1, clearTimer: () => {},
  });
  assert.equal((await failed.present({ ...args, operation_id: "atomic-failed" }, undefined, () => true, owner)).ok, false);
  assert.equal(failed.snapshot(), null);
});

test("an ordinary model-known answer becomes a pinnable interface without an app, adapter, or API", async () => {
  let savedPins = [];
  const manager = new ContextDashboardManager({
    isDisplayAvailable: () => true,
    createId: () => "genericcontextview000001",
    deliver: async () => ({ status: "acknowledged", frameId: 1 }),
    clear: () => {}, loadPins: () => [], savePins: (pins) => { savedPins = JSON.parse(JSON.stringify(pins)); },
    now: () => 1_000_000, setTimer: () => 1, clearTimer: () => {},
  });
  const intent = "Give me a three-step plan for tomorrow";
  const begun = JSON.parse((await manager.begin({
    operation_id: "generic-begin", dashboard_key: genericSpec.dashboard_key, title: genericSpec.title,
    privacy: "private", intent, refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
  }, undefined, () => true, owner)).content);
  assert.equal(manager.snapshot(), null);
  const published = await manager.publish({
    operation_id: "generic-publish", dashboard_id: begun.dashboard_id,
    presentation_generation: begun.presentation_generation, refresh_generation: begun.refresh_generation,
    expected_revision: begun.revision, spec: genericSpec,
  }, undefined, () => true, owner);
  assert.equal(published.ok, true);
  assert.equal(manager.snapshot().components[1].id, "phone:provenance");
  assert.match(manager.snapshot().components[1].text, /^Hermes reasoning: unknown/);
  focusComponent(manager, "phone:pin");
  assert.equal(manager.handleInput("click", true), true);
  assert.equal(savedPins.length, 1);

  const restartedOwner = { ...owner, turnGeneration: "generic-reopen-turn" };
  const restarted = new ContextDashboardManager({
    isDisplayAvailable: () => true,
    createId: () => "genericcontextrestart01",
    deliver: async () => ({ status: "acknowledged", frameId: 2 }), clear: () => {},
    loadPins: () => JSON.parse(JSON.stringify(savedPins)), savePins: () => {},
    now: () => 1_100_000, setTimer: () => 1, clearTimer: () => {},
  });
  const listed = JSON.parse(restarted.listPins(restartedOwner).content).pins[0];
  assert.equal(Object.hasOwn(listed, "intent"), false);
  const reopened = JSON.parse((await restarted.openPin({
    operation_id: "generic-reopen", dashboard_key: genericSpec.dashboard_key, ttl_seconds: 300,
  }, undefined, () => true, restartedOwner)).content);
  assert.equal(reopened.intent, intent);
  const regenerated = { ...genericSpec, summary: { primary: "Freshly regenerated plan", uncertainty: "estimated" } };
  const republished = await restarted.publish({
    operation_id: "generic-republish", dashboard_id: reopened.dashboard_id,
    presentation_generation: reopened.presentation_generation, refresh_generation: reopened.refresh_generation,
    expected_revision: reopened.revision, spec: regenerated,
  }, undefined, () => true, restartedOwner);
  assert.equal(republished.ok, true);
  assert.equal(restarted.snapshot().components[0].text, "Freshly regenerated plan · Est.");
});

test("context-dependent answers stay temporary and cannot pin, refresh, or queue cross-turn actions", async () => {
  let saveCalls = 0;
  const manager = new ContextDashboardManager({
    isDisplayAvailable: () => true,
    createId: () => "currentturnview000001",
    deliver: async () => ({ status: "acknowledged", frameId: 1 }),
    clear: () => {}, loadPins: () => [], savePins: () => { saveCalls++; },
    now: () => 1_000_000, setTimer: () => 1, clearTimer: () => {},
  });
  const begun = JSON.parse((await manager.begin({
    operation_id: "current-turn-begin", dashboard_key: "context-supplied-summary", title: "Supplied summary",
    privacy: "private", intent: "Summarize this", refresh_policy: { mode: "manual", min_interval_seconds: 30 },
    regeneration: "current_turn_only", ttl_seconds: 300,
  }, undefined, () => true, owner)).content);
  const spec = { ...genericSpec, dashboard_key: "context-supplied-summary", title: "Supplied summary", local_actions: [] };
  assert.equal((await manager.publish({ operation_id: "current-turn-publish", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec }, undefined, () => true, owner)).ok, true);
  assert.equal(manager.snapshot().pinState, "not_pinnable");
  assert.equal(manager.snapshot().components.some((component) => component.id === "phone:pin"), false);
  assert.equal(manager.snapshot().components.find((component) => component.id === "phone:pin:status").value, "Not pinnable");

  const actionAttempt = await manager.publish({ operation_id: "current-turn-action", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 2,
    spec: { ...spec, local_actions: [{ id: "refresh", kind: "refresh", label: "Refresh", enabled: true }] },
  }, undefined, () => true, owner);
  assert.equal(actionAttempt.ok, false);
  const refreshAttempt = await manager.startRefresh({ operation_id: "current-turn-refresh", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, expected_revision: 2 }, undefined, () => true, { ...owner, turnGeneration: "later-turn" });
  assert.equal(refreshAttempt.ok, false);
  assert.equal(saveCalls, 0);
});

test("a generic dashboard key cannot masquerade as a different saved recipe", async () => {
  const savedPin = { dashboard_key: genericSpec.dashboard_key, title: genericSpec.title, privacy: "private",
    intent: "Give me a three-step plan for tomorrow", refresh_policy: { mode: "manual", min_interval_seconds: 30 } };
  let deliveries = 0;
  const manager = new ContextDashboardManager({
    isDisplayAvailable: () => true, createId: () => "collisionrecipeview01",
    deliver: async () => { deliveries++; return { status: "acknowledged", frameId: deliveries }; },
    clear: () => {}, loadPins: () => [savedPin], savePins: () => {}, setTimer: () => 1, clearTimer: () => {},
  });
  const collision = await manager.begin({ operation_id: "recipe-collision", dashboard_key: genericSpec.dashboard_key,
    title: genericSpec.title, privacy: "private", intent: "Plan a completely different project",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
  }, undefined, () => true, owner);
  assert.equal(collision.ok, false);
  assert.match(collision.error, /different pinned recipe/);
  assert.equal(deliveries, 0);
  assert.equal(manager.snapshot(), null);

  const exactRecipe = await manager.begin({ operation_id: "recipe-exact", dashboard_key: genericSpec.dashboard_key,
    title: genericSpec.title, privacy: "private", intent: savedPin.intent,
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
  }, undefined, () => true, owner);
  assert.equal(exactRecipe.ok, true);
  assert.equal(manager.snapshot(), null);
  const exactReceipt = JSON.parse(exactRecipe.content);
  const exactPublished = await manager.publish({ operation_id: "recipe-exact-publish", dashboard_id: exactReceipt.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: genericSpec }, undefined, () => true, owner);
  assert.equal(exactPublished.ok, true);
  assert.equal(manager.snapshot().pinState, "saved");
});

test("phone integration exposes only read-only contextual dashboard publication and contextual voice", () => {
  const tools = readFileSync(new URL("../app/assistant/system-tools.ts", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../app/ui/shell/shell.ts", import.meta.url), "utf8");
  const layer = readFileSync(new URL("../app/ui/shell/dynamic-app-layer.ts", import.meta.url), "utf8");
  const persistence = readFileSync(new URL("../app/assistant/context-dashboard-persistence.ts", import.meta.url), "utf8");
  const mcp = readFileSync(new URL("../app/assistant/mcp-server.ts", import.meta.url), "utf8");
  for (const name of [
    "glasses.context_dashboard.capabilities",
    "glasses.context_dashboard.present",
    "glasses.context_dashboard.begin",
    "glasses.context_dashboard.publish",
    "glasses.context_dashboard.start_refresh",
  ]) assert.ok(tools.includes(`name: "${name}"`), name);
  assert.doesNotMatch(tools, /glasses\.context_dashboard\.(?:toggle|mutate|execute)/);
  assert.match(shell, /contextDashboardVoicePrefix/);
  assert.match(shell, /this\.openVoiceDialog\(\{ defaultTarget: "assistant" \}\)/);
  assert.match(shell, /prior\.state\.viewId !== state\.viewId[\s\S]*?prior\.close\(\)/);
  assert.match(layer, /temporary\$\{deckLabels/);
  assert.match(tools, /presentation_mode/);
  assert.match(tools, /enum: \["single", "deck"\]/);
  assert.match(tools, /const contextBarSchema/);
  assert.match(tools, /"bar_chart"/);
  assert.match(tools, /const contextSummarySchema/);
  assert.match(tools, /const contextSectionSchema/);
  assert.match(tools, /attribution_id:[\s\S]*?enum: \["open_meteo_ukmo"\]/);
  assert.match(tools, /callers never provide URLs/);
  assert.match(tools, /no pre-registered app, domain adapter, or external API is required/);
  assert.match(tools, /required: \["operation_id", "dashboard_key", "title", "privacy", "intent", "refresh_policy", "regeneration", "ttl_seconds"\]/);
  assert.match(tools, /Gather data before this single call; it never emits a working, loading, partial, or tool-progress layer/);
  assert.match(tools, /Reserve a generic temporary contextual interface offscreen/);
  assert.match(tools, /later terminal publish is the first visible frame/);
  const actionSchema = tools.slice(tools.indexOf("const contextLocalActionSchema"), tools.indexOf("const contextAnnouncementSchema"));
  assert.doesNotMatch(actionSchema, /enum: \[[^\]]*"pin"/);
  assert.match(persistence, /MAX_ENCODED_CHARS = 8 \* 1024/);
  assert.match(persistence, /encoded\.length > MAX_ENCODED_CHARS/);
  assert.match(mcp, /profilePolicyError/);
  assert.match(mcp, /this\.options\.getProfileId\?\.\(\) \?\? this\.options\.profileId/);
});

test("local refresh is replay-safe and phone-owned pinning persists only a fresh-data recipe", async () => {
  const { manager, persisted } = setup();
  const begun = JSON.parse((await manager.begin({
    operation_id: "begin-local", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "on_visible", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
  }, undefined, () => true, owner)).content);
  const localSpec = { ...baseSpec, local_actions: [
    { id: "refresh", kind: "refresh", label: "Refresh", enabled: true },
  ] };
  await manager.publish({ operation_id: "publish-local", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: localSpec }, undefined, () => true, owner);

  focusComponent(manager, "action:refresh:refresh");
  assert.equal(manager.handleInput("click", true), true);
  const read = manager.readEvents({ ...owner, turnGeneration: "turn-2" }, begun.dashboard_id, 1, 2, null);
  const event = JSON.parse(read.content).events[0];
  assert.equal(event.kind, "refresh");
  assert.equal(event.intent, "When is the next train at Liverpool Lime Street?");
  assert.equal(manager.ackEvents({ ...owner, turnGeneration: "turn-2" }, begun.dashboard_id, 1, 2, event.event_id).ok, true);
  assert.equal(JSON.parse(manager.readEvents({ ...owner, turnGeneration: "turn-2" }, begun.dashboard_id, 1, 2, event.event_id).content).events.length, 0);

  const expiresAtMs = manager.snapshot().expiresAtMs;
  focusComponent(manager, "phone:pin");
  manager.handleInput("click", true);
  assert.equal(persisted.length, 1);
  assert.equal(manager.snapshot().pinned, true);
  assert.equal(manager.snapshot().presentationLifetime, "temporary");
  assert.equal(manager.snapshot().expiresAtMs, expiresAtMs);
  assert.equal(manager.snapshot().components.find((component) => component.id === "phone:pin").label, "Unpin");
  const encoded = JSON.stringify(persisted[0]);
  assert.doesNotMatch(encoded, /Manchester Airport|National Rail|service-1|announcement|rows|sources/);
  assert.match(encoded, /When is the next train at Liverpool Lime Street/);
  const listed = JSON.parse(manager.listPins({ ...owner, turnGeneration: "turn-3" }).content).pins;
  assert.deepEqual(listed, [{
    dashboard_key: baseSpec.dashboard_key,
    title: baseSpec.title,
    privacy: "private",
    refresh_policy: { mode: "on_visible", min_interval_seconds: 30 },
  }]);
  assert.doesNotMatch(JSON.stringify(listed), /When is the next train/);

  const republished = await manager.publish({ operation_id: "publish-after-pin", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 2,
    spec: { ...baseSpec, summary: { ...baseSpec.summary, primary: "Updated departure" } } }, undefined, () => true, owner);
  assert.equal(republished.ok, true);
  assert.equal(manager.snapshot().pinned, true);
  assert.equal(manager.snapshot().components.find((component) => component.id === "phone:pin").label, "Unpin");

  const reopenArgs = { operation_id: "reopen-pin", dashboard_key: baseSpec.dashboard_key, ttl_seconds: 300 };
  const reopened = await manager.openPin(reopenArgs, undefined, () => true, { ...owner, turnGeneration: "turn-3" });
  assert.equal(reopened.ok, true);
  const reopenReceipt = JSON.parse(reopened.content);
  assert.equal(reopenReceipt.intent, "When is the next train at Liverpool Lime Street?");
  assert.equal(reopenReceipt.status, "reserved");
  assert.equal(manager.snapshot(), null);

  await manager.begin({ operation_id: "replace-selected-pin", dashboard_key: "replacement-context", title: "Replacement",
    privacy: "private", intent: "Show replacement context", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent",
    ttl_seconds: 300 }, undefined, () => true, { ...owner, turnGeneration: "turn-3" });
  const historicalOpen = await manager.openPin(reopenArgs, undefined, () => true, { ...owner, turnGeneration: "turn-3" });
  assert.equal(historicalOpen.ok, true);
  assert.equal(JSON.parse(historicalOpen.content).status, "historical_acknowledgement");
  assert.equal(Object.hasOwn(JSON.parse(historicalOpen.content), "intent"), false);
});

test("a selected pin intent is cached only while its exact revision-one loading view is current", async () => {
  const sentinel = "SELECTED_PIN_INTENT_SENTINEL";
  const storedPin = { dashboard_key: "selected-pin", title: "Selected pin", privacy: "private", intent: sentinel,
    refresh_policy: { mode: "manual", min_interval_seconds: 30 } };
  const makeManager = (viewId) => {
    let timer = null;
    const manager = new ContextDashboardManager({
      isDisplayAvailable: () => true, createId: () => viewId,
      deliver: async () => ({ status: "acknowledged", frameId: 1 }), clear: () => {}, loadPins: () => [storedPin],
      savePins: () => {}, setTimer: (callback) => { timer = callback; return callback; },
      clearTimer: (candidate) => { if (timer === candidate) timer = null; },
    });
    return { manager, expire: () => timer?.() };
  };
  const cached = (manager) => JSON.stringify([...manager.operations.values()]);
  const openArgs = { operation_id: "select-pin", dashboard_key: storedPin.dashboard_key, ttl_seconds: 300 };

  const revision = makeManager("selectedpinpublish01");
  const opened = await revision.manager.openPin(openArgs, undefined, () => true, owner);
  assert.equal(JSON.parse(opened.content).intent, sentinel);
  assert.equal(JSON.parse((await revision.manager.openPin(openArgs, undefined, () => true, owner)).content).intent, sentinel);
  assert.match(cached(revision.manager), /SELECTED_PIN_INTENT_SENTINEL/);
  const selected = JSON.parse(opened.content);
  const published = await revision.manager.publish({ operation_id: "selected-publish", dashboard_id: selected.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1,
    spec: { ...baseSpec, dashboard_key: storedPin.dashboard_key, title: storedPin.title } }, undefined, () => true, owner);
  assert.equal(published.ok, true);
  assert.doesNotMatch(cached(revision.manager), /SELECTED_PIN_INTENT_SENTINEL/);
  const historicalAfterPublish = JSON.parse((await revision.manager.openPin(openArgs, undefined, () => true, owner)).content);
  assert.equal(historicalAfterPublish.status, "historical_acknowledgement");
  assert.equal(Object.hasOwn(historicalAfterPublish, "intent"), false);

  const closedSelection = makeManager("selectedpinclose0001");
  const closeOpened = JSON.parse((await closedSelection.manager.openPin(openArgs, undefined, () => true, owner)).content);
  closedSelection.manager.close({ operation_id: "close-selected", dashboard_id: closeOpened.dashboard_id,
    presentation_generation: 1, expected_revision: 1 }, owner);
  assert.doesNotMatch(cached(closedSelection.manager), /SELECTED_PIN_INTENT_SENTINEL/);
  const historicalAfterClose = JSON.parse((await closedSelection.manager.openPin(openArgs, undefined, () => true, owner)).content);
  assert.equal(historicalAfterClose.status, "historical_acknowledgement");
  assert.equal(Object.hasOwn(historicalAfterClose, "intent"), false);

  const expiredSelection = makeManager("selectedpinexpiry001");
  await expiredSelection.manager.openPin(openArgs, undefined, () => true, owner);
  assert.match(cached(expiredSelection.manager), /SELECTED_PIN_INTENT_SENTINEL/);
  expiredSelection.expire();
  assert.doesNotMatch(cached(expiredSelection.manager), /SELECTED_PIN_INTENT_SENTINEL/);
  const historicalAfterExpiry = JSON.parse((await expiredSelection.manager.openPin(openArgs, undefined, () => true, owner)).content);
  assert.equal(historicalAfterExpiry.status, "historical_acknowledgement");
  assert.equal(Object.hasOwn(historicalAfterExpiry, "intent"), false);
});

test("privacy is immutable and a legacy saved pin remains removable after exact reopen", async () => {
  const { manager } = setup();
  const begun = JSON.parse((await manager.begin({ operation_id: "privacy", dashboard_key: baseSpec.dashboard_key,
    title: baseSpec.title, privacy: "sensitive", intent: "Sensitive contextual query",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 }, undefined, () => true, owner)).content);
  const downgraded = await manager.publish({ operation_id: "privacy-downgrade", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1,
    spec: { ...baseSpec, privacy: "private" } }, undefined, () => true, owner);
  assert.equal(downgraded.ok, false);
  assert.equal(manager.snapshot(), null);
  const sensitivePublished = await manager.publish({ operation_id: "privacy-publish", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1,
    spec: { ...baseSpec, privacy: "sensitive" } }, undefined, () => true, owner);
  assert.equal(sensitivePublished.ok, true);
  assert.equal(manager.snapshot().privacy, "sensitive");
  assert.equal(manager.snapshot().pinState, "not_pinnable");
  assert.equal(manager.snapshot().components.some((component) => component.id === "phone:pin"), false);

  const retainedPin = [{ dashboard_key: "legacy-sensitive", title: "Legacy", privacy: "private",
    intent: "Legacy saved contextual query", refresh_policy: { mode: "manual", min_interval_seconds: 30 } }];
  const legacy = new ContextDashboardManager({
    isDisplayAvailable: () => true, createId: () => "legacysensitiveview01",
    deliver: async () => ({ status: "acknowledged", frameId: 1 }), clear: () => {}, loadPins: () => retainedPin,
    savePins: () => {}, setTimer: () => 1, clearTimer: () => {},
  });
  const legacyOpened = JSON.parse((await legacy.openPin({ operation_id: "legacy", dashboard_key: "legacy-sensitive", ttl_seconds: 300 },
  undefined, () => true, owner)).content);
  await legacy.publish({ operation_id: "legacy-publish", dashboard_id: legacyOpened.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1,
    spec: { ...genericSpec, dashboard_key: "legacy-sensitive", title: "Legacy" } }, undefined, () => true, owner);
  assert.equal(legacy.snapshot().pinned, true);
  assert.equal(legacy.snapshot().pinState, "saved");
  assert.equal(legacy.snapshot().components.find((component) => component.id === "phone:pin").label, "Unpin");
  focusComponent(legacy, "phone:pin");
  legacy.handleInput("click", true);
  assert.equal(legacy.snapshot().pinned, false);
  assert.equal(JSON.parse(legacy.listPins(owner).content).pins.length, 0);
});

test("historical refresh replay cannot claim a replacement turn and close is idempotent", async () => {
  const { manager, deliveries } = setup();
  const first = JSON.parse((await manager.begin({ operation_id: "first", dashboard_key: "first-context", title: "First",
    privacy: "private", intent: "Show first context", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent",
    ttl_seconds: 300 }, undefined, () => true, owner)).content);
  await manager.publish({ operation_id: "first-publish", dashboard_id: first.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1,
    spec: { ...genericSpec, dashboard_key: "first-context", title: "First" } }, undefined, () => true, owner);
  const refreshArgs = { operation_id: "old-refresh", dashboard_id: first.dashboard_id,
    presentation_generation: 1, expected_revision: 2 };
  const refreshed = await manager.startRefresh(refreshArgs, undefined, () => true, { ...owner, turnGeneration: "turn-2" });
  assert.equal(JSON.parse(refreshed.content).revision, 3);

  const replacementOwner = { ...owner, turnGeneration: "turn-3" };
  const replacement = JSON.parse((await manager.begin({ operation_id: "replacement", dashboard_key: "replacement-context",
    title: "Replacement", privacy: "private", intent: "Show replacement context",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 }, undefined, () => true, replacementOwner)).content);
  const deliveryCount = deliveries.length;
  const historical = await manager.startRefresh(refreshArgs, undefined, () => true, { ...owner, turnGeneration: "turn-4" });
  assert.equal(JSON.parse(historical.content).status, "historical_acknowledgement");
  assert.equal(deliveries.length, deliveryCount);

  const replacementSpec = { ...baseSpec, dashboard_key: "replacement-context", title: "Replacement" };
  const claimed = await manager.publish({ operation_id: "claimed", dashboard_id: replacement.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: replacementSpec },
  undefined, () => true, { ...owner, turnGeneration: "turn-4" });
  assert.equal(claimed.ok, false);
  const published = await manager.publish({ operation_id: "replacement-publish", dashboard_id: replacement.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: replacementSpec },
  undefined, () => true, replacementOwner);
  assert.equal(published.ok, true);

  const publishedReceipt = JSON.parse(published.content);
  const closeArgs = { operation_id: "close-replacement", dashboard_id: replacement.dashboard_id,
    presentation_generation: 1, expected_revision: publishedReceipt.revision };
  const closed = manager.close(closeArgs, replacementOwner);
  assert.equal(JSON.parse(closed.content).status, "closed");
  const retriedClose = manager.close(closeArgs, { ...owner, turnGeneration: "turn-5" });
  assert.equal(retriedClose.ok, true);
  assert.equal(JSON.parse(retriedClose.content).status, "historical_acknowledgement");
  const conflictingClose = manager.close({ ...closeArgs, dashboard_id: "differentdashboard0001" }, replacementOwner);
  assert.equal(conflictingClose.ok, false);
});

test("pinning is automatic, sensitive views are not pinnable, and failed secure persistence is atomic", async () => {
  const { manager } = setup();
  const begun = JSON.parse((await manager.begin({ operation_id: "automatic", dashboard_key: baseSpec.dashboard_key,
    title: baseSpec.title, privacy: "private", intent: "Train departures",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 }, undefined, () => true, owner)).content);
  await manager.publish({ operation_id: "automatic-publish", dashboard_id: begun.dashboard_id, presentation_generation: 1,
    refresh_generation: 1, expected_revision: 1,
    spec: { ...baseSpec, local_actions: [{ id: "legacy", kind: "pin", label: "Provider label", enabled: true }] } },
  undefined, () => true, owner);
  const pinControls = manager.snapshot().components.filter((component) => component.id === "phone:pin");
  assert.equal(pinControls.length, 1);
  assert.equal(pinControls[0].label, "Pin");
  assert.equal(manager.snapshot().components.some((component) => component.id === "action:pin:legacy"), false);

  const sensitiveSpec = { ...baseSpec, dashboard_key: "sensitive-context", privacy: "sensitive" };
  const sensitive = new ContextDashboardManager({ isDisplayAvailable: () => true, createId: () => "sensitivecontextview01",
    deliver: async () => ({ status: "acknowledged", frameId: 1 }), clear: () => {}, loadPins: () => [], savePins: () => {},
    setTimer: () => 1, clearTimer: () => {} });
  const sensitiveBegin = JSON.parse((await sensitive.begin({ operation_id: "sensitive", dashboard_key: "sensitive-context",
    title: "Sensitive", privacy: "sensitive", intent: "Sensitive current information",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 }, undefined, () => true, owner)).content);
  await sensitive.publish({ operation_id: "sensitive-publish", dashboard_id: sensitiveBegin.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: sensitiveSpec }, undefined, () => true, owner);
  assert.equal(sensitive.snapshot().components.some((component) => component.id === "phone:pin"), false);
  assert.equal(sensitive.snapshot().pinState, "not_pinnable");
  assert.equal(sensitive.snapshot().components.find((component) => component.id === "phone:pin:status").value, "Not pinnable");
  assert.equal(sensitive.snapshot().pinned, false);

  const fullPins = Array.from({ length: 5 }, (_, index) => ({ dashboard_key: `saved-${index}`, title: `Saved ${index}`,
    privacy: "private", intent: `Saved contextual query ${index}`, refresh_policy: { mode: "manual", min_interval_seconds: 30 } }));
  const full = new ContextDashboardManager({ isDisplayAvailable: () => true, createId: () => "fullpincontextview01",
    deliver: async () => ({ status: "acknowledged", frameId: 1 }), clear: () => {}, loadPins: () => fullPins, savePins: () => {},
    setTimer: () => 1, clearTimer: () => {} });
  const fullOpened = JSON.parse((await full.begin({ operation_id: "full", dashboard_key: "sixth-context", title: "Sixth", privacy: "private",
    intent: "Sixth contextual query", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 },
  undefined, () => true, owner)).content);
  await full.publish({ operation_id: "full-publish", dashboard_id: fullOpened.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1,
    spec: { ...genericSpec, dashboard_key: "sixth-context", title: "Sixth" } }, undefined, () => true, owner);
  assert.equal(full.snapshot().components.some((component) => component.id === "phone:pin"), false);
  assert.equal(full.snapshot().pinState, "limit");
  assert.equal(full.snapshot().components.find((component) => component.id === "phone:pin:status").value, "5/5 full");

  const fullSavedOpened = JSON.parse((await full.begin({ operation_id: "full-saved", dashboard_key: "saved-0", title: "Saved 0", privacy: "private",
    intent: "Saved contextual query 0", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 },
  undefined, () => true, owner)).content);
  await full.publish({ operation_id: "full-saved-publish", dashboard_id: fullSavedOpened.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1,
    spec: { ...genericSpec, dashboard_key: "saved-0", title: "Saved 0" } }, undefined, () => true, owner);
  assert.equal(full.snapshot().pinState, "saved");
  assert.equal(full.snapshot().components.find((component) => component.id === "phone:pin").label, "Unpin");

  let failPinWrites = true;
  const failing = new ContextDashboardManager({ isDisplayAvailable: () => true, createId: () => "failingpincontext001",
    deliver: async () => ({ status: "acknowledged", frameId: 1 }), clear: () => {}, loadPins: () => [],
    savePins: () => { if (failPinWrites) throw new Error("secure store unavailable"); }, setTimer: () => 1, clearTimer: () => {} });
  const failingBegin = JSON.parse((await failing.begin({ operation_id: "failing", dashboard_key: baseSpec.dashboard_key,
    title: baseSpec.title, privacy: "private", intent: "Train departures",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 }, undefined, () => true, owner)).content);
  await failing.publish({ operation_id: "failing-publish", dashboard_id: failingBegin.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: baseSpec }, undefined, () => true, owner);
  focusComponent(failing, "phone:pin");
  failing.handleInput("click", true);
  assert.equal(failing.snapshot().pinned, false);
  assert.equal(failing.snapshot().components.find((component) => component.id === "phone:pin").label, "Pin");
  assert.equal(failing.snapshot().pinState, "save_failed");
  assert.equal(failing.snapshot().components.find((component) => component.id === "phone:pin:status").value, "Save failed");
  assert.deepEqual(JSON.parse(failing.listPins(owner).content).pins, []);
  failPinWrites = false;
  focusComponent(failing, "phone:pin");
  failing.handleInput("click", true);
  assert.equal(failing.snapshot().pinState, "saved");
  assert.equal(failing.snapshot().components.some((component) => component.id === "phone:pin:status"), false);

  const retainedPin = [{ dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "Train departures", refresh_policy: { mode: "manual", min_interval_seconds: 30 } }];
  let failUnpinWrites = true;
  const failingUnpin = new ContextDashboardManager({ isDisplayAvailable: () => true, createId: () => "failingunpinview001",
    deliver: async () => ({ status: "acknowledged", frameId: 1 }), clear: () => {}, loadPins: () => retainedPin,
    savePins: () => { if (failUnpinWrites) throw new Error("secure store unavailable"); }, setTimer: () => 1, clearTimer: () => {} });
  const failingUnpinOpened = JSON.parse((await failingUnpin.begin({ operation_id: "failing-unpin", dashboard_key: baseSpec.dashboard_key,
    title: baseSpec.title, privacy: "private", intent: "Train departures",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 }, undefined, () => true, owner)).content);
  await failingUnpin.publish({ operation_id: "failing-unpin-publish", dashboard_id: failingUnpinOpened.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: baseSpec }, undefined, () => true, owner);
  focusComponent(failingUnpin, "phone:pin");
  failingUnpin.handleInput("click", true);
  assert.equal(failingUnpin.snapshot().pinned, true);
  assert.equal(failingUnpin.snapshot().components.find((component) => component.id === "phone:pin").label, "Unpin");
  assert.equal(failingUnpin.snapshot().pinState, "unpin_failed");
  assert.equal(failingUnpin.snapshot().components.find((component) => component.id === "phone:pin:status").value, "Remove failed");
  assert.equal(JSON.parse(failingUnpin.listPins(owner).content).pins.length, 1);
  failUnpinWrites = false;
  focusComponent(failingUnpin, "phone:pin");
  failingUnpin.handleInput("click", true);
  assert.equal(failingUnpin.snapshot().pinState, "available");
  assert.equal(failingUnpin.snapshot().components.some((component) => component.id === "phone:pin:status"), false);
  assert.equal(JSON.parse(failingUnpin.listPins(owner).content).pins.length, 0);
});

test("pin recipes survive TTL and process restart while presentations, events, and identities do not", async () => {
  let armedTimer = null;
  let savedPins = [];
  let nextId = 0;
  const manager = new ContextDashboardManager({
    isDisplayAvailable: () => true,
    createId: () => `temporarycontext${String(++nextId).padStart(3, "0")}`,
    deliver: async () => ({ status: "acknowledged", frameId: nextId + 10 }),
    clear: () => {}, loadPins: () => [], savePins: (pins) => { savedPins = structuredClone(pins); },
    setTimer: (callback) => { armedTimer = callback; return callback; },
    clearTimer: (timer) => { if (armedTimer === timer) armedTimer = null; },
  });
  const begun = JSON.parse((await manager.begin({ operation_id: "lifecycle", dashboard_key: baseSpec.dashboard_key,
    title: baseSpec.title, privacy: "private", intent: "Train departures",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 }, undefined, () => true, owner)).content);
  await manager.publish({ operation_id: "lifecycle-publish", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: baseSpec }, undefined, () => true, owner);
  focusComponent(manager, "phone:pin");
  manager.handleInput("click", true);
  focusComponent(manager, "action:refresh:refresh");
  manager.handleInput("click", true);
  assert.equal(savedPins.length, 1);
  const expiredIdentity = { dashboardId: begun.dashboard_id, revision: 2 };
  armedTimer();
  assert.equal(manager.snapshot(), null);
  assert.equal(JSON.parse(manager.listPins(owner).content).pins.length, 1);
  assert.equal(manager.readEvents(owner, expiredIdentity.dashboardId, expiredIdentity.revision, null).ok, false);

  const restarted = new ContextDashboardManager({
    isDisplayAvailable: () => true, createId: () => "restartedcontextview01",
    deliver: async () => ({ status: "acknowledged", frameId: 99 }), clear: () => {},
    loadPins: () => structuredClone(savedPins), savePins: () => {}, setTimer: () => 1, clearTimer: () => {},
  });
  assert.equal(restarted.snapshot(), null);
  assert.equal(JSON.parse(restarted.listPins({ ...owner, turnGeneration: "restart-turn" }).content).pins.length, 1);
  const reopened = JSON.parse((await restarted.openPin({ operation_id: "restart-open", dashboard_key: baseSpec.dashboard_key,
    ttl_seconds: 300 }, undefined, () => true, { ...owner, turnGeneration: "restart-turn" })).content);
  assert.equal(reopened.dashboard_id, "restartedcontextview01");
  assert.equal(reopened.revision, 1);
  assert.notEqual(reopened.dashboard_id, expiredIdentity.dashboardId);
  const reopenedPublished = await restarted.publish({ operation_id: "restart-publish", dashboard_id: reopened.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: baseSpec }, undefined, () => true,
  { ...owner, turnGeneration: "restart-turn" });
  assert.equal(reopenedPublished.ok, true);
  assert.deepEqual(JSON.parse(restarted.readEvents({ ...owner, turnGeneration: "restart-turn" },
    reopened.dashboard_id, 1, 2, null).content).events, []);
});

test("TTL tombstones blocked same-dashboard publish and refresh deliveries without double-clearing", async () => {
  for (const operation of ["publish", "startRefresh"]) {
    let deliveryCount = 0;
    let releasePending;
    let armedTimer = null;
    const clears = [];
    const manager = new ContextDashboardManager({
      isDisplayAvailable: () => true,
      createId: () => `ttlblocked${operation.toLowerCase()}01`,
      deliver: async () => {
        deliveryCount++;
        if (deliveryCount === 2) await new Promise((resolve) => { releasePending = resolve; });
        return { status: "acknowledged", frameId: deliveryCount };
      },
      clear: (identity) => clears.push(identity),
      loadPins: () => [], savePins: () => {}, now: () => 1_000_000,
      setTimer: (callback) => { armedTimer = callback; return callback; },
      clearTimer: (timer) => { if (armedTimer === timer) armedTimer = null; },
    });
    const begun = JSON.parse((await manager.begin({ operation_id: `ttl-${operation}-begin`, dashboard_key: baseSpec.dashboard_key,
      title: baseSpec.title, privacy: "private", intent: "Train departures",
      refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 }, undefined, () => true, owner)).content);
    const initial = await manager.publish({ operation_id: `ttl-${operation}-initial`, dashboard_id: begun.dashboard_id,
      presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: baseSpec }, undefined, () => true, owner);
    assert.equal(initial.ok, true);
    const expireCurrent = armedTimer;
    const update = operation === "publish"
      ? manager.publish({ operation_id: "ttl-blocked-publish", dashboard_id: begun.dashboard_id,
        presentation_generation: 1, refresh_generation: 1, expected_revision: 2,
        spec: { ...baseSpec, summary: { ...baseSpec.summary, secondary: "Updated" } } }, undefined, () => true, owner)
      : manager.startRefresh({ operation_id: "ttl-blocked-refresh", dashboard_id: begun.dashboard_id,
        presentation_generation: 1, expected_revision: 2 }, undefined, () => true, owner);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(typeof releasePending, "function", `${operation} delivery must be blocked`);
    expireCurrent();
    assert.equal(manager.snapshot(), null);
    releasePending();
    assert.equal((await update).ok, false);
    assert.equal(manager.snapshot(), null, `late ${operation} acknowledgement must not reinstall the expired dashboard`);
    assert.deepEqual(clears, [
      { viewId: begun.dashboard_id, revision: 3 },
      { viewId: begun.dashboard_id, revision: 2 },
    ], `${operation} pending and current revisions must each be cleared exactly once`);
  }
});

test("content identities cannot alias phone-local actions and pending revisions cannot receive input", async () => {
  let releaseUpdate;
  let delivery = 0;
  const persisted = [];
  const manager = new ContextDashboardManager({
    isDisplayAvailable: () => true, createId: () => "collisioncontextview01", clear: () => {},
    deliver: async () => {
      delivery++;
      if (delivery === 1) await new Promise((resolve) => { releaseUpdate = resolve; });
      return { status: "acknowledged", frameId: delivery };
    },
    loadPins: () => [], savePins: (pins) => persisted.push(structuredClone(pins)), setTimer: () => 1, clearTimer: () => {},
  });
  const begun = JSON.parse((await manager.begin({ operation_id: "collision", dashboard_key: "collision-dashboard",
    title: "Collision test", privacy: "private", intent: "Collision test",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 }, undefined, () => true, owner)).content);
  const collisionSpec = { ...baseSpec, dashboard_key: "collision-dashboard", title: "Collision test",
    sections: [{ id: "phone", order: 0, type: "status_grid", title: "Rows", load_state: "ready", source_ids: ["rail"],
      uncertainty: "exact", rows: [{ id: "pin", label: "Inert row", value: "No action" }] }] };
  const publishing = manager.publish({ operation_id: "collision-publish", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: collisionSpec }, undefined, () => true, owner);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.handleInput("click", true, { viewId: begun.dashboard_id, revision: 2 }), false);
  assert.equal(persisted.length, 0);
  releaseUpdate();
  await publishing;

  const ids = manager.snapshot().components.map((component) => component.id);
  assert.equal(new Set(ids).size, ids.length);
  focusComponent(manager, "section:phone:row:pin");
  manager.handleInput("click", true, { viewId: begun.dashboard_id, revision: 2 });
  assert.deepEqual(JSON.parse(manager.readEvents(owner, begun.dashboard_id, 1, 2, null).content).events, []);
  const refreshControl = manager.snapshot().components.find((component) => component.type === "button" && component.label === "Refresh");
  assert.ok(refreshControl);
  focusComponent(manager, refreshControl.id);
  manager.handleInput("click", true, { viewId: begun.dashboard_id, revision: 2 });
  const refreshEvent = JSON.parse(manager.readEvents(owner, begun.dashboard_id, 1, 2, null).content).events[0];
  assert.equal(refreshEvent.kind, "refresh");
  manager.ackEvents(owner, begun.dashboard_id, 1, 2, refreshEvent.event_id);

  focusComponent(manager, "phone:pin");
  await manager.publish({ operation_id: "collision-remove", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 2,
    spec: { ...baseSpec, dashboard_key: "collision-dashboard", title: "Collision test" } }, undefined, () => true, owner);
  assert.equal(manager.snapshot().components[manager.snapshot().scrollOffset].id, "phone:pin");

  const compositeSpec = { ...baseSpec, dashboard_key: "collision-dashboard", title: "Collision test", sections: [
    { id: "a-b", order: 0, type: "status_grid", load_state: "ready", source_ids: ["rail"], uncertainty: "exact",
      rows: [{ id: "c", label: "First", value: "One" }] },
    { id: "a", order: 1, type: "status_grid", load_state: "ready", source_ids: ["rail"], uncertainty: "exact",
      rows: [{ id: "b-c", label: "Second", value: "Two" }] },
  ] };
  await manager.publish({ operation_id: "composite-ids", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 3, spec: compositeSpec }, undefined, () => true, owner);
  const compositeIds = manager.snapshot().components.map((component) => component.id);
  assert.ok(compositeIds.includes("section:a-b:row:c"));
  assert.ok(compositeIds.includes("section:a:row:b-c"));
  assert.equal(new Set(compositeIds).size, compositeIds.length);
});

test("phone rejects non-MCP callers before displaying a contextual dashboard", async () => {
  const { manager, deliveries } = setup();
  const denied = await manager.begin({
    operation_id: "direct-denied", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
  }, undefined, () => true, { caller: "direct", turnGeneration: "turn-direct" });
  assert.equal(denied.ok, false);
  assert.equal(deliveries.length, 0);
});

test("phone rejects a non-even-g2 MCP profile and pin reads require the exact profile turn", async () => {
  const { manager, deliveries } = setup();
  const args = { operation_id: "profile-denied", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 };
  assert.equal((await manager.begin(args, undefined, () => true, { ...owner, profileId: "default" })).ok, false);
  assert.equal(manager.listPins({ ...owner, profileId: "default" }).ok, false);
  assert.equal(deliveries.length, 0);
});

test("disconnect tombstones an in-flight final delivery and stale turns cannot publish without starting refresh", async () => {
  let release;
  const deliveries = [];
  const clears = [];
  const manager = new ContextDashboardManager({
    isDisplayAvailable: () => true, createId: () => "contextdashboardpending001", clear: (identity) => clears.push(identity),
    deliver: async (state) => { deliveries.push(state); await new Promise((resolve) => { release = resolve; }); return { status: "acknowledged", frameId: 1 }; },
    loadPins: () => [], savePins: () => {}, setTimer: () => 1, clearTimer: () => {},
  });
  const reservation = JSON.parse((await manager.begin({ operation_id: "pending", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 },
  undefined, () => true, owner)).content);
  const publishing = manager.publish({ operation_id: "pending-publish", dashboard_id: reservation.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: baseSpec }, undefined, () => true, owner);
  await new Promise((resolve) => setTimeout(resolve, 0));
  manager.closeConnection({ ...owner, turnGeneration: null });
  assert.deepEqual(clears, [{ viewId: "contextdashboardpending001", revision: 2 }]);
  release();
  assert.equal((await publishing).ok, false);
  assert.equal(manager.snapshot(), null);

  const { manager: live } = setup();
  const begun = JSON.parse((await live.begin({ operation_id: "live", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 },
  undefined, () => true, owner)).content);
  const stale = await live.publish({ operation_id: "stale-publish", dashboard_id: begun.dashboard_id, presentation_generation: 1,
    refresh_generation: 1, expected_revision: 1, spec: baseSpec }, undefined, () => true, { ...owner, turnGeneration: "turn-2" });
  assert.equal(stale.ok, false);
});

test("validator rejects inherited specs and manager rejects non-positive delivery receipts", async () => {
  assert.ok(validateContextDashboardSpec(Object.create(baseSpec)));
  const manager = new ContextDashboardManager({ isDisplayAvailable: () => true, createId: () => "contextdashboardreceipt01",
    deliver: async () => ({ status: "acknowledged", frameId: -1 }), clear: () => {}, loadPins: () => [], savePins: () => {},
    setTimer: () => 1, clearTimer: () => {} });
  const reserved = JSON.parse((await manager.begin({ operation_id: "receipt", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 },
  undefined, () => true, owner)).content);
  const denied = await manager.publish({ operation_id: "receipt-publish", dashboard_id: reserved.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: baseSpec }, undefined, () => true, owner);
  assert.equal(denied.ok, false);
});

test("atomic context result stays hidden through blank wake drain and displaces the assistant only after strict lens delivery", () => {
  const layers = readFileSync(new URL("../app/ui/layers.ts", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../app/ui/shell/shell.ts", import.meta.url), "utf8");
  assert.match(layers, /detach\(target: Layer\): boolean/);
  assert.match(shell, /private detachedAssistantLayer: AssistantLayer \| null = null/);
  assert.match(shell, /displacedAssistant = contextState\.dashboardId && !finalContextAnswer \? this\.assistantLayer : null/);
  assert.match(shell, /this\.stack\.detach\(displacedAssistant\)/);
  assert.match(shell, /this\.detachedAssistantLayer = displacedAssistant/);
  assert.match(shell, /detachedAssistant\?\.onRemoved\(\)/);
  assert.match(shell, /assistantRetained: this\.detachedAssistantLayer === displacedAssistant/);
  const show = shell.slice(shell.indexOf("async showDynamicApp("), shell.indexOf("clearDynamicApp(", shell.indexOf("async showDynamicApp(")));
  assert.match(show, /prepareAtomicAssistantResultLayer\(\{/);
  assert.match(show, /enterIsolation: \(\) => this\.setAssistantOnlyPresentation\(true\)/);
  assert.match(show, /drainBlankRender:[\s\S]*waitForShellRenderIdle/);
  assert.match(show, /installFinalLayer,/);
  assert.ok(show.indexOf("requestShellDelivery") < show.indexOf("preparation?.commit()"));
  assert.match(show, /isSuccessfulFrameOutcome\(receipt\.outcome\)/);
  assert.doesNotMatch(show, /receipt\.outcome\s*===\s*["']no-change/);
});

test("ring scroll advances through departure rows before reaching fixed local actions", async () => {
  const { manager } = setup();
  const begun = JSON.parse((await manager.begin({ operation_id: "scroll", dashboard_key: baseSpec.dashboard_key, title: baseSpec.title, privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300 },
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

test("bounded decks derive stable lens pages, navigate locally, and expose only cover Pin", async () => {
  const { manager, persisted } = setup();
  const begun = JSON.parse((await manager.begin({
    operation_id: "deck-begin", dashboard_key: deckSpec.dashboard_key, title: deckSpec.title, privacy: "private",
    intent: "Show the next Liverpool departures as a glanceable deck",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
  }, undefined, () => true, owner)).content);
  const published = await manager.publish({
    operation_id: "deck-publish", dashboard_id: begun.dashboard_id,
    presentation_generation: begun.presentation_generation, refresh_generation: begun.refresh_generation,
    expected_revision: begun.revision, spec: deckSpec,
  }, undefined, () => true, owner);
  assert.equal(published.ok, true);

  let snapshot = manager.snapshot();
  assert.equal(snapshot.presentationMode, "deck");
  assert.equal(snapshot.pageId, "cover");
  assert.equal(snapshot.pageIndex, 0);
  assert.equal(snapshot.pageCount, 3);
  assert.equal(snapshot.deckActionLabel, "Pin");
  assert.ok(snapshot.components.some((component) => component.id === "phone:provenance"));
  assert.equal(manager.handleInput("click", true), true);
  snapshot = manager.snapshot();
  assert.equal(snapshot.pageId, "cover");
  assert.equal(snapshot.pinned, true);
  assert.equal(snapshot.deckActionLabel, "Unpin");
  assert.equal(persisted.at(-1)[0].intent, "Show the next Liverpool departures as a glanceable deck");

  assert.equal(manager.handleInput("scroll-down", true), true);
  snapshot = manager.snapshot();
  assert.equal(snapshot.pageId, "section:departures:page:0");
  assert.equal(snapshot.pageIndex, 1);
  assert.equal(snapshot.deckActionHandle, undefined);
  assert.equal(manager.handleInput("click", true), false);
  const firstRows = snapshot.components.filter((component) => component.id.includes(":row:")).map((component) => component.id);
  assert.equal(firstRows.length, 7);

  assert.equal(manager.handleInput("scroll-down", true), true);
  snapshot = manager.snapshot();
  assert.equal(snapshot.pageId, "section:departures:page:1");
  const secondRows = snapshot.components.filter((component) => component.id.includes(":row:")).map((component) => component.id);
  assert.equal(secondRows.length, 5);
  assert.equal(new Set([...firstRows, ...secondRows]).size, 12);
  assert.equal(manager.handleInput("scroll-down", true), false, "deck navigation clamps at the final page");

  const refreshedDeck = { ...deckSpec, summary: { ...deckSpec.summary, secondary: "Freshly projected" } };
  const refreshed = await manager.publish({ operation_id: "deck-publish-2", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 2, spec: refreshedDeck }, undefined, () => true, owner);
  assert.equal(refreshed.ok, true);
  assert.equal(manager.snapshot().pageId, "section:departures:page:1", "a surviving stable page ID is preserved across CAS publish");

  const shorterDeck = { ...refreshedDeck, sections: [{ ...refreshedDeck.sections[0], rows: refreshedDeck.sections[0].rows.slice(0, 5) }] };
  const shortened = await manager.publish({ operation_id: "deck-publish-3", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 3, spec: shorterDeck }, undefined, () => true, owner);
  assert.equal(shortened.ok, true);
  assert.equal(manager.snapshot().pageId, "cover", "a removed page falls back to the cover rather than aliasing another page");
});

test("deck packing makes every maximum list item, note, and provenance line reachable", async () => {
  const listSpec = {
    ...genericSpec,
    presentation_mode: "deck",
    local_actions: [],
    sections: [{
      ...genericSpec.sections[0],
      note: "Ordered for the morning",
      items: Array.from({ length: 8 }, (_, index) => `Step ${index + 1}`),
    }],
  };
  assert.equal(validateContextDashboardSpec(listSpec), null);
  const { manager } = setup();
  const begun = JSON.parse((await manager.begin({
    operation_id: "list-deck-begin", dashboard_key: listSpec.dashboard_key, title: listSpec.title,
    privacy: "private", intent: "Show all eight ordered steps",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
  }, undefined, () => true, owner)).content);
  const published = await manager.publish({
    operation_id: "list-deck-publish", dashboard_id: begun.dashboard_id,
    presentation_generation: begun.presentation_generation, refresh_generation: begun.refresh_generation,
    expected_revision: begun.revision, spec: listSpec,
  }, undefined, () => true, owner);
  assert.equal(published.ok, true);
  assert.equal(manager.snapshot().pageCount, 3);

  const visited = [];
  for (let page = 1; page < 3; page++) {
    assert.equal(manager.handleInput("scroll-down", true), true);
    const snapshot = manager.snapshot();
    assert.equal(snapshot.pageId, `section:steps:page:${page - 1}`);
    assert.ok(snapshot.components.some((component) => component.id === `section:steps:provenance:${page - 1}`));
    visited.push(...snapshot.components.filter((component) => component.id.includes(":item:")).map((component) => component.id));
  }
  assert.deepEqual(visited, Array.from({ length: 8 }, (_, index) => `section:steps:item:${index}`));
  assert.ok(manager.snapshot().components.every((component) => component.id !== "section:steps:note"),
    "the note is emitted once on the first content page, not duplicated");
});

test("same-refresh deck publication cannot extend the temporary presentation lifetime", async () => {
  let now = 1_000_000;
  const manager = new ContextDashboardManager({
    isDisplayAvailable: () => true,
    deliver: async () => ({ status: "acknowledged", frameId: 1 }), clear: () => {},
    createId: () => "deckexpiryidentity001", loadPins: () => [], savePins: () => {},
    now: () => now, setTimer: () => 1, clearTimer: () => {},
  });
  const begun = JSON.parse((await manager.begin({ operation_id: "deck-expiry-begin", dashboard_key: deckSpec.dashboard_key,
    title: deckSpec.title, privacy: "private", intent: "Show a temporary deck",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
  }, undefined, () => true, owner)).content);
  const originalExpiry = 1_300_000;
  now += 100_000;
  const published = await manager.publish({ operation_id: "deck-expiry-publish", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1,
    spec: { ...deckSpec, ttl_seconds: 3600 },
  }, undefined, () => true, owner);
  assert.equal(published.ok, true);
  assert.equal(manager.snapshot().expiresAtMs, originalExpiry);
});

test("bar chart sections become phone-normalized visual bars with printed values", async () => {
  const { manager } = setup();
  const begun = JSON.parse((await manager.begin({ operation_id: "bars-begin", dashboard_key: barChartSpec.dashboard_key,
    title: barChartSpec.title, privacy: "private", intent: "Compare my focus hours by weekday",
    refresh_policy: { mode: "manual", min_interval_seconds: 30 }, regeneration: "self_contained_intent", ttl_seconds: 300,
  }, undefined, () => true, owner)).content);
  const published = await manager.publish({ operation_id: "bars-publish", dashboard_id: begun.dashboard_id,
    presentation_generation: 1, refresh_generation: 1, expected_revision: 1, spec: barChartSpec,
  }, undefined, () => true, owner);
  assert.equal(published.ok, true);
  assert.equal(manager.handleInput("scroll-down", true), true);
  const snapshot = manager.snapshot();
  assert.equal(snapshot.pageId, "section:focus:page:0");
  const bars = snapshot.components.filter((component) => component.type === "progress");
  assert.equal(bars.length, 5);
  assert.deepEqual(bars.map((bar) => bar.id), ["section:focus:bar:mon", "section:focus:bar:tue", "section:focus:bar:wed", "section:focus:bar:thu", "section:focus:bar:fri"]);
  assert.deepEqual(bars.map((bar) => bar.value), [0.4, 0.65, 0.7, 0.95, 0.6]);
  assert.deepEqual(bars.map((bar) => bar.label), ["Monday · 2 h", "Tuesday · 3.25 h", "Wednesday · 3.5 h", "Thursday · 4.75 h", "Friday · 3 h"]);
  assert.ok(snapshot.components.some((component) => component.id === "section:focus:provenance:0"));
});
