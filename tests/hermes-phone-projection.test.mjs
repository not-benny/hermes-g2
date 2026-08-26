import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/phone-ui/hermes-phone-projection.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { projectHermesSessions, projectHermesStatus, relativeAge } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

const emptyCockpit = {
  synchronized: false,
  commandsAvailable: false,
  connectionGeneration: null,
  sequence: 0,
  sessions: [],
  lastReceipt: null,
};

test("Hermes phone status distinguishes transport, Host MCP synchronization, and ready state", () => {
  assert.deepEqual(projectHermesStatus({ phase: "idle", status: "Not connected." }, emptyCockpit), {
    ready: false,
    label: "Hermes not connected",
    detail: "Configure the private bridge, then return here. No actions are queued while offline.",
  });
  assert.equal(projectHermesStatus({ phase: "connecting", status: "Authenticating..." }, emptyCockpit).label,
    "Connecting to Hermes");
  assert.equal(projectHermesStatus({ phase: "failed", status: "Certificate rejected" }, emptyCockpit).detail,
    "Certificate rejected");
  assert.equal(projectHermesStatus({ phase: "connected", status: "Connected" }, emptyCockpit).label,
    "Hermes is synchronizing");
  assert.equal(projectHermesStatus({ phase: "connected", status: "Connected" },
    { ...emptyCockpit, synchronized: true }).ready, true);
});

test("Hermes phone sessions prioritize attention and expose only the validated summary projection", () => {
  const base = {
    session_id: "session_1234567890", generation: 1, revision: 1, updated_at_ms: 120_000,
    timeline: [], pending: [],
  };
  const rows = projectHermesSessions({
    synchronized: true, connectionGeneration: "connection_123456", sequence: 1, lastReceipt: null,
    sessions: [
      { ...base, title: "Finished run", state: "completed", summary: "All checks passed", updated_at_ms: 180_000 },
      { ...base, session_id: "session_attention_1", title: "Approval needed", state: "waiting_human",
        timeline: [{ id: "row_assistant_1234", kind: "assistant", text: "Choose a target", status: "done" }],
        pending: [{ request_id: "request_12345678", nonce: "nonce_1234567890", kind: "question",
          title: "Which target?", expires_at_ms: 999_999,
          choices: [{ id: "choice_123456789", label: "Focused" }] }] },
    ],
  }, 240_000);
  assert.deepEqual(rows.map((row) => row.title), ["Approval needed", "Finished run"]);
  assert.equal(rows[0].stateLabel, "Needs you");
  assert.equal(rows[0].attentionLabel, "1 item needs review on the glasses");
  assert.equal(rows[0].summary, "Choose a target");
  assert.equal(rows[1].summary, "All checks passed");

  const retainedButStale = projectHermesSessions({
    synchronized: false, connectionGeneration: null, sequence: 1, lastReceipt: null,
    sessions: [{ ...base, title: "Last known run", state: "running" }],
  }, 240_000);
  assert.deepEqual(retainedButStale, [], "an unsynchronized retained projection is never shown as live");
});

test("relative Hermes ages remain compact without locale-dependent formatting", () => {
  assert.equal(relativeAge(null, 100_000), "Never");
  assert.equal(relativeAge(90_000, 100_000), "Just now");
  assert.equal(relativeAge(40_000, 100_000), "1m ago");
  assert.equal(relativeAge(100_000 - 2 * 60 * 60_000, 100_000), "2h ago");
});
