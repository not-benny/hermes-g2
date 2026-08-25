import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Conversate replaces the Transcribe launcher surface and migrates its persisted window id", () => {
  const apps = read("app/apps/all-apps.ts");
  const entry = read("app/apps/conversate/index.ts");
  const persistence = read("app/ui/shell/open-apps-persistence.ts");
  assert.match(apps, /import conversateApp from "\.\/conversate"/);
  assert.match(apps, /\bconversateApp\b/);
  assert.doesNotMatch(apps, /transcribeApp/);
  assert.match(entry, /appId: "conversate"/);
  assert.match(entry, /title: "Conversate"/);
  assert.match(entry, /icon: "message-square"/);
  assert.match(persistence, /value === "transcribe" \? "conversate"/);
  assert.match(persistence, /parsed\.foreground === "transcribe" \? "conversate"/);
});

test("Conversate owns a provider independent from assistant voice and defaults to on-device", () => {
  const settings = read("app/ui/dashboard-settings.ts");
  const provider = read("app/apps/conversate/conversate-provider.ts");
  const app = read("app/apps/conversate/conversate-app.ts");
  const controller = read("app/g2/dashboard-controller.ts");
  assert.match(settings, /voice\.provider/);
  assert.match(settings, /conversate\.transcriptionProvider/);
  assert.match(settings, /conversateProviderSetting[\s\S]*defaultValue: "onboard"/);
  assert.match(settings, /captionTargetLanguageSetting[\s\S]*conversateProviderSetting\.get\(\) !== "soniox"/);
  assert.match(provider, /available = conversateProviderSetting\.values\.filter/);
  assert.match(provider, /provider === "onboard"/);
  assert.match(provider, /LOCAL · NO AUDIO UPLOAD/);
  assert.match(app, /startContinuousVoiceCapture\(provider\)/);
  assert.match(controller, /startContinuousVoiceCapture\(provider\?: VoiceProvider\)/);
  assert.match(controller, /kind === "continuous" && continuousProvider \? continuousProvider : voiceProviderSetting\.get\(\)/);
  assert.match(controller, /saveRecording: kind === "ptt" && saveVoiceRecordingsSetting\.get\(\)/);
});

test("session capture is explicit, foreground-only, generation-bound, and volatile", () => {
  const layer = read("app/apps/conversate/conversate.ts");
  const model = read("app/apps/conversate/conversation-session.ts");
  assert.match(layer, /startConversation\(\): void/);
  assert.doesNotMatch(layer, /reconcileCapture/);
  assert.match(layer, /event\.generation !== this\.captureGeneration/);
  assert.match(layer, /if \(!foreground && this\.isSessionOpen\(\)\) this\.endImmediately\(\)/);
  assert.match(layer, /if \(!on && this\.isSessionOpen\(\)\) this\.endImmediately\(\)/);
  assert.match(layer, /finishCapture\(generation\)/);
  assert.match(layer, /Please inform participants before listening/);
  assert.match(layer, /AUDIO RELEASED · TEXT NOT SAVED/);
  assert.doesNotMatch(layer, /File\.|knownFolders|setStringSetting|setSecret|fetch\(/);
  assert.doesNotMatch(model, /File\.|knownFolders|setStringSetting|setSecret|fetch\(/);
});

test("ring UX exposes local cues, provider selection, pause, and exact end semantics", () => {
  const layer = read("app/apps/conversate/conversate.ts");
  const app = read("app/apps/conversate/conversate-app.ts");
  assert.match(layer, /scroll provider  · start  ·· back/);
  assert.match(layer, /scroll cues[\s\S]*details[\s\S]*end/);
  assert.match(layer, /Heuristic note · not an external fact/);
  assert.match(app, /if \(!this\.inner\.handleDoubleClick\(\)\) shell\.yieldFocusToSidebar\(\)/);
  assert.match(app, /Pause session/);
  assert.match(app, /End conversation/);
  assert.match(app, /Provider: \$\{layer\.providerLabel\(\)\}/);
});
