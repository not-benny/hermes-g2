import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("release logging never emits credentials, pairing secrets, identifiers, or private content", () => {
  const webSocket = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawWebSocket.java");
  const elevenLabs = read("app/native/elevenlabs-stt.ts");
  const whatsapp = read("App_Resources/Android/whatsapp-node/main.js");
  const whatsappClient = read("app/native/whatsapp-node.ts");
  const voice = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawVoiceController.java");
  const llama = read("app/native/llama.ts");
  const communicator = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
  const manager = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleManager.java");
  const deviceProbe = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawDeviceInfoProbe.java");
  const flasher = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawFirmwareFlasher.java");
  const whatsappLogs = whatsapp.split("\n").filter((line) => line.includes("console.")).join("\n");

  assert.doesNotMatch(webSocket, /substring\s*\(\s*0\s*,|value\.length|header value/i);
  assert.doesNotMatch(elevenLabs, /apiKey\.length|apiKey\.substring|keyPrefix/);
  assert.doesNotMatch(whatsappLogs, /pairing\.code|\bdigits\b|\bfrom\b|\btext\b|connectedUser|err\?\.|payload/);
  assert.doesNotMatch(whatsappClient, /pairing code[^\n]*\$\{|response\.text\(\)/i);
  assert.doesNotMatch(voice, /decoded text[^\n]*substring|recording path/i);
  assert.doesNotMatch(llama, /content\.slice\(0, 200\)/);
  assert.doesNotMatch(communicator, /communicator start R=|address=" \+ address|connecting direct ring " \+ ringAddress/);
  assert.doesNotMatch(communicator, /printStackTrace|getMessage\(\)/);
  assert.doesNotMatch(manager, /address=" \+ address/);
  assert.doesNotMatch(deviceProbe, /"disconnected: " \+ address/);
  assert.doesNotMatch(flasher, /"disconnected: " \+ address/);
});

test("WhatsApp pairing is fail-closed and its loopback token uses Android secure randomness", () => {
  const app = read("app/app.ts");
  const settingsPage = read("app/phone-ui/settings-page.xml");
  const client = read("app/native/whatsapp-node.ts");

  assert.doesNotMatch(app, /startWhatsAppNode\s*\(\s*\)/);
  assert.doesNotMatch(settingsPage, /onWhatsAppTap|phone-ui\/whatsapp-page/);
  assert.match(settingsPage, /WhatsApp pairing is disabled/);
  assert.match(client, /java\.security\.SecureRandom/);
  assert.doesNotMatch(client, /Math\.random/);
});

test("credential settings migrate to Android Keystore encryption before plaintext deletion", () => {
  const javaStore = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawSettings.java");
  const tsStore = read("app/native/settings-store.ts");

  for (const api of ["getSecret", "setSecret", "removeSecret"]) {
    assert.match(javaStore, new RegExp(`\\b${api}\\s*\\(`));
  }
  assert.match(javaStore, /AndroidKeyStore/);
  assert.match(javaStore, /AES\/GCM\/NoPadding/);
  assert.match(javaStore, /commit\s*\(\s*\)/);
  assert.match(javaStore, /getSecret\s*\([^)]*\)[\s\S]*remove\s*\(/);
  for (const key of [
    "assistant.bridgeToken",
    "voice.openAiApiKey",
    "maps.mapboxApiKey",
    "integrations.nightscout.apiToken",
    "terminal.connections",
  ]) {
    assert.match(tsStore, new RegExp(key.replaceAll(".", "\\.")));
  }
  assert.match(tsStore, /removeSecretSetting/);
});

test("phone credential management provides explicit per-secret clear actions", () => {
  const page = read("app/phone-ui/api-keys-page.xml");
  const model = read("app/phone-ui/api-keys-view-model.ts");
  const settings = read("app/ui/dashboard-settings.ts");

  for (const handler of [
    "onClearBridgeTokenTap",
    "onClearAnthropicTap",
    "onClearOpenAiTap",
    "onClearDeepgramTap",
    "onClearElevenLabsTap",
    "onClearSonioxTap",
    "onClearMapboxTap",
    "onClearNightscoutTap",
    "onClearRoamTap",
    "onClearEvenTap",
    "onClearTerminalTap",
  ]) {
    assert.match(page, new RegExp(handler));
    assert.match(model, new RegExp(handler));
  }
  assert.match(settings, /clearSecret\s*\(\s*\)/);
  assert.match(settings, /removeSecretSetting/);
  const glassesMenus = read("app/ui/dashboard/settings-menus.ts");
  for (const setting of [
    "assistantBridgeTokenSetting",
    "elevenLabsApiKeySetting",
    "openAiApiKeySetting",
    "sonioxApiKeySetting",
    "deepgramApiKeySetting",
    "anthropicApiKeySetting",
    "mapboxApiKeySetting",
    "roamApiTokenSetting",
  ]) assert.doesNotMatch(glassesMenus, new RegExp(`textSettingMenuItem\\(${setting}\\)`));
});

test("terminal launch revalidates authorization before remote and local side effects", () => {
  const terminal = read("app/apps/terminal/terminal-app.worker.ts");
  assert.match(terminal, /toolLaunchSession\(args, isAllowed\)/);
  assert.match(
    terminal,
    /function launchAndOpenView[\s\S]*if \(!isAllowed\(\)\)[\s\S]*launchSession\(preset\)[\s\S]*if \(!isAllowed\(\)\)[\s\S]*openViewWindow/,
  );
  assert.match(terminal, /launchAndOpenView\(control, preset, isAllowed\)/);
});

test("terminal transport requires TLS away from loopback and never displays raw token URLs", () => {
  const connections = read("app/apps/terminal/connections.ts");
  const terminal = read("app/apps/terminal/terminal-app.worker.ts");
  assert.match(connections, /isLoopbackHost/);
  assert.match(connections, /if \(!secure && !isLoopbackHost\(host\)\) return null/);
  assert.doesNotMatch(connections, /\|\| connection\.url/);
  assert.match(connections, /invalid connection/);
  assert.doesNotMatch(terminal, /truncateLabel\(draft/);
  assert.match(terminal, /token hidden/);
  const mainPage = read("app/phone-ui/main-page.xml");
  const mainModel = read("app/phone-ui/main-view-model.ts");
  assert.match(mainPage, /secure="\{\{ activeTextSettingSecure \}\}"/);
  assert.match(mainModel, /terminal-new-connection/);
});

test("R1 raw writes use a positive health-session allowlist and redact frame payloads", () => {
  const communicator = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
  assert.match(communicator, /isAllowedRingHealthCommand/);
  assert.match(communicator, /return "command is not allowlisted for the health session"/);
  assert.doesNotMatch(communicator, /write " \+ \(ok \? "ok" : "failed"\) \+ " raw=" \+ hex\(frame\)/);
  assert.doesNotMatch(communicator, /write error: " \+ safeMessage\(t\)/);
});
