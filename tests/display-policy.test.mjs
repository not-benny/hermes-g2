import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/assistant/display-policy.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { MAX_ALERT_TEXT_LENGTH, validateDisplayText } = await import(
  "data:text/javascript;base64," + Buffer.from(js).toString("base64")
);
globalThis.__displayPolicy = { MAX_ALERT_TEXT_LENGTH, validateDisplayText };
const handlerSource = readFileSync(new URL("../app/assistant/display-alert-handler.ts", import.meta.url), "utf8")
  .replace('import { validateDisplayText } from "./display-policy";', "const { validateDisplayText } = globalThis.__displayPolicy;")
  .replace('import type { ToolHandler } from "./tool-registry";', "");
const handlerJs = ts.transpileModule(handlerSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { createShowAlertHandler } = await import(
  "data:text/javascript;base64," + Buffer.from(handlerJs).toString("base64")
);

test("display policy accepts bounded inert text and trims it", () => {
  assert.equal(validateDisplayText("  Battery 80%  "), "Battery 80%");
  assert.equal(validateDisplayText("x".repeat(MAX_ALERT_TEXT_LENGTH)), "x".repeat(MAX_ALERT_TEXT_LENGTH));
});

test("display policy rejects malformed, oversized, and executable-looking content", () => {
  for (const value of ["", "x".repeat(MAX_ALERT_TEXT_LENGTH + 1), "<b>hello</b>", "https://example.test", "a\u0000b", 7, null]) {
    assert.equal(validateDisplayText(value), null, String(value));
  }
});

test("show_alert handler rejects unsafe or unavailable calls without side effects", async () => {
  let calls = 0;
  const handler = createShowAlertHandler({ isScreenOn: () => true, showAlert: async () => { calls++; } });
  for (const value of ["<b>secret</b>", "https://example.test", "x".repeat(MAX_ALERT_TEXT_LENGTH + 1)]) {
    const result = await handler({ text: value });
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
  const off = createShowAlertHandler({ isScreenOn: () => false, showAlert: async () => { calls++; } });
  assert.equal((await off({ text: "private sentinel" })).ok, false);
  assert.equal(calls, 0);
});

test("show_alert handler reports transport failure and only reports success after delivery", async () => {
  const delivered = [];
  const success = createShowAlertHandler({ isScreenOn: () => true, showAlert: async (text) => { delivered.push(text); } });
  assert.deepEqual(await success({ text: "Battery 80%" }), { ok: true, content: "Displayed." });
  assert.deepEqual(delivered, ["Battery 80%"]);
  const failed = createShowAlertHandler({ isScreenOn: () => true, showAlert: async () => { throw new Error("transport unavailable"); } });
  const result = await failed({ text: "Battery 80%" });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not display the alert/);
});
