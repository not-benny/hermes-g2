import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const harness = new URL("../hermes-host/private-evaluation.mjs", import.meta.url);

test("private HA harness is read-only by default and documents the explicit reversible mutation gate", () => {
  const help = spawnSync(process.execPath, [harness.pathname, "--help"], { encoding: "utf8", env: {} });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /read-only/i);
  assert.match(help.stdout, /--apply/);
  assert.match(help.stdout, /--restore/);
  assert.ok(!help.stdout.includes("HA_TOKEN"));

  const missing = spawnSync(process.execPath, [harness.pathname], { encoding: "utf8", env: {} });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /server-side environment/i);
});
