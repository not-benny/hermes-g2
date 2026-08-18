import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const forbiddenBrand = /\b(?:Faceclaw|OpenClaw)\b/i;

function assertNoLegacyBrand(path, allowedPatterns = []) {
  const lines = read(path).split("\n");
  const offenders = lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(
      ({ line }) =>
        forbiddenBrand.test(line) && !allowedPatterns.some((pattern) => pattern.test(line)),
    );
  assert.deepEqual(
    offenders,
    [],
    `${path} contains legacy user-visible branding:\n${offenders
      .map(({ number, line }) => `${number}: ${line}`)
      .join("\n")}`,
  );
}

test("package and Android labels identify Hermes G2 without changing the internal Java package", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "hermes-g2");
  assert.equal(pkg.description, "Hermes Agent interface for Even Realities G2 smart glasses");

  const config = read("nativescript.config.ts");
  assert.match(config, /id:\s*["']com\.faceclaw\.app["']/);

  const strings = read("App_Resources/Android/src/main/res/values/strings.xml");
  assert.match(strings, /<string name="app_name">Hermes G2<\/string>/);
  assert.match(strings, /<string name="title_activity_kimera">Hermes G2<\/string>/);
});

test("onboarding, assistant UI, settings, and phone chrome contain only Hermes branding", () => {
  for (const path of [
    "app/phone-ui/onboarding-view-model.ts",
    "app/phone-ui/onboarding-firmware-check-view-model.ts",
    "app/phone-ui/onboarding-flash-view-model.ts",
    "app/phone-ui/onboarding-unpair-page.xml",
    "app/phone-ui/main-page.xml",
    "app/ui/dashboard-settings.ts",
    "app/ui/dashboard/settings-menus.ts",
  ]) {
    assertNoLegacyBrand(path);
  }
  assertNoLegacyBrand("app/g2/firmware-compat.ts", [/faceclaw-communicator/]);

  assert.match(read("app/phone-ui/onboarding-view-model.ts"), /headline:\s*"Hermes G2"/);
  assert.match(read("app/ui/dashboard/settings-menus.ts"), /"Hermes G2"/);
});

test("Hermes Agent bridge is the preferred backend and direct providers remain a fallback", () => {
  const settings = read("app/ui/dashboard-settings.ts");
  assert.match(settings, /external:\s*"Hermes Agent \(bridge\)"/);
  assert.match(settings, /direct:\s*"Direct provider \(fallback\)"/);
  assert.match(settings, /defaultValue:\s*"external"/);
  assert.match(settings, /values:\s*\["external",\s*"direct"\]/);
  assert.match(settings, /label:\s*"Hermes Agent host"/);
  assert.match(settings, /label:\s*"Hermes Agent token"/);
});

test("MCP and device identities are Hermes G2 while websocket protocol v1 stays compatible", () => {
  const mcp = read("app/assistant/mcp-server.ts");
  assert.match(mcp, /serverInfo:\s*\{\s*name:\s*"hermes-g2",\s*version:\s*"1\.0\.0"\s*\}/);

  const bridge = read("app/assistant/bridge-client.ts");
  assert.match(bridge, /const PROTOCOL_VERSION = 1;/);
  assert.match(bridge, /JSON\.stringify\(\{ v: PROTOCOL_VERSION, \.\.\.frame \}\)/);

  assert.match(read("app/g2/dashboard-controller.ts"), /deviceName:\s*"hermes-g2"/);
  assert.match(read("app/apps/terminal/terminal-app.worker.ts"), /const DEVICE_NAME = "Hermes G2";/);
});

test("user-visible Android notifications and network identity use Hermes G2", () => {
  const foreground = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawForegroundService.java",
  );
  assert.match(foreground, /"Hermes G2 dashboard"/);
  assert.doesNotMatch(foreground, /"Faceclaw dashboard"/i);
  assert.doesNotMatch(foreground, /Keeps the Faceclaw dashboard/i);

  const timers = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawTimerNotifications.java",
  );
  assert.match(timers, /"Alerts when a Hermes G2 timer finishes\."/);

  const communicator = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java",
  );
  assert.doesNotMatch(communicator, /cause Faceclaw write failures|reconnect Faceclaw/);
  assert.match(communicator, /cause Hermes G2 write failures/);

  const weather = read("app/native/weather.ts");
  assert.match(weather, /"User-Agent": "Hermes-G2\/1\.0/);
});

test("README and privacy lead with Hermes while preserving upstream and GPL attribution", () => {
  const readme = read("README.md");
  assert.match(readme, /^# Hermes G2\b/);
  assert.match(readme, /Hermes Agent bridge/);
  assert.match(readme, /based on \[Faceclaw\]\(https:\/\/github\.com\/jimrandomh\/faceclaw\)/i);
  assert.match(readme, /GNU General Public License, version 3|GPLv3/i);

  const privacy = read("PRIVACY");
  assert.match(privacy, /^# Hermes G2 Privacy Policy/);
  assert.match(privacy, /Hermes Agent bridge/);
  assert.match(privacy, /direct-provider fallback/i);
});
