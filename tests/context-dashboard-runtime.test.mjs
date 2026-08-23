import assert from "node:assert/strict";
import test from "node:test";
import { ContextDashboardAgent, ContextDashboardRuntime, projectLiverpoolLimeStreetDepartures } from "../hermes-host/context-dashboard-runtime.mjs";

const identity = { profile: "even-g2", device: "phone-1", connectionGeneration: "socket-1", turnGeneration: "turn-1" };

test("Liverpool acceptance projector keeps all destinations and sorts by expected departure", () => {
  const projected = projectLiverpoolLimeStreetDepartures({
    stationName: "Liverpool Lime Street",
    sourceLabel: "Rail feed",
    observedAtMs: 1_000_000,
    nowMs: 1_000_000,
    departures: [
      { id: "late", destination: "London Euston", scheduledDepartureMs: 2_000_000, expectedDepartureMs: 2_400_000, status: "delayed", platform: "7" },
      { id: "first", destination: "Manchester Airport", scheduledDepartureMs: 1_800_000, expectedDepartureMs: 1_800_000, status: "on_time", platform: "6" },
      { id: "cancelled", destination: "Wigan North Western", scheduledDepartureMs: 1_900_000, expectedDepartureMs: 1_900_000, status: "cancelled" },
      { id: "fallback", destination: "Chester", scheduledDepartureMs: 2_100_000, status: "unknown" },
      { id: "departed", destination: "Crewe", scheduledDepartureMs: 900_000, expectedDepartureMs: 900_000, status: "departed" },
    ],
  });
  assert.deepEqual(projected.sections[0].rows.map((row) => row.destination), [
    "Manchester Airport", "Wigan North Western", "Chester", "London Euston",
  ]);
  assert.equal(projected.summary.primary, "Next: 01:30 Manchester Airport");
  assert.equal(projected.announcement.policy, "once_when_useful");
  assert.deepEqual(projected.local_actions.map((action) => action.kind), ["refresh", "pin", "follow_up"]);
});

test("runtime acknowledges loading before gathering and streams first useful content on the same refresh generation", async () => {
  const calls = [];
  let release;
  const gather = new Promise((resolve) => { release = resolve; });
  const phone = { callTool: async (name, args) => {
    calls.push({ name, args });
    if (name.endsWith("begin")) return { status: "acknowledged", dashboard_id: "dashboard_abcdefghijkl", presentation_generation: 1, refresh_generation: 1, revision: 1, frame_id: 10 };
    if (name.endsWith("publish")) return { status: "acknowledged", dashboard_id: args.dashboard_id, presentation_generation: 1, refresh_generation: 1, revision: 2, frame_id: 11 };
    throw new Error(`unexpected ${name}`);
  } };
  const runtime = new ContextDashboardRuntime({ phone, now: () => 1_000_000 });
  const opening = runtime.open(identity, {
    operationId: "rail-open", dashboardKey: "rail-liverpool-lime-street", title: "Liverpool Lime Street", privacy: "private",
    intent: "When is the next train at Liverpool Lime Street?", refreshPolicy: { mode: "on_visible", min_interval_seconds: 60 },
    gather: async () => gather,
    project: projectLiverpoolLimeStreetDepartures,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "glasses.context_dashboard.begin");
  release({ stationName: "Liverpool Lime Street", sourceLabel: "Rail feed", observedAtMs: 1_000_000, nowMs: 1_000_000,
    departures: [{ id: "one", destination: "Manchester Airport", scheduledDepartureMs: 1_800_000, expectedDepartureMs: 1_800_000, status: "on_time" }] });
  const receipt = await opening;
  assert.equal(calls[1].name, "glasses.context_dashboard.publish");
  assert.equal(calls[1].args.refresh_generation, 1);
  assert.equal(receipt.revision, 2);
});

test("runtime is dedicated-profile and read-only fail closed", async () => {
  const runtime = new ContextDashboardRuntime({ phone: { callTool: async () => { throw new Error("must not call"); } } });
  await assert.rejects(() => runtime.open({ ...identity, profile: "default" }, {
    operationId: "x", dashboardKey: "x", title: "X", privacy: "private", intent: "X",
    refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, gather: async () => ({}), project: () => ({}),
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
    revision: 2, kind: "refresh", intent: "When is the next train at Liverpool Lime Street?",
    dashboard_key: "rail-liverpool-lime-street", title: "Liverpool Lime Street", privacy: "private",
  }, {
    operationId: "local-refresh", gather: async () => ({ stationName: "Liverpool Lime Street", sourceLabel: "Rail feed",
      observedAtMs: 1_000_000, nowMs: 1_000_000, departures: [] }), project: projectLiverpoolLimeStreetDepartures,
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
  const runtime = new ContextDashboardRuntime({ phone, usefulDeadlineMs: 10 });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => runtime.open(identity, { operationId: "aborted", dashboardKey: "x", title: "X", privacy: "private", intent: "X",
    refreshPolicy: { mode: "manual", min_interval_seconds: 30 }, signal: aborted.signal, gather: async () => ({}), project: () => ({}) }), /cancelled/);
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

test("dedicated agent automatically maps the mandatory ordinary train question to the read-only dashboard runtime", async () => {
  const calls = [];
  const agent = new ContextDashboardAgent({
    runtime: { open: async (owner, options) => { calls.push({ owner, options }); return { revision: 2, announcement: "Train summary" }; } },
    readers: { railDepartures: async () => ({ departures: [] }) },
  });
  const result = await agent.handleQuestion(identity, "When is the next train at Liverpool Lime Street?");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.dashboardKey, "rail-liverpool-lime-street");
  assert.equal((await calls[0].options.gather()).stationName, "Liverpool Lime Street");
  assert.equal(result.announcement, "Train summary");
  assert.equal(await agent.handleQuestion(identity, "Tell me a joke"), null);
});
