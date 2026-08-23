import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { HermesCompanionAdapter } from "../tools/hermes-companion-adapter.mjs";

const opaque = (prefix, source) => `${prefix}_${createHash("sha256").update(String(source)).digest("hex").slice(0, 24)}`;
const raw = {
  status: "ready", metadata_redacted: true, model: "hermes-3", profile: "voice",
  last_connected_at_ms: 900,
  capabilities: { voice: true, usage: true, cost: true, tool_activity: true },
  sessions: [
    { id: "provider-session-private", generation: 7, title: "Safe title", title_redacted: true,
      prompt: "privacy-sentinel-prompt", state: "active", updated_at_ms: 950, resumable: true },
    { id: "provider-session-other", generation: 3, title: "privacy-sentinel-title", title_redacted: false,
      state: "completed", updated_at_ms: 800, resumable: true },
  ],
  voice: { utterance_count: 3, audio_ms: 9_000, stt_provider: "local", capture_state: "idle",
    recent_failures: [{ id: "private-error", at_ms: 700, code: "stt_timeout", summary: "privacy-sentinel-error", redacted: false }] },
  usage: { currency: "gbp", day: { input_tokens: 10, output_tokens: 20, cost_micros: 100 },
    seven_days: { input_tokens: 100, output_tokens: 200, cost_micros: 1_000 } },
  tool_activity: [{ id: "private-tool", label: "Read file", redacted: true, status: "failed", updated_at_ms: 980,
    error_code: "read_failed", args: { bearer: "privacy-sentinel-token" }, result: "privacy-sentinel-payload" }],
  recent_errors: [{ id: "private-global-error", at_ms: 600, code: "gateway_error",
    summary: "Safe summary", redacted: true, raw: "privacy-sentinel-log" }],
};

test("adapter emits bounded metadata only and keeps provider identities and raw payloads private", () => {
  const adapter = new HermesCompanionAdapter({ now: () => 1_000, createOpaque: opaque });
  adapter.connect("connection_adapter_1234");
  const frame = adapter.snapshot(raw);
  assert.equal(frame.sessions[0].title, "Safe title");
  assert.equal(frame.sessions[1].title, "Hermes session");
  assert.equal(frame.sessions[0].resumable, false, "active sessions are never projected resumable");
  assert.equal(frame.usage.day.total_tokens, 30);
  assert.equal(frame.usage.day.currency, "GBP");
  assert.equal(frame.voice.recent_failures[0].summary, "Voice operation failed");
  assert.equal(frame.tool_activity[0].error_code, "read_failed");
  const encoded = JSON.stringify(frame);
  for (const forbidden of ["provider-session-private", "provider-session-other", "privacy-sentinel", "prompt", "args", "result", "bearer"]) {
    assert.equal(encoded.includes(forbidden), false, `${forbidden} must not cross the adapter boundary`);
  }
  const unreviewed = adapter.snapshot({ ...raw, metadata_redacted: false,
    model: "privacy-sentinel-model", profile: "privacy-sentinel-profile",
    voice: { ...raw.voice, stt_provider: "privacy-sentinel-stt" } });
  assert.equal(unreviewed.model, undefined);
  assert.equal(unreviewed.profile, undefined);
  assert.equal(unreviewed.voice.stt_provider, "Unavailable");
  assert.equal(JSON.stringify(unreviewed).includes("privacy-sentinel"), false);
});

test("adapter maps only fixed RPCs after durable and final generation checks", () => {
  const reserved = [];
  const sent = [];
  const adapter = new HermesCompanionAdapter({ now: () => 1_000, createOpaque: opaque,
    reserveOperation: (record) => { reserved.push(record); return true; } });
  adapter.connect("connection_adapter_1234");
  const frame = adapter.snapshot(raw);
  const active = frame.sessions[0], completed = frame.sessions[1];
  const cancel = { v: 1, chan: "companion", connection_generation: "connection_adapter_1234",
    type: "cancel_session", operation_id: "operation_cancel_1234", session_id: active.session_id, generation: 7 };
  assert.equal(adapter.handleCommand(cancel, (rpc) => { sent.push(rpc); return true; }), true);
  assert.deepEqual(sent[0], { jsonrpc: "2.0", id: "operation_cancel_1234", method: "session.cancel",
    params: { session_id: "provider-session-private", expected_generation: 7 } });
  assert.equal(reserved.length, 1);
  assert.equal(adapter.handleCommand({ ...cancel, operation_id: "operation_stale_12345", generation: 6 }, () => true), null);
  const resume = { ...cancel, type: "resume_session", operation_id: "operation_resume_1234",
    session_id: completed.session_id, generation: 3 };
  assert.equal(adapter.handleCommand(resume, (rpc) => { sent.push(rpc); return true; }), true);
  assert.equal(sent[1].method, "session.resume");
  assert.equal(adapter.handleCommand({ ...cancel, operation_id: "operation_extra_12345", arbitrary: true }, () => true), null);
  assert.equal(JSON.stringify(sent).includes(active.session_id), false, "public IDs do not reach the private gateway");
});

test("durable duplicate replay never redispatches and failed reservation is inert", () => {
  const adapter = new HermesCompanionAdapter({ now: () => 1_000, createOpaque: opaque, reserveOperation: () => true });
  adapter.connect("connection_adapter_1234");
  adapter.snapshot(raw);
  const command = { v: 1, chan: "companion", connection_generation: "connection_adapter_1234",
    type: "new_voice_session", operation_id: "operation_voice_12345" };
  let dispatches = 0;
  adapter.handleCommand(command, () => { dispatches++; return true; });
  const restarted = new HermesCompanionAdapter({ journal: adapter.exportJournal(), reserveOperation: () => true });
  restarted.connect("connection_adapter_1234");
  assert.equal(restarted.handleCommand(command, () => { dispatches++; return true; }), null);
  assert.equal(restarted.replayReceipt(command).outcome, "outcome_unknown");
  assert.equal(dispatches, 1);

  const denied = new HermesCompanionAdapter({ reserveOperation: () => false });
  denied.connect("connection_adapter_5678");
  assert.equal(denied.handleCommand({ ...command, connection_generation: "connection_adapter_5678",
    operation_id: "operation_denied_1234" }, () => { dispatches++; }), null);
  assert.equal(dispatches, 1);
});

test("provider identity projections are pruned after a session leaves the bounded snapshot", () => {
  let sequence = 0;
  const adapter = new HermesCompanionAdapter({
    now: () => 1_000,
    createOpaque: (prefix) => `${prefix}_projection_${++sequence}`,
  });
  adapter.connect("connection_adapter_1234");
  const provider = { status: "ready", capabilities: {}, sessions: [
    { id: "private-session", generation: 1, updated_at_ms: 900, state: "completed", resumable: true },
  ] };
  const first = adapter.snapshot(provider).sessions[0].session_id;
  adapter.snapshot({ status: "ready", capabilities: {}, sessions: [] });
  const second = adapter.snapshot(provider).sessions[0].session_id;
  assert.notEqual(second, first);
});
