import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a ring long-press from sleep wakes directly into assistant voice capture", () => {
  const shell = read("app/ui/shell/shell.ts");
  const input = shell.slice(shell.indexOf("async receiveInput("), shell.indexOf("foregroundWindow():", shell.indexOf("async receiveInput(")));
  const sleeping = input.indexOf("if (!this.screenOn)", input.indexOf("cancelEscapeMenuTimer"));
  const voice = input.indexOf('event.type === "long-press" && voiceControlEnabledSetting.get()');
  assert.ok(voice >= 0 && voice < sleeping, "sleep long-press voice routing must run before the screen-off short circuit");
  const route = input.slice(voice, sleeping);
  assert.match(route, /this\.wake\("sidebar"\)/);
  assert.match(route, /this\.openVoiceDialog\(\{ defaultTarget: "assistant" \}\)/);
  assert.match(input, /this\.activeVoiceLayer\?\.endCapture\(\)/, "release must finish push-to-talk capture");
});

test("quick-close mode replaces the crowded status bar with explicit gesture guidance", () => {
  const chrome = read("app/ui/shell/chrome-layer.ts");
  const topBar = chrome.slice(chrome.indexOf("private drawTopBar("), chrome.indexOf("private drawTopBarBatteries", chrome.indexOf("private drawTopBar(")));
  assert.match(topBar, /if \(state\.closing\)/);
  assert.match(topBar, /CLOSE MODE/);
  assert.match(topBar, /swipe choose/);
  assert.match(topBar, /tap close/);
  assert.match(topBar, /dbl exit/);
  assert.match(topBar, /HIDE HEALTH/);
  assert.match(topBar, /tap hide/);
  assert.match(topBar, /PINNED APP/);
  assert.match(chrome, /closingAction/);
  const sidebar = read("app/ui/shell/shell.ts");
  assert.match(sidebar, /window === this\.healthWindow[\s\S]*this\.setHealthHidden\(true\)/);
});

test("the glasses HUD reads and renders bounded phone cellular signal bars without a new phone-state permission", () => {
  const signal = read("app/native/phone-signal.ts");
  const chrome = read("app/ui/shell/chrome-layer.ts");
  const manifest = read("App_Resources/Android/src/main/AndroidManifest.xml");
  assert.match(signal, /getSignalStrength/);
  assert.match(signal, /getLevel\(\)/);
  assert.match(signal, /Math\.max\(0, Math\.min\(4/);
  assert.match(signal, /catch/);
  assert.match(chrome, /readPhoneSignalLevel/);
  assert.match(chrome, /drawPhoneSignalBars/);
  assert.doesNotMatch(manifest, /READ_PHONE_STATE/);
});
