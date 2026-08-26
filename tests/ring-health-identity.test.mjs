import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

test("all configured-address writers durably publish ring B before crossing the health identity boundary", () => {
  const addresses = read("app/g2/device-addresses.ts");
  const config = read("app/phone-ui/config-view-model.ts");
  const onboardingFlash = read("app/phone-ui/onboarding-flash-view-model.ts");
  const transition = addresses.indexOf("applyRingHealthIdentityChange(previousRing, normalized.ring)");
  const ringCommit = addresses.indexOf("ApplicationSettings.setString(ADDRESS_KEYS.ring, normalized.ring)");
  const ringFlush = addresses.indexOf("ApplicationSettings.flush()", ringCommit);
  const ringReadback = addresses.indexOf("const ringReadback", ringFlush);
  assert.ok(ringCommit >= 0 && ringFlush > ringCommit && ringReadback > ringFlush && transition > ringReadback,
    "address B must gate late A frames before the crash-replayable scope scrub");
  assert.match(addresses, /if \(!transition\.ok\)[\s\S]*throw new Error/);
  assert.match(addresses, /saved\.right !== normalized\.right[\s\S]*saved\.ring !== normalized\.ring/);
  assert.match(config, /saveDeviceAddresses\(\{ right, left, ring \}\)/);
  assert.match(config, /ring address may already have changed; retry Save before reconnecting/);
  assert.match(onboardingFlash, /saveDeviceAddresses\(\{ right: found\.right, left: found\.left, ring: found\.ring \|\| stored\.ring \}\)/);
});

test("process boot binds persisted health to the configured ring before any restore", () => {
  const controller = read("app/g2/dashboard-controller.ts");
  const bind = controller.indexOf("bindRingHealthIdentityAtBoot(bootRingIdentity)");
  const restore = controller.indexOf("this.healthPersistenceCoordinator.restoreInto(ringHealthStore)");
  const subscribe = controller.indexOf("ringHealthStore.onChange((snapshot)");
  assert.ok(bind >= 0 && restore > bind && subscribe > restore);
  assert.match(controller, /if \(bootHealthScope\.ok\)[\s\S]*restoreInto\(ringHealthStore\)/);
  assert.match(controller, /isRingHealthPersistenceIdentityReady\(loadDeviceAddresses\(\)\.ring\)[\s\S]*healthPersistenceCoordinator\.persist\(snapshot\)/);
  assert.match(controller, /isRingHealthPersistenceIdentityReady\(ringIdentity\)[\s\S]*recordBattery/);
});

test("a successful configured-ring transition resets the whole live store", () => {
  const identity = read("app/health/ring-health-identity.ts");
  const store = read("app/health/ring-health-store.ts");
  assert.match(identity, /transitionHealthRingIdentity\(previousRingId, nextRingId\)/);
  assert.match(identity, /verifiedRingIdentity = null[\s\S]*transitionSafely/);
  assert.match(identity, /ringHealthStore\.resetForIdentityChange\(\)[\s\S]*if \(result\.ok\) verifiedRingIdentity/);
  assert.match(store, /resetForIdentityChange\(\): void \{[\s\S]*this\.reset\(\)/);
});

test("a failed runtime scope transition closes persistence until a verified repair", async () => {
  const nativeStub = dataUrl(`
    let outcome = { ok: true, document: {} };
    let thrown = null;
    export const setOutcome = (next) => { outcome = next; };
    export const setThrown = (next) => { thrown = next; };
    export const transitionHealthRingIdentity = () => {
      if (thrown) throw thrown;
      return outcome;
    };
  `);
  const storeStub = dataUrl(`
    export let resetCount = 0;
    export const ringHealthStore = { resetForIdentityChange() { resetCount += 1; } };
  `);
  let source = ts.transpileModule(read("app/health/ring-health-identity.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  source = source.replaceAll(JSON.stringify("../native/health-store"), JSON.stringify(nativeStub));
  source = source.replaceAll(JSON.stringify("./ring-health-store"), JSON.stringify(storeStub));
  const identity = await import(dataUrl(source));
  const native = await import(nativeStub);
  const liveStore = await import(storeStub);

  assert.equal(identity.bindRingHealthIdentityAtBoot("AA:BB:CC:DD:EE:FF").ok, true);
  assert.equal(identity.isRingHealthPersistenceIdentityReady("AA:BB:CC:DD:EE:FF"), true);
  native.setOutcome({ ok: false, error: "synthetic durable scope failure" });
  assert.equal(identity.applyRingHealthIdentityChange("AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66").ok, false);
  assert.equal(identity.isRingHealthPersistenceIdentityReady("11:22:33:44:55:66"), false);
  assert.equal(liveStore.resetCount, 1, "live A metrics clear even when durable scrub fails");
  native.setOutcome({ ok: true, document: {} });
  assert.equal(identity.bindRingHealthIdentityAtBoot("11:22:33:44:55:66").ok, true);
  assert.equal(identity.isRingHealthPersistenceIdentityReady("11:22:33:44:55:66"), true);
  native.setThrown(new Error("synthetic settings exception"));
  const thrown = identity.applyRingHealthIdentityChange("11:22:33:44:55:66", "22:33:44:55:66:77");
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /synthetic settings exception/);
  assert.equal(identity.isRingHealthPersistenceIdentityReady("22:33:44:55:66:77"), false);
  assert.equal(liveStore.resetCount, 2, "unexpected adapter exceptions still clear live A metrics");
});
