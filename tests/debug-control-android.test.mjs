import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("ADB control receiver is confined to the debug source set and protected by DUMP", () => {
  const mainManifest = read("App_Resources/Android/src/main/AndroidManifest.xml");
  const debugManifest = read("App_Resources/Android/src/debug/AndroidManifest.xml");
  const releaseManifest = read("App_Resources/Android/src/release/AndroidManifest.xml");
  const receiver = read("App_Resources/Android/src/debug/java/com/faceclaw/app/FaceclawDebugControlReceiver.java");
  const gradle = read("App_Resources/Android/app.gradle");
  const packageJson = JSON.parse(read("package.json"));
  assert.doesNotMatch(mainManifest, /FaceclawDebugControlReceiver|DEBUG_CONTROL_V1|android\.permission\.DUMP/);
  assert.match(debugManifest, /FaceclawDebugControlReceiver/);
  assert.match(debugManifest, /android:permission="android\.permission\.DUMP"/);
  assert.match(debugManifest, /android:exported="true"/);
  assert.match(releaseManifest, /androidx\.profileinstaller\.ProfileInstallReceiver/);
  assert.match(releaseManifest, /tools:node="remove"/);
  assert.match(receiver, /BuildConfig\.DEBUG/);
  assert.match(gradle, /buildFeatures\s*\{[\s\S]*buildConfig true/);
  assert.match(gradle, /hermesUnsignedReleaseVerification/);
  assert.match(gradle, /signingConfig null/);
  assert.match(gradle, /requestedTasks != \["assembleRelease"\]/);
  assert.equal(packageJson.scripts["verify:release-unsigned"],
    "npx --no-install ns prepare android && cd platforms/android && ./gradlew clean && ./gradlew assembleRelease -Prelease -PhermesUnsignedReleaseVerification=true");
  assert.match(receiver, /extras\.keySet\(\).*size\(\) != 1|keySet\(\)\.size\(\) != 1/);
  assert.doesNotMatch(receiver, /startActivity|startService|Runtime\.getRuntime|ProcessBuilder|File|Uri/);
  assert.equal(existsSync(new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawDebugControlReceiver.java", import.meta.url)), false);
});

test("debug runtime exposes only the versioned JSON envelope and bounded content-free receipts", () => {
  const runtime = read("app/debug/control-runtime.ts");
  const protocol = read("app/debug/control-protocol.ts");
  const dashboard = read("app/g2/dashboard-controller.ts");
  assert.match(runtime, /debugReceiver\(\)/);
  assert.match(runtime, /receiver\.register/);
  assert.doesNotMatch(runtime, /FaceclawDebugControlReceiver/);
  assert.match(runtime, /BuildConfig\.DEBUG/);
  assert.match(runtime, /JSON\.stringify/);
  assert.doesNotMatch(runtime, /console\.|transcriptText|audioPath|credential|token/);
  assert.doesNotMatch(protocol, /intent|shell|https?:|file:|password|secret/i);
  assert.doesNotMatch(protocol, /input\.inject|wakeword|long-press/);
  assert.doesNotMatch(runtime, /injectSyntheticRingInput/);
  assert.match(protocol, /MAX_MUTATION_REPLAY_IDS/);
  assert.match(dashboard, /launchDebugAllowlistedApp[\s\S]*ALL_APPS\.some/);
});

test("procedural fixtures enter the same endpoint detector and Moonshine recognizer path", () => {
  const voice = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawVoiceController.java");
  assert.match(voice, /startDebugFixtureTest/);
  assert.match(voice, /injectDebugFixture/);
  assert.match(voice, /BuildConfig\.DEBUG/);
  assert.match(voice, /endpointDetector\.accept\(packet, 0, packet\.length\)/);
  assert.match(voice, /processRecognizer\(samples\)/);
  assert.match(voice, /speech-envelope-then-silence/);
  assert.match(voice, /catch \(IOException ignored\)[\s\S]*debugFixtureActive = false[\s\S]*throw new IllegalStateException\("fixture unavailable"\)/);
  assert.doesNotMatch(voice, /startDebugFixtureTest\(boolean endpointing\) throws/);
  assert.doesNotMatch(voice, /debug fixture[^\n]*Log\.|Log\.[diwe]\([^\n]*fixture/i);
});

test("lifecycle transitions unregister the endpoint and clean up owned fixture capture", () => {
  const runtime = read("app/debug/control-runtime.ts");
  assert.match(runtime, /Application\.exitEvent/);
  assert.match(runtime, /harness\?\.cleanup\(\)/);
  assert.match(runtime, /receiver\.unregister/);
  assert.match(runtime, /phase !== previousPhase/);
});
