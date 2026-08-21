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

test("display policy accepts bounded inert text and trims it", () => {
  assert.equal(validateDisplayText("  Battery 80%  "), "Battery 80%");
  assert.equal(validateDisplayText("x".repeat(MAX_ALERT_TEXT_LENGTH)), "x".repeat(MAX_ALERT_TEXT_LENGTH));
});

test("display policy rejects malformed, oversized, and executable-looking content", () => {
  for (const value of ["", "x".repeat(MAX_ALERT_TEXT_LENGTH + 1), "<b>hello</b>", "https://example.test", "a\u0000b", 7, null]) {
    assert.equal(validateDisplayText(value), null, String(value));
  }
});