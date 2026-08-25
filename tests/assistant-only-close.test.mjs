import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../app/ui/shell/assistant-only-close.ts", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { deferAssistantOnlyAnswerClose } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);
const shellSource = readFileSync(
  new URL("../app/ui/shell/shell.ts", import.meta.url),
  "utf8",
);

const drainMicrotasks = () => new Promise((resolve) => queueMicrotask(resolve));

test("an old isolated dashboard close cannot blank an in-flight replacement wake", async () => {
  const state = {
    isolated: true,
    replacement: false,
    continuation: true,
    screenOn: false,
    sleeps: 0,
    releases: 0,
  };
  const lifecycle = {
    isIsolated: () => state.isolated,
    hasReplacement: () => state.replacement,
    hasAssistantContinuation: () => state.continuation,
    isScreenOn: () => state.screenOn,
    sleep: () => { state.sleeps++; state.screenOn = false; },
    releaseIsolation: () => { state.releases++; state.isolated = false; },
  };

  // Closing the prior card schedules teardown. Before that microtask runs,
  // the follow-up's atomic-final path acquires its provisional blank wake.
  deferAssistantOnlyAnswerClose(lifecycle);
  state.screenOn = true;
  await drainMicrotasks();

  assert.equal(state.sleeps, 0);
  assert.equal(state.releases, 0);
  assert.equal(state.screenOn, true);
  assert.equal(state.isolated, true);

  // Installing the final replacement makes the stale close inert even after
  // the assistant turn itself reaches terminal state.
  state.continuation = false;
  state.replacement = true;
  deferAssistantOnlyAnswerClose(lifecycle);
  await drainMicrotasks();
  assert.equal(state.sleeps, 0);
  assert.equal(state.releases, 0);
});

test("an idle dismissed isolated answer still returns to darkness", async () => {
  const calls = [];
  const state = { isolated: true, replacement: false, continuation: false, screenOn: true };
  const lifecycle = {
    isIsolated: () => state.isolated,
    hasReplacement: () => state.replacement,
    hasAssistantContinuation: () => state.continuation,
    isScreenOn: () => state.screenOn,
    sleep: () => {
      calls.push("sleep");
      state.screenOn = false;
      state.isolated = false;
    },
    releaseIsolation: () => { calls.push("release"); state.isolated = false; },
  };

  deferAssistantOnlyAnswerClose(lifecycle);
  await drainMicrotasks();
  assert.deepEqual(calls, ["sleep"]);

  state.isolated = true;
  state.screenOn = false;
  deferAssistantOnlyAnswerClose(lifecycle);
  await drainMicrotasks();
  assert.deepEqual(calls, ["sleep", "release"]);
});

test("shell binds the deferred close to exact live assistant continuation state", () => {
  const clear = shellSource.slice(
    shellSource.indexOf("clearDynamicApp("),
    shellSource.indexOf("closeDynamicApp()", shellSource.indexOf("clearDynamicApp(")),
  );
  assert.match(clear, /deferAssistantOnlyAnswerClose\(\{/);
  assert.match(clear, /hasReplacement: \(\) => this\.dynamicAppLayer !== null/);
  assert.match(clear, /hasAssistantContinuation:[\s\S]*this\.assistantTurnBackgrounded[\s\S]*this\.assistantLayer[\s\S]*this\.pendingAssistantResult[\s\S]*this\.assistantSession\?\.isTurnActive\(\)/);
  assert.ok(
    clear.indexOf("hasAssistantContinuation") < clear.indexOf("sleep: () => this.sleep()"),
    "the stale close must revalidate continuation ownership before sleeping",
  );
});
