import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/hermes-g2-debug-control.mjs", import.meta.url);

function fakeAdb(devices, receipt = { ok: true, command: "state", state: { online: true } }, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "g2-adb-test-"));
  const log = join(dir, "argv.jsonl");
  const adb = join(dir, "adb");
  const receiptJson = JSON.stringify(receipt);
  const wireReceipt = options.rawAndroidData ? `"${receiptJson}"` : JSON.stringify(receiptJson);
  writeFileSync(adb, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nconst args=process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+"\\n");\nif(args[0]==="devices") process.stdout.write(${JSON.stringify(`List of devices attached\n${devices}\n`)});\nelse process.stdout.write(${JSON.stringify(`Broadcasting: Intent { act=com.faceclaw.app.DEBUG_CONTROL_V1 }\nBroadcast completed: result=0, data=${wireReceipt}\n`)});\n`);
  chmodSync(adb, 0o755);
  return { adb, log };
}

function run(input, extra = {}) {
  return spawnSync(process.execPath, [script.pathname, ...(extra.args ?? [])], {
    input,
    encoding: "utf8",
    env: { ...process.env, ADB: extra.adb ?? "/missing/adb", HERMES_G2_ADB_SERIAL: extra.serial ?? "" },
  });
}

const query = JSON.stringify({ v: 1, id: "q-1", command: "state", args: {} });

test("CLI selects the sole authorized adb target and emits only the receipt JSON", () => {
  const fake = fakeAdb("USB123\tdevice product:test model:test device:test transport_id:1");
  const result = run(query, { adb: fake.adb });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, command: "state", state: { online: true } });
  assert.equal(result.stderr, "");
  const calls = readFileSync(fake.log, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls[0], ["devices", "-l"]);
  assert.deepEqual(calls[1].slice(0, 8), ["-s", "USB123", "shell", "am", "broadcast", "-W", "-a", "com.faceclaw.app.DEBUG_CONTROL_V1"]);
  assert.ok(calls[1].includes("com.faceclaw.app/com.faceclaw.app.FaceclawDebugControlReceiver"));
  assert.equal(calls[1].at(-2), "request");
  assert.equal(calls[1].at(-1), `'${query}'`);
});

test("CLI quotes JSON for the real adb remote shell without permitting quote breakout", () => {
  const fake = fakeAdb("USB123\tdevice product:test model:test device:test transport_id:1");
  const input = JSON.stringify({ v: 1, id: "q-quote", command: "state", args: { invalid: "a'b" } });
  const result = run(input, { adb: fake.adb });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(fake.log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls[1].at(-1), `'${input.replaceAll("'", "'\\''")}'`);
});

test("wireless serial override targets only that exact online device", () => {
  const fake = fakeAdb("USB123\tdevice\n192.0.2.10:37123\tdevice");
  const result = run(query, { adb: fake.adb, serial: "192.0.2.10:37123" });
  assert.equal(result.status, 0, result.stdout);
  const calls = readFileSync(fake.log, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls[1][1], "192.0.2.10:37123");
});

test("CLI parses the raw quoted JSON format emitted by Android am broadcast", () => {
  const receipt = { ok: false, code: "offline" };
  const fake = fakeAdb("USB123\tdevice", receipt, { rawAndroidData: true });
  const result = run(query, { adb: fake.adb });
  assert.equal(result.status, 5);
  assert.deepEqual(JSON.parse(result.stdout), receipt);
  assert.equal(result.stderr, "");
});

test("malformed input, ambiguous targets, stale/offline receipts, and adb failure fail closed", () => {
  for (const [input, devices, expected] of [
    ["not-json", "USB123\tdevice", "malformed-input"],
    [JSON.stringify({ ...JSON.parse(query), extra: true }), "USB123\tdevice", "malformed-input"],
    [query, "A\tdevice\nB\tdevice", "ambiguous-target"],
    [query, "A\toffline", "no-online-target"],
  ]) {
    const fake = fakeAdb(devices);
    const result = run(input, { adb: fake.adb });
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: expected });
    assert.equal(result.stderr, "");
  }

  for (const code of ["stale", "offline", "replay", "malformed"]) {
    const fake = fakeAdb("A\tdevice", { ok: false, code });
    const result = run(query, { adb: fake.adb });
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, code });
  }
});

test("oversized stdin returns one bounded receipt without a runtime warning", () => {
  const result = run("x".repeat(2050));
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: "malformed-input" });
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(result.stderr, "");
});
