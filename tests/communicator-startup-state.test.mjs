import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/native/communicator-state-gate.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUrl = "data:text/javascript;base64," + Buffer.from(js).toString("base64");
const { InitialCommunicatorStateGate } = await import(moduleUrl);

test("the native listener's initial idle replay cannot roll an active connect attempt back to disconnected", () => {
  const gate = new InitialCommunicatorStateGate();
  assert.equal(gate.accept("disconnected"), false);
  assert.equal(gate.accept("connecting"), true);
});

test("a real disconnect after the initial replay remains observable", () => {
  const gate = new InitialCommunicatorStateGate();
  gate.accept("disconnected");
  assert.equal(gate.accept("disconnected"), true);
});

test("a non-idle first native state is never suppressed", () => {
  const gate = new InitialCommunicatorStateGate();
  assert.equal(gate.accept("connecting"), true);
});
