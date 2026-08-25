import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../app/notifications/app-selection.ts", import.meta.url),
  "utf8",
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
const { toggleAllowedNotificationPackage } = await import(moduleUrl);

test("explicit source action adds and removes UniFi Protect canonically", () => {
  const initial = ["com.whatsapp", "com.google.android.gm"];
  const enabled = toggleAllowedNotificationPackage(initial, "com.ubnt.unifi.protect");
  assert.deepEqual(enabled, [
    "com.google.android.gm",
    "com.ubnt.unifi.protect",
    "com.whatsapp",
  ]);
  assert.deepEqual(
    toggleAllowedNotificationPackage(enabled, "com.ubnt.unifi.protect"),
    ["com.google.android.gm", "com.whatsapp"],
  );
});

test("source action preserves other packages and fails closed for invalid names", () => {
  const selected = ["com.whatsapp", "com.whatsapp", "com.google.android.gm"];
  assert.deepEqual(
    toggleAllowedNotificationPackage(selected, "bad/package"),
    ["com.google.android.gm", "com.whatsapp"],
  );
});

test("phone UI binds separate Allow/Block and Priority actions", () => {
  const xml = readFileSync(
    new URL("../app/phone-ui/notification-apps-page.xml", import.meta.url),
    "utf8",
  );
  const model = readFileSync(
    new URL("../app/phone-ui/notification-apps-view-model.ts", import.meta.url),
    "utf8",
  );
  assert.match(xml, /tap="\{\{ onToggleTap \}\}"/);
  assert.match(xml, /tap="\{\{ onTierTap \}\}"/);
  assert.doesNotMatch(xml, /itemTap=/);
  assert.match(model, /notificationAllowedPackagesSetting\.set\(next\.join\(","\)\)/);
  assert.match(model, /setNotificationAppTier/);
});

test("notification page reactivates its settings subscription after unload", () => {
  const page = readFileSync(
    new URL("../app/phone-ui/notification-apps-page.ts", import.meta.url),
    "utf8",
  );
  const model = readFileSync(
    new URL("../app/phone-ui/notification-apps-view-model.ts", import.meta.url),
    "utf8",
  );
  assert.match(page, /export function loaded[\s\S]*model\?\.activate\(\)/);
  assert.match(page, /export function unloaded[\s\S]*model\?\.deactivate\(\)/);
  assert.match(model, /activate\(\): void[\s\S]*if \(this\.unsubscribeSettings\) return/);
});
