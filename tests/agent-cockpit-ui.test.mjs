import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/agent-cockpit/view-model.ts", import.meta.url), "utf8")
  .replace('import type { CockpitInteraction, CockpitSession, CockpitSnapshot } from "./protocol";', "");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { CockpitViewModel } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const question = {
  request_id: "request_question_1234", nonce: "nonce_question_12345", kind: "question", title: "Which test?",
  expires_at_ms: 9999, choices: [{ id: "choice_unit_12345", label: "Unit" }, { id: "choice_full_12345", label: "Full" }],
};
const permission = {
  request_id: "request_permission_1", nonce: "nonce_permission_123", kind: "permission", title: "Read file?",
  expires_at_ms: 9999, action: "read_file", target: "README.md", effect: "Read one bounded file", choices: ["deny", "allow_once"],
};
const sessions = [
  { session_id: "session_running_123", generation: 2, revision: 1, title: "Build cockpit", state: "running", updated_at_ms: 2000,
    timeline: [{ id: "timeline_tool_1234", kind: "tool", text: "test · running", status: "running" }], pending: [] },
  { session_id: "session_waiting_123", generation: 5, revision: 1, title: "Review docs", state: "waiting_human", updated_at_ms: 1000,
    timeline: [], pending: [question, permission] },
];
const state = { synchronized: true, sequence: 1, sessions, lastReceipt: null };

function setup() {
  const calls = [];
  const model = new CockpitViewModel({
    answer: (...args) => (calls.push(["answer", ...args]), true),
    decidePermission: (...args) => (calls.push(["permission", ...args]), true),
    steer: (...args) => (calls.push(["steer", ...args]), true),
    interrupt: (...args) => (calls.push(["interrupt", ...args]), true),
  });
  model.update(state);
  return { model, calls };
}

test("active list prioritizes needs-you work and opens bounded run detail", () => {
  const { model } = setup();
  assert.equal(model.screen().mode, "active");
  assert.deepEqual(model.screen().rows.map((row) => row.label), ["Needs you (2)", "Review docs", "Build cockpit"]);
  model.click();
  assert.equal(model.screen().mode, "inbox");
  model.back();
  model.scroll(1);
  model.click();
  assert.equal(model.screen().mode, "detail");
  assert.match(model.screen().title, /^Review docs/);
});

test("question requires answer review before exact choice is sent", () => {
  const { model, calls } = setup();
  model.click();
  model.click();
  assert.equal(model.screen().mode, "question");
  model.scroll(1);
  model.click();
  assert.equal(model.screen().mode, "answer_review");
  assert.match(model.screen().body.join(" "), /Full/);
  assert.deepEqual(calls, []);
  model.click();
  assert.deepEqual(calls, [["answer", "session_waiting_123", 5, "request_question_1234", "choice_full_12345"]]);
  assert.equal(model.screen().mode, "submitting");
  model.update({ ...state, sequence: 2, lastReceipt: { commandId: "opaque", outcome: "accepted" } });
  assert.equal(model.screen().mode, "detail", "an authoritative receipt leaves the no-repeat submitting state");
});

test("permission defaults to deny and requires a separate review click", () => {
  const { model, calls } = setup();
  model.click();
  model.scroll(1);
  model.click();
  assert.equal(model.screen().mode, "permission_review");
  assert.match(model.screen().body.join(" "), /README\.md/);
  model.click();
  assert.equal(model.screen().mode, "permission_decision");
  assert.equal(model.screen().rows[0].label, "Deny");
  model.click();
  assert.deepEqual(calls, [["permission", "session_waiting_123", 5, "request_permission_1", "deny"]]);
});

test("reviewed voice steering and interrupt remain bound to the opened generation", () => {
  const { model, calls } = setup();
  model.scroll(1);
  model.scroll(1);
  model.click();
  assert.equal(model.screen().mode, "detail");
  assert.equal(model.beginSteer(), true);
  model.reviewSteer("Run only the focused tests");
  assert.equal(model.screen().mode, "steer_review");
  assert.deepEqual(calls, []);
  model.click();
  assert.deepEqual(calls, [["steer", "session_running_123", 2, "Run only the focused tests"]]);

  model.update({ ...state, sessions: [{ ...sessions[0], generation: 3 }, sessions[1]] });
  model.back();
  assert.equal(model.interruptCurrent(), false, "generation replacement retires opened detail authority");
});

test("offline state makes every mutation inert", () => {
  const { model, calls } = setup();
  model.update({ ...state, synchronized: false });
  assert.equal(model.screen().mode, "offline");
  assert.equal(model.interruptCurrent(), false);
  assert.equal(model.beginSteer(), false);
  assert.deepEqual(calls, []);
});

test("native app is launcher-registered, subscribes to the main-isolate controller, and keeps voice steering reviewed", () => {
  const apps = readFileSync(new URL("../app/apps/all-apps.ts", import.meta.url), "utf8");
  const index = readFileSync(new URL("../app/apps/agent-cockpit/index.ts", import.meta.url), "utf8");
  const cockpit = readFileSync(new URL("../app/apps/agent-cockpit/agent-cockpit-app.ts", import.meta.url), "utf8");
  const windows = readFileSync(new URL("../app/ui/shell/in-process-window.ts", import.meta.url), "utf8");
  assert.match(apps, /import agentCockpitApp from "\.\/agent-cockpit"/);
  assert.match(apps, /terminalApp,\s*\n\s*agentCockpitApp,/);
  assert.match(index, /appId: "agent-cockpit"/);
  assert.match(cockpit, /assistantBridge\.cockpit\.onChange/);
  assert.match(cockpit, /reviewSteer\(text\)/);
  assert.match(cockpit, /interruptCurrent\(\)/);
  assert.match(windows, /receiveTextInput\?: \(text: string\) => void/);
  assert.match(windows, /receiveTextInput: options\.receiveTextInput/);
});
