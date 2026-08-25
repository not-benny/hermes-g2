import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const communicatorTs = read("app/native/faceclaw-communicator.ts");
const dashboardTs = read("app/g2/dashboard-controller.ts");
const displayFrameOutcomesTs = read("app/g2/display-frame-outcomes.ts");
const imageTs = read("app/graphics/image.ts");
const communicatorJava = read(
  "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java",
);
const frameTimingsJava = read(
  "App_Resources/Android/src/main/java/com/faceclaw/app/FrameTimings.java",
);
const managerJava = read(
  "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleManager.java",
);
const optimizerJava = read(
  "App_Resources/Android/src/main/java/com/faceclaw/app/g2protocol/BleImageOptimizer.java",
);

test("frame snapshots use native typed-array copying and idle Java submissions avoid a timer hop", () => {
  assert.match(imageTs, /return this\.pixels\.slice\(\);/);
  assert.match(communicatorTs, /private javaCallsPending = 0;/);
  assert.match(communicatorTs, /if \(this\.javaCallsPending === 0 && allowInline\)/);
  assert.match(communicatorTs, /submitSurfaceFrame[\s\S]*?\}, true\);/);
  assert.match(communicatorTs, /frameTimings\.span\(frameId, "bridge-snapshot"/);
  assert.match(communicatorTs, /frameTimings\.spanStart\(frameId, "java-submit"\)/);
  assert.match(communicatorTs, /frameTimings\.spanEnd\(frameId, "java-submit"\)/);
});

test("ordinary shell render bursts coalesce while strict deliveries keep separate receipts", () => {
  assert.match(
    dashboardTs,
    /requestShellRender\(\): Promise<void> \{[\s\S]*?if \(this\.shellRenderInProgress\) \{[\s\S]*?this\.shellRenderQueued = true;/,
  );
  assert.match(dashboardTs, /const outcome = await communicator\.waitForFrameFinished/);
  assert.match(dashboardTs, /isSuccessfulFrameOutcome\(outcome\)/);
  assert.match(dashboardTs, /return \(this\.shellRenderPromise \?\? Promise\.resolve\(\)\)\.catch\(\(\) => undefined\)/);
  assert.match(dashboardTs, /if \(isAllowed\) \{[\s\S]*?await this\.renderShell\(isAllowed, requireSent\);/);
  assert.match(dashboardTs, /if \(isAllowed && this\.shellRenderQueued\) \{[\s\S]*?void this\.requestShellRender\(\);/);
  assert.match(
    displayFrameOutcomesTs,
    /return outcome !== null && outcome\.startsWith\("sent"\);/,
  );
});

test("an already queued image blocks a redundant heartbeat", () => {
  assert.match(
    communicatorJava,
    /boolean imageWaiting =[\s\S]*?\(hasPendingImageLocked\(\)[\s\S]*?\|\| !getDesiredFingerprint\(\)\.equals\(lastEnqueuedFingerprint\)\);/,
  );
});

test("delivery receipts are first-wins and wait for every image message ACK", () => {
  assert.match(frameTimingsJava, /public boolean finishFrame\(int frameId, String outcome\)/);
  assert.match(communicatorJava, /if \(!FrameTimings\.getInstance\(\)\.finishFrame\(frameId, outcome\)\) \{[\s\S]*?return;/);
  assert.match(optimizerJava, /boolean recordMessageAck\(int messageNumber\)/);
  assert.match(optimizerJava, /ackedMessages\.cardinality\(\) == messageCount/);
  assert.match(communicatorJava, /if \(stats == null \|\| !stats\.recordMessageAck\(message\.imageMessageNumber\)\) \{[\s\S]*?return;/);
});

test("Java queue busy state covers synchronous operation reentrancy", () => {
  assert.match(communicatorTs, /if \(this\.javaCallsPending === 0 && allowInline\) \{[\s\S]*?this\.javaCallsPending\+\+;[\s\S]*?operation\(\)[\s\S]*?this\.javaCallsPending--;/);
  assert.match(communicatorTs, /setTimeout\(\(\) => \{[\s\S]*?resolve\(operation\(\)\);[\s\S]*?this\.javaCallsPending--;/);
});

test("high-frequency successful frame and GATT logs are absent from release hot paths", () => {
  assert.doesNotMatch(communicatorJava, /Log\.i\(TAG, "sending pending message: "/);
  assert.doesNotMatch(communicatorJava, /Log\.i\(TAG, "Enqueued image update"\)/);
  assert.doesNotMatch(communicatorJava, /Log\.i\(TAG, "Got ACK for "/);
  assert.doesNotMatch(communicatorJava, /logLine\("queue image update#"/);
  assert.doesNotMatch(communicatorJava, /logImageUpdateLandmarkLocked\(/);
  assert.doesNotMatch(managerJava, /Log\.i\(TAG, "Writing frame /);
  assert.doesNotMatch(optimizerJava, /Log\.i\(TAG, "planImageFragments/);
  assert.doesNotMatch(frameTimingsJava, /Log\.i\(TAG, "frame#"/);
});

test("fixed-duration benchmark script captures graphics, memory, GC, and ACK-stage evidence", () => {
  const script = read("scripts/run-render-benchmark.sh");
  assert.match(script, /DURATION_SECONDS=60/);
  assert.match(script, /dumpsys gfxinfo/);
  assert.match(script, /dumpsys meminfo/);
  assert.match(script, /frame-timings\.txt/);
  assert.match(script, /logcat/);
  assert.match(script, /usb:/);
  assert.doesNotMatch(script, /RFCR[0-9A-Z]+/);
  assert.doesNotMatch(script, /pm clear|uninstall|force-stop|bluetooth.*(enable|disable)/i);
});
