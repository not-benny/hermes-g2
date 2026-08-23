import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function loadRollbackPolicy() {
  const source = readFileSync(new URL("../app/ui/shell/dynamic-app-rollback.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

test("displaced assistant rollback requires exact live ownership", async () => {
  const { shouldRestoreDisplacedAssistant } = await loadRollbackPolicy();
  const valid = {
    ownsLayer: true,
    screenOn: true,
    displayAvailable: true,
    operationCurrent: true,
    assistantSlotEmpty: true,
    assistantRetained: true,
  };
  assert.equal(shouldRestoreDisplacedAssistant(valid), true);
  for (const key of Object.keys(valid)) {
    assert.equal(shouldRestoreDisplacedAssistant({ ...valid, [key]: false }), false, key);
  }
});
