import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/g2/connection-state-lifecycle.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { shouldFinalizeCommunicatorClose } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);

test("a delayed initial disconnected snapshot cannot detach a live connect attempt", () => {
  assert.equal(shouldFinalizeCommunicatorClose("connecting", "disconnected", true), false);
});

test("only terminal cleanup while already disconnecting releases communicator ownership", () => {
  assert.equal(shouldFinalizeCommunicatorClose("disconnecting", "disconnected", true), true);
  assert.equal(shouldFinalizeCommunicatorClose("connected", "disconnected", true), false);
  assert.equal(shouldFinalizeCommunicatorClose("disconnecting", "disconnected", false), false);
  assert.equal(shouldFinalizeCommunicatorClose("disconnecting", "retrying", true), false);
});
