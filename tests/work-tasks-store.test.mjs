import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const nativeStubUrl = dataUrl(`
  export const getStringSetting = (_key, fallback) => fallback;
  export const hasStoredSecretSetting = () => false;
  export const onSettingsStoreChanged = () => () => {};
  export const removeSecretSetting = () => {};
  export const setStringSetting = () => {};
`);
const source = transpile(readFileSync(new URL("../app/work-tasks/store.ts", import.meta.url), "utf8"))
  .replace('"../native/settings-store"', JSON.stringify(nativeStubUrl));
const {
  MAX_WORK_TASKS,
  MAX_WORK_TASKS_ENCODED_BYTES,
  WorkTasksError,
  WorkTasksStore,
  decodeWorkTasksDocument,
  normalizeWorkTaskTitle,
} = await import(dataUrl(source));

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function setup(options = {}) {
  let encoded = options.encoded ?? "";
  let present = options.present ?? Boolean(encoded);
  let purgeFails = options.purgeFails ?? false;
  let saveFails = options.saveFails ?? false;
  let changeListener = null;
  let id = 0;
  const writes = [];
  const purges = [];
  const persistence = {
    hasStoredValue: () => present,
    load: () => encoded,
    save: (value) => {
      if (saveFails) throw new Error("synthetic save failure with private content");
      writes.push(value);
      encoded = value;
      present = true;
    },
    purge: () => {
      purges.push(true);
      if (purgeFails) throw new Error("synthetic purge failure");
      encoded = "";
      present = false;
    },
    subscribe: (listener) => {
      changeListener = listener;
      return () => { if (changeListener === listener) changeListener = null; };
    },
  };
  const store = new WorkTasksStore({
    persistence,
    digest: sha256,
    createTaskId: () => `wt_${String(++id).padStart(32, "0")}`,
    now: () => 1_800_000_000_000 + id,
  });
  return {
    store, writes, purges,
    setPurgeFails: (value) => { purgeFails = value; },
    setSaveFails: (value) => { saveFails = value; },
    replaceStored: (value, isPresent = Boolean(value)) => {
      encoded = value;
      present = isPresent;
      changeListener?.();
    },
    encoded: () => encoded,
  };
}

const add = (store, operationId = "voice.task-1", title = "Email Simon about the merger permissions", lane) =>
  store.addTask({ operationId, title, lane });

test("add commits encrypted document before publishing observable state and returns an exact receipt", () => {
  let store;
  const observedDuringCommit = [];
  let encoded = "";
  const persistence = {
    hasStoredValue: () => Boolean(encoded),
    load: () => encoded,
    save: (value) => {
      observedDuringCommit.push(store.snapshot());
      encoded = value;
    },
    purge: () => { encoded = ""; },
  };
  store = new WorkTasksStore({
    persistence,
    digest: sha256,
    createTaskId: () => "wt_0123456789abcdef0123456789abcdef",
    now: () => 1_800_000_000_000,
  });
  const emissions = [];
  store.onChange((snapshot) => emissions.push(snapshot));
  const receipt = add(store);
  assert.deepEqual(receipt, {
    status: "acknowledged",
    operation_id: "voice.task-1",
    task_id: "wt_0123456789abcdef0123456789abcdef",
    lane: "inbox",
    board_revision: 1,
  });
  assert.deepEqual(observedDuringCommit, [{ available: true, revision: 0, tasks: [] }]);
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].tasks[0].title, "Email Simon about the merger permissions");
  assert.ok(decodeWorkTasksDocument(encoded));
});

test("operation tombstones persist only hashes and retries are historically idempotent", () => {
  const { store, writes, encoded } = setup();
  const first = add(store, "model.op-email-simon");
  store.moveTask(first.task_id, "doing");
  store.deleteTask(first.task_id);
  const retry = add(store, "model.op-email-simon");
  assert.deepEqual(retry, { ...first, status: "historical_acknowledgement" });
  assert.equal(writes.length, 3, "historical acknowledgement does not rewrite storage");
  const raw = JSON.parse(encoded());
  assert.equal(raw.operations[0].operationHash, sha256("model.op-email-simon"));
  assert.equal(raw.operations[0].digest, sha256("Email Simon about the merger permissions\0inbox"));
  assert.equal(JSON.stringify(raw).includes("model.op-email-simon"), false);
  assert.equal(Object.hasOwn(raw.operations[0], "operationId"), false);
});

test("same operation hash with a different payload conflicts without changing the board", () => {
  const { store, writes } = setup();
  add(store, "stable-op", "First title");
  assert.throws(() => add(store, "stable-op", "Different title"), (error) => error instanceof WorkTasksError && error.code === "operation_conflict");
  assert.equal(writes.length, 1);
  assert.equal(store.snapshot().tasks[0].title, "First title");
});

test("authorization guard and failed secure writes leave memory and listeners untouched", () => {
  const guarded = setup();
  let guardChecks = 0;
  assert.throws(
    () => guarded.store.addTask({ operationId: "revoked", title: "Private task" }, () => { guardChecks++; return false; }),
    (error) => error.code === "superseded",
  );
  assert.equal(guardChecks, 1);
  assert.equal(guarded.writes.length, 0);
  assert.deepEqual(guarded.store.snapshot().tasks, []);

  const failed = setup({ saveFails: true });
  let emissions = 0;
  failed.store.onChange(() => emissions++);
  assert.throws(() => add(failed.store), (error) => error.code === "persistence_failed");
  assert.equal(emissions, 0);
  assert.equal(failed.store.snapshot().revision, 0);
  assert.deepEqual(failed.store.snapshot().tasks, []);
});

test("titles are NFC one-line bounded inert text and reject all agreed bidi controls", () => {
  assert.equal(normalizeWorkTaskTitle("  Cafe\u0301 / https://example.test  "), "Café / https://example.test");
  for (const title of [
    "line\nbreak", "line\rbreak", "bad\u0000control", "bad\u0085control",
    "\nleading newline", "trailing newline\n", "\tleading tab", "trailing C1\u0085",
    "bad\u061cmark", "bad\u200emark", "bad\u200fmark", "bad\u2028line", "bad\u2029paragraph",
    "bad\u202aoverride", "bad\u202eoverride", "bad\u2066isolate", "bad\u2069isolate",
    `bad${String.fromCharCode(0xd800)}surrogate`, "x".repeat(121), "😀".repeat(121),
  ]) {
    assert.throws(() => normalizeWorkTaskTitle(title), (error) => error.code === "invalid_title", JSON.stringify(title));
  }
  assert.throws(() => normalizeWorkTaskTitle("界".repeat(161)), (error) => error.code === "invalid_title");
});

test("malformed, future-version, and oversized nonempty documents are preserved unavailable", () => {
  for (const encoded of [
    "{not-json",
    JSON.stringify({ version: 2, revision: 0, tasks: [], operations: [] }),
    "x".repeat(MAX_WORK_TASKS_ENCODED_BYTES + 1),
  ]) {
    const state = setup({ encoded, present: true });
    assert.equal(state.purges.length, 0);
    assert.deepEqual(state.store.snapshot(), { available: false, revision: 0, tasks: [] });
    assert.equal(state.encoded(), encoded);
    assert.throws(() => add(state.store), (error) => error.code === "unavailable");
    assert.equal(state.writes.length, 0);
  }
});

test("explicit invalid-data reset stays unavailable on purge failure and can be retried", () => {
  const state = setup({ encoded: "{corrupt", present: true, purgeFails: true });
  assert.equal(state.store.snapshot().available, false);
  assert.equal(state.purges.length, 0);
  assert.throws(() => state.store.discardUnreadableData(), (error) => error.code === "persistence_failed");
  assert.throws(() => add(state.store), (error) => error.code === "unavailable");
  assert.equal(state.writes.length, 0);
  state.setPurgeFails(false);
  state.store.discardUnreadableData();
  add(state.store, "after-recovery", "Recovered task");
  assert.equal(state.store.snapshot().available, true);
  assert.equal(state.store.snapshot().tasks.length, 1);
  assert.equal(state.purges.length, 2);
});

test("present-but-unreadable encrypted state is never interpreted as an empty board", () => {
  const state = setup({ encoded: "", present: true });
  assert.equal(state.store.snapshot().available, false);
  assert.throws(() => add(state.store), (error) => error.code === "unavailable");
  assert.equal(state.writes.length, 0);
  state.store.discardUnreadableData();
  assert.equal(state.purges.length, 1);
  assert.equal(state.store.snapshot().available, true);
  add(state.store, "after-user-reset", "Fresh task");
  assert.equal(state.writes.length, 1);
});

test("an unreadable transition clears previously loaded task titles from observable memory", () => {
  const state = setup();
  add(state.store, "private-op", "SENTINEL private merger title");
  assert.match(JSON.stringify(state.store.snapshot()), /SENTINEL/);
  state.replaceStored("", true);
  assert.deepEqual(state.store.snapshot(), { available: false, revision: 0, tasks: [] });
  assert.doesNotMatch(JSON.stringify(state.store.snapshot()), /SENTINEL/);
  assert.equal(state.writes.length, 1, "read failure never overwrites the existing secret");
});

test("strict decoder rejects unknown fields, duplicate identities, and over-capacity documents", () => {
  const state = setup();
  add(state.store);
  const valid = JSON.parse(state.encoded());
  assert.ok(decodeWorkTasksDocument(JSON.stringify(valid)));
  assert.equal(decodeWorkTasksDocument(JSON.stringify({ ...valid, hidden: true })), null);
  assert.equal(decodeWorkTasksDocument(JSON.stringify({ ...valid, tasks: [valid.tasks[0], valid.tasks[0]] })), null);
  assert.equal(decodeWorkTasksDocument(JSON.stringify({ ...valid, operations: [valid.operations[0], valid.operations[0]] })), null);
  assert.equal(decodeWorkTasksDocument(JSON.stringify({
    ...valid,
    tasks: Array.from({ length: MAX_WORK_TASKS + 1 }, (_, index) => ({
      ...valid.tasks[0], id: `wt_${index.toString(16).padStart(32, "0")}`,
    })),
  })), null);
});

test("GUI mutations move, block, rename, delete, and clear done through durable commits", () => {
  const state = setup();
  const a = add(state.store, "a", "A");
  const b = add(state.store, "b", "B", "today");
  state.store.advanceTask(a.task_id);
  state.store.setBlocked(a.task_id, true);
  state.store.renameTask(a.task_id, "A renamed");
  state.store.moveTask(a.task_id, "done");
  state.store.moveTask(b.task_id, "done");
  assert.equal(state.store.clearDone(), 2);
  assert.deepEqual(state.store.snapshot().tasks, []);
  assert.equal(state.store.snapshot().revision, 8);
  assert.equal(state.writes.length, 8);
});

test("task mutations remain reloadable when the phone clock moves backwards", () => {
  let encoded = "";
  let now = 2_000;
  const persistence = {
    hasStoredValue: () => Boolean(encoded),
    load: () => encoded,
    save: (value) => { encoded = value; },
    purge: () => { encoded = ""; },
  };
  const dependencies = {
    persistence,
    digest: sha256,
    createTaskId: () => "wt_abcdefabcdefabcdefabcdefabcdefab",
    now: () => now,
  };
  const first = new WorkTasksStore(dependencies);
  const receipt = add(first, "clock-op", "Original title");
  assert.equal(first.snapshot().tasks[0].createdAtMs, 2_000);

  now = 1_000;
  first.moveTask(receipt.task_id, "today");
  first.setBlocked(receipt.task_id, true);
  first.renameTask(receipt.task_id, "Renamed after rollback");
  assert.equal(first.snapshot().tasks[0].updatedAtMs, 2_000);

  const reloaded = new WorkTasksStore(dependencies);
  assert.equal(reloaded.snapshot().available, true);
  assert.deepEqual(reloaded.snapshot().tasks[0], {
    id: receipt.task_id,
    title: "Renamed after rollback",
    lane: "today",
    blocked: true,
    createdAtMs: 2_000,
    updatedAtMs: 2_000,
  });
});
