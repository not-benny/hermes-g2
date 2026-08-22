import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const binary = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const sha256 = (path) => createHash("sha256").update(binary(path)).digest("hex");
const pngSize = (path) => {
  const data = binary(path);
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
};

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
  assert.equal(
    pkg.scripts.build,
    "npx --no-install ns build android",
  );

  const config = read("nativescript.config.ts");
  assert.match(config, /id:\s*["']com\.faceclaw\.app["']/);

  const strings = read("App_Resources/Android/src/main/res/values/strings.xml");
  assert.match(strings, /<string name="app_name">Hermes G2<\/string>/);
  assert.match(strings, /<string name="title_activity_kimera">Hermes G2<\/string>/);
});

test("Android builds pin the CLI version and use an audited serializer override", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(pkg.devDependencies.nativescript, "9.0.7");
  assert.equal(pkg.engines.node, ">=20.0.0");
  assert.equal(pkg.overrides["serialize-javascript"], "7.1.0");
  assert.equal(lock.packages["node_modules/nativescript"].version, "9.0.7");
  assert.match(lock.packages["node_modules/nativescript"].integrity, /^sha512-/);
  assert.equal(lock.packages["node_modules/serialize-javascript"].version, "7.1.0");
  assert.match(lock.packages["node_modules/serialize-javascript"].integrity, /^sha512-/);
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
  assert.match(readme, /Complete first-time setup in Even before handing the\s+devices over to Hermes/i);
  assert.match(readme, /Keep the Even app installed/i);
  assert.match(readme, /disable its Bluetooth\s+permission/i);
  assert.match(readme, /Do not uninstall Even yet/i);
  assert.match(readme, /based on \[Faceclaw\]\(https:\/\/github\.com\/jimrandomh\/faceclaw\)/i);
  assert.match(readme, /GNU General Public License, version 3|GPLv3/i);

  const privacy = read("PRIVACY");
  assert.match(privacy, /^# Hermes G2 Privacy Policy/);
  assert.match(privacy, /Hermes Agent bridge/);
  assert.match(privacy, /direct-provider fallback/i);
});

test("Android launcher assets use reviewed Hermes art at every density", () => {
  const densities = {
    mdpi: [48, 108],
    hdpi: [72, 162],
    xhdpi: [96, 216],
    xxhdpi: [144, 324],
    xxxhdpi: [192, 432],
  };
  const approvedHashes = {
    mdpi: ["ff75ac5f1e4ca006e1c5eabfdfaeed5e167d0476263845305ced38f8c4609265", "b03ba6157ef4bc9a5965912516ea2ff04e49bd9c583dbfb92f9c6f3982d9d1eb"],
    hdpi: ["13997a3c2df857764b94d2f482fea6936d8fc7fb7eb78bbad93058d2a3a53878", "6ddd7f8468d671155fcb0151566b082cd63a38a490d0c7d315694e274c6d4050"],
    xhdpi: ["821ab3cb5fa53fb7fb5d10b1eab8d401a54ff4b0c7697fd2a55351a8d74b4255", "ada47c79bac40d8daeb99e8df5101e6ee0e613b88d2290174545fd2a3d5963ca"],
    xxhdpi: ["ed506dfb6daaaa78111f5b9788974f96f174bb0179bdbdc606ba6272811fe1f9", "cda3dd242cc4f47a00eb7286a5800f94499b88e53d8e28d5e80bc9bcd43006dd"],
    xxxhdpi: ["aef3df28449f43ea96e0196a44c75d7c0e377f81fbcc86709bd7df17e59543b0", "e0a8fb729fa0b3e79341356a79b89e50695688de47cb8868cf7c60546e9b9d6a"],
  };
  for (const [density, [legacySize, foregroundSize]] of Object.entries(densities)) {
    const root = `App_Resources/Android/src/main/res/mipmap-${density}`;
    assert.deepEqual(pngSize(`${root}/ic_launcher.png`), [legacySize, legacySize]);
    assert.deepEqual(pngSize(`${root}/ic_launcher_foreground.png`), [foregroundSize, foregroundSize]);
    assert.deepEqual(
      [sha256(`${root}/ic_launcher.png`), sha256(`${root}/ic_launcher_foreground.png`)],
      approvedHashes[density],
    );
  }

  const adaptive = read("App_Resources/Android/src/main/res/mipmap-anydpi-v26/ic_launcher.xml");
  assert.match(adaptive, /@mipmap\/ic_launcher_foreground/);
  assert.match(adaptive, /@color\/ic_launcher_background/);
  assert.notEqual(
    sha256("App_Resources/Android/src/main/res/mipmap-xxxhdpi/ic_launcher.png"),
    "01b6be7d5d399cac9594e8e48653d83616caa96223e6181ec4c4955cfd2ace01",
  );
});
