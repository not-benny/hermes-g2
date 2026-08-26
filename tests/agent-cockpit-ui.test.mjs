import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const protocolSource = readFileSync(new URL("../app/agent-cockpit/protocol.ts", import.meta.url), "utf8");
const protocolJs = ts.transpileModule(protocolSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const protocolUrl = "data:text/javascript;base64," + Buffer.from(protocolJs).toString("base64");
const source = readFileSync(new URL("../app/agent-cockpit/view-model.ts", import.meta.url), "utf8")
  .replace('from "./protocol";', `from ${JSON.stringify(protocolUrl)};`);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { CockpitViewModel } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

const graphicsRoot = new URL("../app/graphics/", import.meta.url);
const graphicsSource = (name) => readFileSync(new URL(name, graphicsRoot), "utf8").replace(/^import .*;\n/gm, "");
const graphicsJs = ts.transpileModule([
  graphicsSource("emoji-fallback.ts"),
  graphicsSource("bdffont.ts"),
  graphicsSource("textwrap.ts"),
  graphicsSource("image.ts"),
].join("\n"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { BdfFont, GrayImage, wrapText } = await import(
  "data:text/javascript;base64," + Buffer.from(graphicsJs).toString("base64")
);

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
const state = {
  synchronized: true,
  commandsAvailable: true,
  connectionGeneration: "connection_123456",
  sequence: 1,
  sessions,
  lastReceipt: null,
};
const reviewFingerprint = (request) => request.kind === "question"
  ? JSON.stringify([request.kind, request.request_id, request.nonce, request.title,
      request.expires_at_ms, request.choices.map((choice) => [choice.id, choice.label])])
  : request.kind === "text_question"
    ? JSON.stringify([request.kind, request.request_id, request.nonce, request.title,
        request.expires_at_ms, request.max_length])
  : JSON.stringify([request.kind, request.request_id, request.nonce, request.title,
      request.expires_at_ms, request.action, request.target, request.effect, request.choices]);

function setup() {
  const calls = [];
  const model = new CockpitViewModel({
    refresh: () => (calls.push(["refresh"]), true),
    answer: (...args) => (calls.push(["answer", ...args]), "command_answer_1234"),
    answerText: (...args) => (calls.push(["answerText", ...args]), "command_text_12345"),
    decidePermission: (...args) => (calls.push(["permission", ...args]), "command_permission_1"),
    steer: (...args) => (calls.push(["steer", ...args]), "command_steer_1234"),
    interrupt: (...args) => (calls.push(["interrupt", ...args]), "command_stop_12345"),
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
  assert.deepEqual(calls, [["answer", "session_waiting_123", 5, "request_question_1234", "choice_full_12345",
    question.nonce, reviewFingerprint(question)]]);
  assert.equal(model.screen().mode, "submitting");
  model.update({ ...state, sequence: 2, lastReceipt: { commandId: "unrelated", sessionId: "other", generation: 1, outcome: "accepted" } });
  assert.equal(model.screen().mode, "submitting", "an unrelated receipt cannot unlock submitting");
  model.update({ ...state, sequence: 3, lastReceipt: { commandId: "command_answer_1234", sessionId: "session_waiting_123", generation: 5, outcome: "accepted" } });
  assert.equal(model.screen().mode, "detail", "an authoritative receipt leaves the no-repeat submitting state");
});

test("an explicit unknown outcome exits submitting even while projection resyncs", () => {
  const { model } = setup();
  model.click();
  model.click();
  model.click();
  model.click();
  assert.equal(model.screen().mode, "submitting");
  model.update({
    ...state,
    synchronized: false,
    sequence: 9,
    lastReceipt: {
      commandId: "command_answer_1234",
      sessionId: "session_waiting_123",
      generation: 5,
      outcome: "outcome_unknown",
      code: "receipt_timeout",
    },
  });
  assert.equal(model.screen().mode, "submission_error");
  assert.match(model.screen().body.join(" "), /Do not retry/);
});

test("permission defaults to deny and requires a separate review click", () => {
  const { model, calls } = setup();
  model.click();
  model.scroll(1);
  model.click();
  assert.equal(model.screen().mode, "permission_review");
  assert.match(model.screen().body.join(" "), /README\.md/);
  assert.equal(model.screen().rows[0].label, "Deny", "deny is immediately available after the exact review opens");
  model.scroll(1);
  model.click();
  assert.equal(model.screen().mode, "permission_decision");
  assert.equal(model.screen().rows[0].label, "Deny");
  model.click();
  assert.deepEqual(calls, [["permission", "session_waiting_123", 5, "request_permission_1", "deny",
    permission.nonce, reviewFingerprint(permission)]]);
});

test("maximum allow-once details render fully in the real 640x480 lens geometry", () => {
  const fixed = BdfFont.parse(readFileSync(new URL("../app/fonts/terminus/ter-u12n.bdf", import.meta.url), "utf8"));
  const variable = BdfFont.parse(
    readFileSync(new URL("../app/fonts/terminusv/terv12n.bdf", import.meta.url), "utf8"),
    { fallback: fixed, minEncoding: 32 },
  );
  const safeAscii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index))
    .filter((character) => !"<>`".includes(character) && character !== " ");

  for (const font of [fixed, variable]) {
    const widest = safeAscii.reduce((current, candidate) =>
      font.measureText(candidate) > font.measureText(current) ? candidate : current, "!");
    const exact = widest.repeat(64);
    const { model } = setup();
    model.update({
      ...state,
      sessions: [{ ...sessions[1], pending: [{ ...permission, target: exact, effect: exact }] }],
    });
    model.click();
    model.click();
    const screen = model.screen();
    assert.equal(screen.mode, "permission_review");

    const width = 640;
    const height = 480;
    const left = 30;
    const bodyWidth = width - 60;
    const image = new GrayImage(width, height, 0);
    let y = 50;
    for (const paragraph of screen.body) {
      const lines = wrapText(font, paragraph, bodyWidth);
      assert.equal(lines.length, 1,
        `64 widest ${font.measureText(widest)}px glyphs plus the field label must be fully visible`);
      assert.ok(font.measureText(lines[0]) <= bodyWidth);
      image.drawText(font, left, y, lines[0], 170);
      y += font.lineHeight + 3;
    }
    y += 4 + screen.rows.length * (font.lineHeight + 8);
    assert.ok(y < height - 31, "full permission text and both deny/continue rows fit above the footer");
    assert.ok(image.to8bppBuffer().some((pixel) => pixel !== 0));
  }
});

test("a synchronized read-only projection remains browsable and makes every mutation visibly inert", () => {
  const { model, calls } = setup();
  model.update({ ...state, commandsAvailable: false });
  let screen = model.screen();
  assert.equal(screen.mode, "active");
  assert.match(screen.body.join(" "), /READ ONLY/);
  assert.match(screen.footer, /read only/);

  model.click();
  assert.equal(model.screen().mode, "inbox", "read-only sessions and requests remain inspectable");
  model.click();
  screen = model.screen();
  assert.equal(screen.mode, "question");
  assert.match(screen.body.join(" "), /READ ONLY/);
  model.click();
  assert.equal(model.screen().mode, "question", "a choice cannot enter mutating review");
  assert.equal(model.beginSteer(), false);
  assert.equal(model.interruptCurrent(), false);
  assert.deepEqual(calls, []);
});

test("a replacement under the same request id retires every prior human review", () => {
  const { model, calls } = setup();
  model.click();
  model.scroll(1);
  model.click();
  model.scroll(1);
  model.click();
  assert.equal(model.screen().mode, "permission_decision");

  const replacement = { ...permission, nonce: "nonce_replaced_12345", effect: "Write a different file" };
  model.update({ ...state, sequence: 2, sessions: [sessions[0], { ...sessions[1], pending: [question, replacement] }] });
  assert.match(model.screen().title, /REQUEST RETIRED/);
  model.scroll(1);
  model.click();
  assert.deepEqual(calls, [], "allow-once cannot be silently retargeted to a replacement nonce or scope");
});

test("steering rejects any suffix that the two-line painter could hide", () => {
  const { model, calls } = setup();
  model.scroll(1);
  model.scroll(1);
  model.click();
  assert.equal(model.beginSteer(), true);
  assert.equal(model.reviewSteer("W".repeat(65)), false);
  assert.equal(model.reviewSteer("Unicode café"), false);
  assert.deepEqual(calls, []);
});

test("free-text answers are completely visible in both real lens fonts before send", () => {
  const fixed = BdfFont.parse(readFileSync(new URL("../app/fonts/terminus/ter-u12n.bdf", import.meta.url), "utf8"));
  const variable = BdfFont.parse(
    readFileSync(new URL("../app/fonts/terminusv/terv12n.bdf", import.meta.url), "utf8"),
    { fallback: fixed, minEncoding: 32 },
  );
  const safeAscii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index))
    .filter((character) => !"<>`".includes(character) && character !== " ");
  for (const font of [fixed, variable]) {
    const widest = safeAscii.reduce((current, candidate) =>
      font.measureText(candidate) > font.measureText(current) ? candidate : current, "!");
    const exact = widest.repeat(64);
    const textRequest = {
      request_id: "request_text_12345", nonce: "nonce_text_123456", kind: "text_question",
      title: "Give Hermes a bounded answer", expires_at_ms: 9999, max_length: 64,
    };
    const { model } = setup();
    model.update({
      ...state,
      sessions: [{ ...sessions[1], pending: [textRequest] }],
    });
    model.click();
    model.click();
    assert.equal(model.screen().mode, "text_question");
    assert.equal(model.beginTextAnswer(), true);
    assert.equal(model.reviewTextAnswer(widest.repeat(65)), false,
      "a hidden 65th glyph must never enter review");
    assert.equal(model.reviewTextAnswer("Unicode café"), false,
      "review text is limited to the renderer-proven printable ASCII contract");
    assert.equal(model.reviewTextAnswer(exact), true);
    const screen = model.screen();
    assert.equal(screen.mode, "text_answer_review");
    const bodyWidth = 640 - 60;
    let y = 50;
    for (const paragraph of screen.body) {
      const lines = wrapText(font, paragraph, bodyWidth);
      assert.equal(lines.length, 1, "every reviewed answer paragraph must render without a hidden suffix");
      assert.ok(font.measureText(lines[0]) <= bodyWidth);
      y += font.lineHeight + 3;
    }
    y += 4 + screen.rows.length * (font.lineHeight + 8);
    assert.ok(y < 480 - 31, "the exact answer and both actions fit above the footer");
  }
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
  assert.deepEqual(model.screen().rows.map((row) => row.label), ["Retry secure sync"]);
  model.click();
  assert.equal(model.interruptCurrent(), false);
  assert.equal(model.beginSteer(), false);
  assert.deepEqual(calls, [["refresh"]]);
});

test("detail view never renders tool rows even when supplied outside the store", () => {
  const { model } = setup();
  model.update({ ...state, sessions: [{
    ...sessions[0],
    timeline: [
      { id: "timeline_assistant_1", kind: "assistant", text: "Earlier final", status: "done" },
      { id: "timeline_tool_hidden", kind: "tool", text: "private_tool · running", status: "running" },
      { id: "timeline_assistant_2", kind: "assistant", text: "Latest final", status: "done" },
    ],
  }] });
  model.click();
  const screen = model.screen();
  assert.equal(screen.mode, "detail");
  assert.deepEqual(screen.body, ["ASSISTANT ✓ Earlier final", "ASSISTANT ✓ Latest final"]);
  assert.equal(screen.body.join(" ").includes("private_tool"), false);
});

test("long active lists keep the selected row inside a bounded viewport", () => {
  const { model } = setup();
  const many = Array.from({ length: 24 }, (_, index) => ({
    ...sessions[0], session_id: `session_many_${String(index).padStart(3, "0")}`, title: `Run ${index}`, updated_at_ms: index,
  }));
  model.update({ ...state, sessions: many });
  for (let index = 0; index < 30; index++) model.scroll(1);
  const screen = model.screen();
  assert.equal(screen.selected, 23);
  assert.ok(screen.scrollOffset <= screen.selected);
  assert.ok(screen.selected < screen.scrollOffset + screen.visibleRows);
});

test("detail pending rows open review and interrupt requires an explicit confirmation", () => {
  const { model, calls } = setup();
  model.scroll(1);
  model.click();
  assert.equal(model.screen().mode, "detail");
  model.click();
  assert.equal(model.screen().mode, "question");
  model.back();
  model.back();
  model.scroll(1);
  model.scroll(1);
  model.click();
  assert.equal(model.screen().mode, "detail");
  model.click();
  assert.equal(model.screen().mode, "interrupt_review");
  assert.deepEqual(calls, []);
  model.scroll(1);
  model.click();
  assert.deepEqual(calls, [["interrupt", "session_running_123", 2]]);
});

test("question choices and detail actions keep bounded visible viewports", () => {
  const { model } = setup();
  const eightChoices = Array.from({ length: 8 }, (_, index) => ({ id: `choice_many_${index}_1234`, label: `Choice ${index}` }));
  model.update({ ...state, sessions: [{ ...sessions[1], pending: [{ ...question, choices: eightChoices }] }] });
  model.click();
  model.click();
  for (let index = 0; index < 10; index++) model.scroll(1);
  let screen = model.screen();
  assert.equal(screen.selected, 7);
  assert.ok(screen.selected < screen.scrollOffset + screen.visibleRows);

  model.back(); model.back();
  model.update({ ...state, sessions: [{ ...sessions[0], timeline: Array.from({ length: 40 }, (_, index) => ({
    id: `timeline_many_${index}`, kind: "tool", text: `Tool row ${index}`, status: "done",
  })) }] });
  model.click();
  screen = model.screen();
  assert.ok(screen.body.length <= 3);
  assert.equal(screen.body.some((line) => line.includes("Tool row")), false);
  assert.ok(screen.visibleRows <= 3);
});

test("cockpit is launcher registered with a dedicated Hermes icon and reviewed controller bindings", () => {
  const apps = readFileSync(new URL("../app/apps/all-apps.ts", import.meta.url), "utf8");
  const index = readFileSync(new URL("../app/apps/agent-cockpit/index.ts", import.meta.url), "utf8");
  const cockpit = readFileSync(new URL("../app/apps/agent-cockpit/agent-cockpit-app.ts", import.meta.url), "utf8");
  const windows = readFileSync(new URL("../app/ui/shell/in-process-window.ts", import.meta.url), "utf8");
  const icons = readFileSync(new URL("../app/graphics/icons.ts", import.meta.url), "utf8");
  assert.match(apps, /import agentCockpitApp from "\.\/agent-cockpit"/);
  assert.match(apps, /terminalApp,\s*\n\s*agentCockpitApp,\s*\n\s*workTasksApp,/);
  assert.match(index, /appId: "agent-cockpit"/);
  assert.match(index, /title: "Hermes Cockpit"/);
  assert.match(index, /icon: "hermes-h"/);
  assert.match(cockpit, /icon: "hermes-h"/);
  assert.doesNotMatch(index, /icon: "terminal"/);
  assert.match(icons, /"hermes-h":\s*'[^']*M6 4v16[^']*M18 4v16[^']*M6 12h12/);
  assert.match(cockpit, /assistantBridge\.cockpit\.onChange/);
  assert.match(cockpit, /assistantBridge\.refreshCockpit\(\)/);
  assert.match(cockpit, /reviewSteer\(text\)/);
  assert.match(cockpit, /mode === "active" \|\| mode === "offline"[\s\S]*shell\.yieldFocusToSidebar\(\)/);
  assert.match(cockpit, /else \{[\s\S]*this\.model\.back\(\)/);
  assert.match(windows, /receiveTextInput\?: \(text: string\) => void/);
  assert.match(windows, /receiveTextInput: options\.receiveTextInput/);
});

test("an authenticated empty snapshot is online without inventing Hermes sessions", () => {
  const { model } = setup();
  model.update({ ...state, sessions: [] });
  const screen = model.screen();
  assert.equal(screen.mode, "active");
  assert.match(screen.body.join(" "), /Connected/);
  assert.match(screen.body.join(" "), /No Hermes sessions are currently shared/);
  assert.equal(screen.rows.length, 0);
});
