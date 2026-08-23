import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const { HermesCockpitAdapter } = await import(new URL("../tools/hermes-cockpit-adapter.mjs", import.meta.url));

function setup() {
  const adapter = new HermesCockpitAdapter({ now: () => 1000 });
  adapter.connect("connection_A_12345");
  adapter.share({ publicSessionId: "session_public_1234", hermesSessionId: "hermes-private-session", generation: 3, title: "Disposable task" });
  return adapter;
}

test("adapter snapshots only explicitly shared sessions and never exports Hermes private IDs", () => {
  const adapter = setup();
  adapter.observeSession("unshared-private", { running: true, title: "Hidden task" });
  const frame = adapter.snapshot();
  assert.equal(frame.sessions.length, 1);
  assert.equal(frame.sessions[0].session_id, "session_public_1234");
  assert.equal(JSON.stringify(frame).includes("hermes-private-session"), false);
  assert.equal(JSON.stringify(frame).includes("unshared-private"), false);
});

test("tool and text events project bounded summaries without arguments, results, reasoning, prompts, or secrets", () => {
  const adapter = setup();
  const tool = adapter.ingest({ type: "tool.start", session_id: "hermes-private-session", data: {
    tool_id: "provider-call-secret", name: "read_file", args: { path: "/private/sentinel" }, result: "sentinel-result",
  } }, 3);
  assert.equal(tool.type, "timeline_append");
  assert.match(tool.row.text, /^read_file/);
  const encoded = JSON.stringify(tool);
  assert.equal(encoded.includes("/private/sentinel"), false);
  assert.equal(encoded.includes("sentinel-result"), false);
  assert.equal(encoded.includes("provider-call-secret"), false);

  const delta = adapter.ingest({ type: "message.delta", session_id: "hermes-private-session", data: {
    redacted: true, cockpit_text: "Working safely",
  } }, 3);
  assert.equal(delta.row.text, "Working safely");
  assert.equal(adapter.ingest({ type: "reasoning.delta", session_id: "hermes-private-session", data: { text: "hidden" } }, 3), null);
  assert.equal(adapter.ingest({ type: "message.delta", session_id: "unshared", data: { text: "hidden" } }, 3), null);
});

test("clarify requests use opaque handles and stale answer races cannot reach Hermes RPC", () => {
  const adapter = setup();
  const opened = adapter.ingest({ type: "clarify.request", session_id: "hermes-private-session", data: {
    request_id: "provider-request-private", question: "Which test target?", options: ["Unit", "Full"],
  } }, 3);
  assert.equal(opened.type, "interaction_open");
  assert.equal(JSON.stringify(opened).includes("provider-request-private"), false);
  assert.equal(adapter.ingest({ type: "clarify.request", session_id: "hermes-private-session", data: {
    request_id: "provider-request-private", question: "Which test target?", options: ["Unit", "Full"],
  } }, 3), null, "duplicate provider request is deduplicated before projection");
  const choice = opened.request.choices[0];
  const command = {
    v: 1, chan: "cockpit", type: "answer", command_id: "command_answer_1234",
    connection_generation: "connection_A_12345",
    session_id: "session_public_1234", generation: 3, request_id: opened.request.request_id,
    nonce: opened.request.nonce, choice_id: choice.id,
  };
  assert.deepEqual(adapter.handleCommand(command, (rpc) => rpc), {
    jsonrpc: "2.0", id: "command_answer_1234", method: "clarify.respond",
    params: { session_id: "hermes-private-session", request_id: "provider-request-private", answer: "Unit" },
  });
  assert.equal(adapter.handleCommand(command, (rpc) => rpc), null, "one-shot replay is inert");

  const replacement = adapter.share({ publicSessionId: "session_public_1234", hermesSessionId: "hermes-private-session", generation: 4, title: "Disposable task" });
  assert.equal(replacement.generation, 4);
  assert.equal(adapter.handleCommand({ ...command, command_id: "command_late_12345" }, (rpc) => rpc), null);
});

test("permissions are typed exact-scope or deny-only when scope cannot be represented", () => {
  const adapter = setup();
  const supported = adapter.ingest({ type: "approval.request", session_id: "hermes-private-session", data: {
    request_id: "provider-approval-read", cockpit_scope: {
      action: "read_file", target: "README.md", effect: "Read one bounded repository file",
    },
  } }, 3);
  assert.deepEqual(supported.request.choices, ["deny", "allow_once"]);
  const allow = {
    v: 1, chan: "cockpit", type: "permission_decide", command_id: "command_allow_12345",
    connection_generation: "connection_A_12345",
    session_id: "session_public_1234", generation: 3, request_id: supported.request.request_id,
    nonce: supported.request.nonce, decision: "allow_once",
  };
  assert.deepEqual(adapter.handleCommand(allow, (rpc) => rpc), {
    jsonrpc: "2.0", id: "command_allow_12345", method: "approval.respond",
    params: { session_id: "hermes-private-session", request_id: "provider-approval-read", choice: "once", all: false },
  });

  const unsupported = adapter.ingest({ type: "approval.request", session_id: "hermes-private-session", data: {
    request_id: "provider-approval-raw", command: "rm -rf /private/sentinel", args: { secret: "sentinel" },
  } }, 3);
  assert.deepEqual(unsupported.request.choices, ["deny"]);
  assert.equal(JSON.stringify(unsupported).includes("sentinel"), false);
});

test("steer and interrupt revalidate current shared generation immediately before exact RPC", () => {
  const adapter = setup();
  assert.deepEqual(adapter.handleCommand({
    v: 1, chan: "cockpit", type: "steer", command_id: "command_steer_1234",
    connection_generation: "connection_A_12345",
    session_id: "session_public_1234", generation: 3, text: "Run focused tests",
  }, (rpc) => rpc), { jsonrpc: "2.0", id: "command_steer_1234", method: "session.steer",
    params: { session_id: "hermes-private-session", text: "Run focused tests" } });
  assert.deepEqual(adapter.handleCommand({
    v: 1, chan: "cockpit", type: "interrupt", command_id: "command_stop_12345",
    connection_generation: "connection_A_12345",
    session_id: "session_public_1234", generation: 3,
  }, (rpc) => rpc), { jsonrpc: "2.0", id: "command_stop_12345", method: "session.interrupt",
    params: { session_id: "hermes-private-session" } });
  adapter.disconnect();
  assert.equal(adapter.handleCommand({
    v: 1, chan: "cockpit", type: "interrupt", command_id: "command_offline_123",
    connection_generation: "connection_A_12345",
    session_id: "session_public_1234", generation: 3,
  }, (rpc) => rpc), null);
});

test("reconnect revokes old commands and delayed old-generation events never route to a replacement", () => {
  const adapter = setup();
  const opened = adapter.ingest({ type: "approval.request", session_id: "hermes-private-session", data: {
    request_id: "provider-reconnect", cockpit_scope: { action: "read_file", target: "README.md", effect: "Read one file" },
  } }, 3);
  const command = { v: 1, chan: "cockpit", type: "permission_decide", command_id: "command_old_conn_1",
    connection_generation: "connection_A_12345", session_id: "session_public_1234", generation: 3,
    request_id: opened.request.request_id, nonce: opened.request.nonce, decision: "allow_once" };
  adapter.disconnect();
  adapter.connect("connection_B_12345");
  adapter.snapshot();
  assert.equal(adapter.handleCommand(command, (rpc) => rpc), null);
  adapter.share({ publicSessionId: "session_public_1234", hermesSessionId: "hermes-private-session", generation: 4, title: "Replacement" });
  assert.equal(adapter.ingest({ type: "session.completed", session_id: "hermes-private-session", data: {} }, 3), null);
  assert.equal(adapter.snapshot().sessions[0].state, "running");
});

test("same-generation identity rebind is rejected and interrupt or terminal state is monotonic", () => {
  const adapter = setup();
  assert.throws(() => adapter.share({ publicSessionId: "session_public_1234", hermesSessionId: "different-private", generation: 3, title: "Collision" }));
  const stop = { v: 1, chan: "cockpit", type: "interrupt", command_id: "command_monotonic_1",
    connection_generation: "connection_A_12345", session_id: "session_public_1234", generation: 3 };
  adapter.handleCommand(stop, (rpc) => rpc);
  adapter.observeSession("hermes-private-session", { state: "completed" });
  assert.equal(adapter.snapshot().sessions[0].state, "interrupted");
  adapter.share({ publicSessionId: "session_public_1234", hermesSessionId: "hermes-private-session", generation: 3, title: "Reconnect" });
  assert.equal(adapter.snapshot().sessions[0].state, "interrupted", "same generation cannot revive on reconnect");
  assert.equal(adapter.observeSession("hermes-private-session", { state: "running" }), null);
  assert.throws(() => adapter.share({ publicSessionId: "session_alias_12345", hermesSessionId: "hermes-private-session", generation: 4, title: "Alias" }));
});

test("monotonic expiry, redacted text projection, and restart journal fail closed", () => {
  let wall = 10_000;
  let monotonic = 1_000;
  const adapter = new HermesCockpitAdapter({ now: () => wall, monotonicNow: () => monotonic });
  adapter.connect("connection_A_12345");
  adapter.share({ publicSessionId: "session_public_1234", hermesSessionId: "hermes-private-session", generation: 3, title: "Disposable" });
  assert.equal(adapter.ingest({ type: "message.complete", session_id: "hermes-private-session", data: {
    text: "token=privacy-sentinel-secret",
  } }, 3), null, "raw assistant text is never projected");
  const opened = adapter.ingest({ type: "approval.request", session_id: "hermes-private-session", data: {
    request_id: "provider-expiry", cockpit_scope: { action: "read_file", target: "README.md", effect: "Read one file" },
  } }, 3);
  const command = { v: 1, chan: "cockpit", type: "permission_decide", command_id: "command_expiry_123",
    connection_generation: "connection_A_12345", session_id: "session_public_1234", generation: 3,
    request_id: opened.request.request_id, nonce: opened.request.nonce, decision: "allow_once" };
  monotonic = 70_000;
  wall = 1;
  assert.equal(adapter.handleCommand(command, (rpc) => rpc), null, "wall-clock rollback cannot revive expiry");

  adapter.observeSession("hermes-private-session", { state: "running" });
  const steer = { v: 1, chan: "cockpit", type: "steer", command_id: "command_crash_1234",
    connection_generation: "connection_A_12345", session_id: "session_public_1234", generation: 3, text: "Focused tests" };
  assert.equal(adapter.handleCommand(steer, () => { throw new Error("synthetic crash"); }), null);
  const restarted = new HermesCockpitAdapter({ journal: adapter.exportJournal() });
  restarted.connect("connection_A_12345");
  restarted.share({ publicSessionId: "session_public_1234", hermesSessionId: "hermes-private-session", generation: 3, title: "Disposable" });
  assert.equal(restarted.handleCommand(steer, (rpc) => rpc), null, "reserved command never redispatches after restart");
});

test("deterministic fake fixture covers duplicate, reconnect, expiry, malformed, cancellation, and process death", () => {
  const fixture = JSON.parse(readFileSync(new URL("fixtures/hermes-cockpit-events.json", import.meta.url), "utf8"));
  assert.deepEqual(fixture.cases.map((item) => item.name), [
    "ordered-run", "duplicate-question", "answered-elsewhere", "stale-generation", "expired-request",
    "disconnect-reconnect", "interrupt-completion-race", "process-death", "malformed-oversized", "privacy-sentinel",
  ]);
});

test("local fake adapter exercises snapshot, event projection, and exact action RPC over JSON lines", () => {
  const input = [
    { op: "share", publicSessionId: "session_public_1234", hermesSessionId: "private-session", generation: 1, title: "Fake run" },
    { op: "snapshot" },
    { op: "event", generation: 1, event: { type: "tool.start", session_id: "private-session", data: { name: "read_file", args: { secret: "privacy-sentinel" } } } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
  const run = spawnSync(process.execPath, [new URL("../tools/hermes-cockpit-fake-adapter.mjs", import.meta.url).pathname], {
    input, encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const output = run.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(output[1].type, "snapshot");
  assert.equal(output[2].type, "timeline_append");
  assert.equal(run.stdout.includes("privacy-sentinel"), false);
});
