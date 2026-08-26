import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the Even cloud client signs requests and reads synced ring health", () => {
  const api = read("app/native/even-api.ts");

  // Correct host + endpoints for login and the latest-health read.
  assert.match(api, /https:\/\/api\.evenrealities\.com/);
  assert.match(api, /"\/v2\/g\/login"/);
  assert.match(api, /"\/v2\/g\/health\/get_latest_data"/);

  // HMAC-SHA256 signing + AES password encryption go through native crypto.
  assert.match(api, /FaceclawEvenCrypto\.hmacSha256Base64/);
  assert.match(api, /FaceclawEvenCrypto\.aesCbcEncryptBase64/);
  assert.match(api, /function buildCanonicalString/);

  // Login stores a token and health fetches auto-(re)login.
  assert.match(api, /evenAuthTokenSetting\.set\(token\)/);
  assert.match(api, /export async function evenGetLatestHealth/);
});

test("native crypto helper provides HMAC-SHA256 and AES-256-CBC", () => {
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawEvenCrypto.java");
  assert.match(java, /HmacSHA256/);
  assert.match(java, /AES\/CBC\/PKCS5Padding/);
  assert.match(java, /hmacSha256Base64/);
  assert.match(java, /aesCbcEncryptBase64/);
});

test("Even Health is a direct-BLE readiness dashboard reachable from the Health tab", () => {
  const vm = read("app/phone-ui/even-health-view-model.ts");
  const xml = read("app/phone-ui/even-health-page.xml");
  const page = read("app/phone-ui/even-health-page.ts");
  const shell = read("app/phone-ui/shell-page.xml");
  const coordinator = read("app/health/health-persistence-coordinator.ts");

  // Store-backed (not the old Even cloud), computing insights + a readiness score.
  assert.match(vm, /ringHealthStore/);
  assert.match(vm, /readinessScore/);
  assert.match(vm, /get readinessValue\(\): string/);
  assert.match(vm, /get currentHrValue\(\): string/);
  assert.match(vm, /get batteryValue\(\): string/);
  assert.match(vm, /this\.health\.activity\?\.activeCalories/);
  assert.match(vm, /estimateActiveCalories/);
  assert.match(vm, /get caloriesMetricLabel\(\): string/);
  assert.match(xml, /\{\{ caloriesMetricLabel \}\}/);
  assert.match(xml, /\{\{ caloriesSourceLabel \}\}/);
  // The optional tab is read-only. Process-wide persistence must not depend on
  // constructing this view model during an overnight/background session.
  assert.doesNotMatch(vm, /recordHealthDay/);
  assert.doesNotMatch(vm, /recordHourly/);
  assert.match(coordinator, /export class RingHealthPersistenceCoordinator/);
  assert.match(coordinator, /this\.persistence\.recordHourly/);
  assert.match(coordinator, /this\.persistence\.recordHealthDay/);
  assert.match(coordinator, /restoreInto\(store: RestorableRingHealthStore\)/);
  // JSON export remains an explicit action in the tab.
  assert.match(vm, /shareHealthJson/);
  assert.match(vm, /toolRegistry\.fireToolsChanged\(\)/);
  assert.doesNotMatch(vm, /pushHealthToHermes|HERMES_PUSH_INTERVAL_MS|hermesTimer/);
  // Hourly accumulation is process-wide; the tab reads back the accumulated day
  // (survives empty polls + relaunches), not just the live poll.
  assert.match(vm, /hourlyForDay/);
  assert.match(vm, /sleepSessionFromRing\(this\.health\.sleep, nowMs\)/);
  // A retained tab must still advance with wall time when the ring is silent:
  // returning/resuming refreshes the pruned store snapshot, while a visible
  // minute tick crosses midnight and the bounded sleep-readiness expiry.
  assert.match(page, /\.activate\(page\)/);
  assert.match(page, /\.deactivate\?\.\(\)/);
  assert.match(vm, /Application\.resumeEvent/);
  assert.match(vm, /DISPLAY_FRESHNESS_INTERVAL_MS = 60_000/);
  assert.match(vm, /this\.health = ringHealthStore\.snapshot\(\)/);
  assert.match(vm, /hrHours\(\)/); // insights + chart read the accumulated hours
  assert.match(xml, /Export JSON/);
  assert.doesNotMatch(xml, /Export CSV/); // consolidated to a single JSON export

  // Export shares a REAL file via the FileProvider (content:// EXTRA_STREAM),
  // not the CSV text inline (EXTRA_TEXT) -- the file must land as an attachment.
  const exp = read("app/native/health-export.ts");
  assert.match(exp, /FileProvider\.getUriForFile/);
  assert.match(exp, /EXTRA_STREAM/);
  assert.doesNotMatch(exp, /EXTRA_TEXT/);
  assert.match(exp, /const \{ battery, \.\.\.document \} = loadHealthDocument\(\)/);
  assert.match(exp, /\.\.\.document, battery: exportedBattery, exportedAtMs: Date\.now\(\)/);
  assert.doesNotMatch(exp, /Http\.request|method:\s*"POST"|pushHealthToHermes/);
  const persisted = read("app/native/health-store.ts");
  assert.match(persisted, /HEALTH_STORE_KEY = "health\.store\.v1"/);
  assert.match(persisted, /export const loadActivity/);
  assert.match(persisted, /export const recordActivity/);
  assert.match(persisted, /export const loadSleep/);
  assert.match(persisted, /export const recordSleep/);
  const controller = read("app/g2/dashboard-controller.ts");
  assert.match(controller, /new RingHealthPersistenceCoordinator/);
  assert.match(controller, /this\.healthPersistenceCoordinator\.restoreInto\(ringHealthStore\)/);
  assert.match(controller,
    /ringHealthStore\.onChange\(\(snapshot\) => \{\s*if \(isRingHealthPersistenceIdentityReady\(loadDeviceAddresses\(\)\.ring\)\) \{\s*this\.healthPersistenceCoordinator\.persist\(snapshot\);\s*\}\s*\}\)/,
    "persistence consults the live verified ring-identity gate on every emission");
  assert.match(controller, /if \(bootHealthScope\.ok\) this\.healthPersistenceCoordinator\.persist\(ringHealthStore\.snapshot\(\)\)/);
  // Battery restores before connection using the currently saved ring identity,
  // while a missing/mismatched identity clears stale display state.
  assert.match(controller, /const bootRingIdentity = loadDeviceAddresses\(\)\.ring/);
  assert.match(controller, /const bootBattery = bootHealthScope\.ok \? loadBattery\(bootRingIdentity\) : null/);
  assert.match(controller, /ringHealthStore\.restoreBattery\(bootBattery\.percent, bootBattery\.updatedAtMs\)/);
  assert.match(controller, /ringHealthStore\.clearBattery\(\)/);
  assert.match(controller, /recordBattery\(ringIdentity, snapshot\.batteryPercent, snapshot\.batteryUpdatedAtMs\)/);
  const manifest = read("App_Resources/Android/src/main/AndroidManifest.xml");
  assert.match(manifest, /androidx\.core\.content\.FileProvider/);
  assert.match(manifest, /\.fileprovider/);

  // The readiness hero ring gauge is built into an AbsoluteLayout mount.
  assert.match(vm, /buildRing\(page: Page\)/);
  assert.match(xml, /id="readinessRing"/);
  assert.match(xml, /HEART RATE/);
  assert.match(xml, /class="card tile"/);
  assert.match(xml, /Allow assistant health access/);
  assert.match(vm, /no background uploads/);
  assert.match(vm, /stored locally for up to 90 days/);

  // Stylish charts: the 24h HR range chart + the readiness trend, drawn via the
  // dependency-free column-chart renderer into their AbsoluteLayout mounts.
  assert.match(vm, /renderColumnChart/);
  assert.match(vm, /paintHrChart/);
  assert.match(vm, /paintTrendChart/);
  assert.match(xml, /id="hrChart"/);
  assert.match(xml, /id="trendChart"/);
  for (const binding of ["sleepScoreSourceLabel", "sleepEfficiencyLabel", "sleepAwakeLabel", "sleepRemLabel", "sleepLightLabel", "sleepDeepLabel"]) {
    assert.match(xml, new RegExp(`\\{\\{ ${binding} \\}\\}`), binding);
  }

  // Reachable as the Health tab of the shell.
  assert.match(shell, /title="Health"/);
  assert.match(shell, /phone-ui\/even-health-page/);
});
