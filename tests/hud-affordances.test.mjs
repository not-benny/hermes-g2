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
  assert.match(route, /this\.setAssistantOnlyPresentation\(true\)/);
  assert.match(route, /this\.wake\("sidebar"\)/);
  assert.match(route, /this\.openVoiceDialog\(\{ defaultTarget: "assistant", returnToSleepOnClose: true \}\)/);
  assert.match(input, /this\.activeVoiceLayer\?\.endCapture\(\)/, "release must finish push-to-talk capture");
});

test("an active hidden assistant turn makes sleeping push-to-talk inert", () => {
  const shell = read("app/ui/shell/shell.ts");
  const input = shell.slice(shell.indexOf("async receiveInput("), shell.indexOf("foregroundWindow():", shell.indexOf("async receiveInput(")));
  const guard = input.indexOf("A second sleeping PTT press");
  const activity = input.indexOf("this.noteUserActivity()", guard);
  const wake = input.indexOf('this.wake("sidebar")', guard);
  const route = input.slice(guard, activity);
  assert.match(route, /!this\.screenOn/);
  assert.match(route, /event\.type === "long-press"/);
  assert.match(route, /this\.assistantSession\?\.isTurnActive\(\)/);
  assert.match(route, /return \{ shell: false, window: false \}/);
  assert.ok(guard >= 0 && guard < activity && guard < wake);
});

test("sleep assistant presentation paints only its top dialogue over blank", () => {
  const layers = read("app/ui/layers.ts");
  const shell = read("app/ui/shell/shell.ts");
  assert.match(layers, /paintTopOverBlank\(\): GrayImage/);
  assert.match(layers, /new GrayImage\(this\.baseWidth, this\.baseHeight, 0\)/);
  assert.match(shell, /if \(this\.assistantOnlyPresentation\) \{[\s\S]*return this\.stack\.paintTopOverBlank\(\)/);
  assert.match(shell, /setAssistantOnlyPresentation\?: \(active: boolean\) => void/);
  assert.match(shell, /endAssistantOnlyPresentationIfIdle\(\)/);
  const dismiss = shell.slice(shell.indexOf("const dismiss = () =>"), shell.indexOf("layer = new ShellAlertLayer", shell.indexOf("const dismiss = () =>")));
  assert.match(dismiss, /this\.alertLayer === layer\) this\.alertLayer = null;[\s\S]*this\.endAssistantOnlyPresentationIfIdle\(\)/);
});

test("assistant-only wake hides opaque app surfaces and restores the foreground", () => {
  const controller = read("app/g2/dashboard-controller.ts");
  const callback = controller.slice(
    controller.indexOf("setAssistantOnlyPresentation: (active) =>"),
    controller.indexOf("    });", controller.indexOf("setAssistantOnlyPresentation: (active) =>")),
  );
  assert.match(callback, /window\.surfaceId/);
  assert.match(callback, /!active && window\.windowId === foregroundId/);
});

test("assistant-only lease blocks unrelated shell surfaces while allowing its result card", () => {
  const shell = read("app/ui/shell/shell.ts");
  assert.match(shell, /canStartDirectAssistantResultPresentation\(\): boolean[\s\S]*!this\.assistantOnlyPresentation/);
  const notifications = shell.slice(shell.indexOf("async openNotificationModal"), shell.indexOf("async openNotificationDigest"));
  assert.match(notifications, /this\.assistantOnlyPresentation/);
  const digest = shell.slice(shell.indexOf("async openNotificationDigest"), shell.indexOf("\/\*\* Whether the screen-off now-playing card"));
  assert.match(digest, /this\.assistantOnlyPresentation/);
  const music = shell.slice(shell.indexOf("openMusicCard("), shell.indexOf("private closeMusicCard"));
  assert.match(music, /this\.assistantOnlyPresentation/);
  const alert = shell.slice(shell.indexOf("async showAlert("), shell.indexOf("\/\*\* Replace the one shell-owned MCP view"));
  assert.match(alert, /assistantOnlyPresentation[\s\S]*lifetime !== "until-dismiss-or-sleep"/);
  const remote = shell.slice(shell.indexOf("async showRemoteView"), shell.indexOf("clearRemoteView"));
  assert.match(remote, /assistantOnlyPresentation/);
  const dynamic = shell.slice(shell.indexOf("async showDynamicApp"), shell.indexOf("clearDynamicApp"));
  assert.match(dynamic, /assistantOnlyPresentation/);
});

test("Window Management replaces the crowded status bar with explicit gesture guidance", () => {
  const chrome = read("app/ui/shell/chrome-layer.ts");
  const topBar = chrome.slice(chrome.indexOf("private drawTopBar("), chrome.indexOf("private drawTopBarBatteries", chrome.indexOf("private drawTopBar(")));
  assert.match(topBar, /if \(state\.closing\)/);
  assert.match(topBar, /WINDOW MANAGEMENT/);
  assert.match(topBar, /UP\/DN choose/);
  assert.match(topBar, /TAP close/);
  assert.match(topBar, /DBL exit/);
  assert.match(topBar, /HIDE   UP\/DN choose/);
  assert.match(topBar, /TAP hide/);
  assert.match(topBar, /PINNED   UP\/DN choose/);
  assert.match(chrome, /closingAction/);
  const sidebar = read("app/ui/shell/shell.ts");
  assert.match(sidebar, /window === this\.healthWindow[\s\S]*this\.setHealthHidden\(true\)/);
});

test("a sidebar long-press takes Window Management precedence over contextual voice", () => {
  const shell = read("app/ui/shell/shell.ts");
  const input = shell.slice(shell.indexOf("async receiveInput("), shell.indexOf("foregroundWindow():", shell.indexOf("async receiveInput(")));
  const dynamic = input.slice(input.indexOf("if (this.dynamicAppLayer)"), input.indexOf("// While reordering"));
  const closeMode = dynamic.indexOf('this.focus === "sidebar"');
  const voice = dynamic.indexOf("this.openVoiceDialog");
  assert.ok(closeMode >= 0 && closeMode < voice, "Window Management routing must run before contextual voice");
  assert.match(dynamic.slice(closeMode, voice), /layer\.close\(\)[\s\S]*this\.enterWindowManagement\(\)[\s\S]*this\.startEscapeMenuTimer\(\)/);
  assert.match(dynamic, /this\.stack\.topMatches\(\(candidate\) => candidate === layer\)/);
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
