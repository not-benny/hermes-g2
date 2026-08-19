import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("missing R1 standard battery service produces a safe GATT UUID diagnostic", () => {
  const manager = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleManager.java");
  const communicator = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");

  assert.match(manager, /describeServices\(/);
  assert.match(manager, /properties=/);
  assert.match(communicator, /services=/);
});
