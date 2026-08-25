import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const dataUrl = (source) => "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const storeUrl = dataUrl(`
  export class WorkTasksError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
`);
const source = transpile(readFileSync(new URL("../app/assistant/work-board-handler.ts", import.meta.url), "utf8"))
  .replace('"../work-tasks/store"', JSON.stringify(storeUrl));
const { createWorkBoardAddHandler } = await import(dataUrl(source));
const { WorkTasksError } = await import(storeUrl);
const { BRIDGE_PINNED_PHONE_INPUT_SCHEMAS } = await import(dataUrl(transpile(
  readFileSync(new URL("../app/assistant/bridge-phone-contract-schemas.ts", import.meta.url), "utf8"),
)));

const context = {
  caller: "mcp", proactive: false, profileId: "even-g2",
  connectionGeneration: "connection-7", turnGeneration: "turn-9",
};
const args = { operation_id: "voice.task-9", title: "Email Simon about the merger permissions" };
const receipt = {
  status: "acknowledged", operation_id: args.operation_id,
  task_id: "wt_0123456789abcdef0123456789abcdef",
  lane: "inbox", board_revision: 4,
};

test("active even-g2 turns commit and receive the exact durable task receipt", () => {
  const calls = [];
  const handler = createWorkBoardAddHandler({ addTask(input, guard) {
    calls.push(input);
    assert.equal(guard(), true);
    return receipt;
  } });
  const result = handler(args, undefined, () => true, context);
  assert.deepEqual(calls, [{ operationId: args.operation_id, title: args.title, lane: undefined }]);
  assert.deepEqual(JSON.parse(result.content), receipt);
});

test("direct, proactive, unprofiled, and ownerless calls cannot mutate Work Tasks", () => {
  let calls = 0;
  const handler = createWorkBoardAddHandler({ addTask() { calls++; return receipt; } });
  for (const denied of [
    { ...context, caller: "direct" },
    { ...context, proactive: true, turnGeneration: null },
    { ...context, profileId: "custom" },
    { ...context, turnGeneration: null },
    { ...context, connectionGeneration: null },
  ]) {
    const result = handler(args, undefined, () => true, denied);
    assert.equal(result.ok, false);
    assert.match(result.error, /authenticated active turn/);
  }
  assert.equal(calls, 0);
});

test("revoked calls and malformed payloads fail before durable mutation", () => {
  let calls = 0;
  const handler = createWorkBoardAddHandler({ addTask() { calls++; return receipt; } });
  const controller = new AbortController(); controller.abort();
  assert.equal(handler(args, controller.signal, () => true, context).ok, false);
  assert.equal(handler(args, undefined, () => false, context).ok, false);
  for (const invalid of [
    {},
    { ...args, extra: true },
    { ...args, operation_id: "bad/id" },
    { ...args, lane: "done" },
    { ...args, title: 7 },
  ]) assert.equal(handler(invalid, undefined, () => true, context).ok, false);
  assert.equal(calls, 0);
});

test("store failures are coarse and operation conflicts remain actionable", () => {
  const run = (code) => createWorkBoardAddHandler({
    addTask() { throw new WorkTasksError(code); },
  })(args, undefined, () => true, context);
  assert.match(run("operation_conflict").error, /already used/);
  assert.match(run("capacity").error, /full/);
  assert.match(run("persistence_failed").error, /nothing was changed/);
  assert.doesNotMatch(run("persistence_failed").error, new RegExp(args.title, "i"));
});

test("post-commit owner loss reports uncertainty and an invalid receipt never becomes success", () => {
  let allowed = true;
  const uncertain = createWorkBoardAddHandler({ addTask() {
    allowed = false;
    return receipt;
  } })(args, undefined, () => allowed, context);
  assert.equal(uncertain.ok, false);
  assert.match(uncertain.error, /may have been saved/);

  const malformed = createWorkBoardAddHandler({ addTask() {
    return { ...receipt, task_id: "predictable-title-id" };
  } })(args, undefined, () => true, context);
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /unconfirmed result/);
});

test("system registration is bounded, active-turn-only, and cannot create Done tasks", () => {
  const system = readFileSync(new URL("../app/assistant/system-tools.ts", import.meta.url), "utf8");
  const start = system.indexOf('name: "glasses.work_board.add_task"');
  const end = system.indexOf("let renderViewManager", start);
  const registration = system.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(registration, /BRIDGE_PINNED_PHONE_INPUT_SCHEMAS\["glasses\.work_board\.add_task"\]/);
  assert.deepEqual(
    BRIDGE_PINNED_PHONE_INPUT_SCHEMAS["glasses.work_board.add_task"].properties.lane.enum,
    ["inbox", "today", "doing"],
  );
  assert.doesNotMatch(registration, /proactive:\s*true/);
  assert.match(registration, /never creates or dispatches Hermes agent work/);
  assert.equal(
    BRIDGE_PINNED_PHONE_INPUT_SCHEMAS["glasses.work_board.add_task"].additionalProperties,
    false,
  );
  assert.doesNotMatch(registration, /pattern\s*:/, "ToolRegistry rejects unsupported schema keywords before the handler");
});
