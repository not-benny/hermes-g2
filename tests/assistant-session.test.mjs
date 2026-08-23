import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function loadHandle() {
  const source = readFileSync(new URL("../app/assistant/turn-handle.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

test("a synchronous bridge error cannot reinstall the returned no-op turn handle", async () => {
  const { shouldInstallReturnedTurnHandle } = await loadHandle();
  const provisional = { cancel() {} };
  const returned = { cancel() {} };
  assert.equal(shouldInstallReturnedTurnHandle(provisional, provisional), true);
  assert.equal(shouldInstallReturnedTurnHandle(null, provisional), false);
  assert.notEqual(provisional, returned);
});
