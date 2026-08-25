import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function loadShellTimeoutHarness() {
  const shell = read("app/ui/shell/shell.ts");
  const setterStart = shell.indexOf("  setScreenTimeoutHold(");
  const setterEnd = shell.indexOf("\n\n  /** Turn the screen on", setterStart);
  const timeoutStart = shell.indexOf("  applyScreenTimeout(");
  const timeoutEnd = shell.indexOf("\n\n  /**", timeoutStart);
  assert.ok(setterStart >= 0 && setterEnd > setterStart, "timeout-hold setter is present");
  assert.ok(timeoutStart >= 0 && timeoutEnd > timeoutStart, "idle-timeout method is present");

  const source = `
class ShellTimeoutHarness {
  screenOn = true;
  lastInputAtMs = 0;
  screenTimeoutHolds = new Set();
  activeVoiceLayer = null;
  assistantSession = null;
  assistantLayer = null;
  assistantTurnBackgrounded = false;
  musicCard = null;
  notificationCard = null;
  sleeps = 0;
  timeoutRestarts = 0;
  config = { getScreenTimeoutMs: () => 100 };
  restartScreenTimeout(nowMs = Date.now()) {
    this.timeoutRestarts++;
    this.lastInputAtMs = nowMs;
  }
  sleep() {
    this.sleeps++;
    this.screenOn = false;
  }
${shell.slice(setterStart, setterEnd)}
${shell.slice(timeoutStart, timeoutEnd)}
}
export { ShellTimeoutHarness };
`;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(moduleUrl(js));
}

async function loadConversateAppHarness() {
  const app = read("app/apps/conversate/conversate-app.ts")
    .replace(/^import[\s\S]*?from "[^"]+";\s*/gm, "");
  const harness = `
const harnessState = {
  layerOptions: null,
  holds: new Set(),
  holdEvents: [],
  trayEvents: [],
};
const shell = {
  setTrayIcon(key, icon) { harnessState.trayEvents.push({ key, active: icon !== null }); },
  setScreenTimeoutHold(key, active) {
    harnessState.holdEvents.push({ key, active });
    if (active) harnessState.holds.add(key);
    else harnessState.holds.delete(key);
  },
  isScreenOn() { return true; },
  yieldFocusToSidebar() {},
};
const imageFromAsciiArt = () => ({});
class ConversateLayer {
  constructor(options) { harnessState.layerOptions = options; }
  start() {}
  onScreenChanged() {}
  onForegroundChanged() {}
  onVoiceInputChanged() {}
  onRemoved() {}
  paint() {}
  handleInput() {}
  handleDoubleClick() { return false; }
  phase() { return "idle"; }
  providerLabel() { return "On-device"; }
  togglePaused() {}
  endConversation() {}
  cycleProvider() {}
  newConversation() {}
  startConversation() {}
}
const createInProcessWindow = () => ({
  window: {},
  stack: {},
  requestRender() {},
  markSurfaceReady() {},
});
${app}
export { harnessState };
`;
  const js = ts.transpileModule(harness, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(moduleUrl(js));
}

async function loadContinuousFinishHarness(timeoutMs = 10) {
  const voice = read("app/native/voice-control.ts");
  const finishStart = voice.indexOf("  finishContinuousCapture(");
  const finishEnd = voice.indexOf("\n\n  stopContinuousCapture(", finishStart);
  const releaseStart = voice.indexOf("  private releaseCompletedCapture(");
  const releaseEnd = voice.indexOf("\n\n  stop(): void", releaseStart);
  assert.ok(finishStart >= 0 && finishEnd > finishStart, "continuous finish method is present");
  assert.ok(releaseStart >= 0 && releaseEnd > releaseStart, "capture release method is present");
  const source = `
const CONTINUOUS_FINISH_ABSOLUTE_TIMEOUT_MS = ${timeoutMs};
const global = { isAndroid: true };
class ContinuousFinishHarness {
  timerArmedAtNativeStop = false;
  clientStops = 0;
  constructor() {
    const cloudClient = { stop: () => { this.clientStops++; } };
    this.activeCapture = {
      generation: 41,
      holder: "continuous",
      cloudClient,
      started: true,
      commitSent: false,
      finishPromise: null,
      resolveFinish: null,
      finishTimer: null,
    };
    this.cancelledGeneration = null;
    this.turnGate = {
      finish: () => true,
      cancel: (generation) => { this.cancelledGeneration = generation; return true; },
    };
    this.controller = {
      stop: () => { this.timerArmedAtNativeStop = this.activeCapture.finishTimer !== null; },
    };
  }
${voice.slice(finishStart, finishEnd)}
${voice.slice(releaseStart, releaseEnd)}
}
export { ContinuousFinishHarness };
`;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(moduleUrl(js));
}

const { ShellTimeoutHarness } = await loadShellTimeoutHarness();
const conversateApp = await loadConversateAppHarness();

test("screen-timeout holds suspend idle sleep and restart a full interval on final release", () => {
  const shell = new ShellTimeoutHarness();

  assert.equal(shell.applyScreenTimeout(100), true);
  assert.equal(shell.sleeps, 1);

  shell.screenOn = true;
  shell.sleeps = 0;
  shell.setScreenTimeoutHold("conversate:11", true);
  assert.equal(shell.applyScreenTimeout(1_000), false);
  assert.equal(shell.sleeps, 0);
  assert.equal(shell.lastInputAtMs, 1_000);

  shell.setScreenTimeoutHold("conversate:12", true);
  shell.setScreenTimeoutHold("conversate:11", false);
  assert.equal(shell.timeoutRestarts, 0, "a stale generation cannot release the newer hold");
  assert.equal(shell.applyScreenTimeout(2_000), false);

  shell.setScreenTimeoutHold("conversate:12", false);
  assert.equal(shell.timeoutRestarts, 1, "the final release grants a fresh reading interval");
  assert.equal(shell.applyScreenTimeout(shell.lastInputAtMs + 99), false);
  assert.equal(shell.applyScreenTimeout(shell.lastInputAtMs + 100), true);
});

test("unknown and screen-off timeout-hold releases do not restart the idle clock", () => {
  const shell = new ShellTimeoutHarness();
  shell.setScreenTimeoutHold("missing", false);
  assert.equal(shell.timeoutRestarts, 0);

  shell.screenOn = false;
  shell.setScreenTimeoutHold("conversate:7", true);
  shell.setScreenTimeoutHold("conversate:7", false);
  assert.equal(shell.timeoutRestarts, 0);
});

function createHarnessApp(overrides = {}) {
  conversateApp.harnessState.layerOptions = null;
  conversateApp.harnessState.holds.clear();
  conversateApp.harnessState.holdEvents.length = 0;
  conversateApp.harnessState.trayEvents.length = 0;
  conversateApp.createConversateAppWindow({
    actions: {},
    submitFrame: async () => {},
    setSurfaceVisible: () => {},
    removeSurface: () => {},
    onClosed: () => {},
    startContinuousVoiceCapture: () => 0,
    finishContinuousVoiceCapture: async () => {},
    stopContinuousVoiceCapture: () => {},
    ...overrides,
  });
  assert.ok(conversateApp.harnessState.layerOptions);
  return conversateApp.harnessState.layerOptions;
}

test("Conversate acquires only successful generation keys and stale finalizers release only their key", async () => {
  const finishResolvers = new Map();
  const generations = [11, 12];
  const layerOptions = createHarnessApp({
    startContinuousVoiceCapture: () => generations.shift() ?? 0,
    finishContinuousVoiceCapture: (generation) => new Promise((resolve) => {
      finishResolvers.set(generation, resolve);
    }),
  });

  assert.equal(layerOptions.startCapture("onboard"), 11);
  const firstFinish = layerOptions.finishCapture(11);
  assert.deepEqual([...conversateApp.harnessState.holds], ["conversate:11"]);

  assert.equal(layerOptions.startCapture("onboard"), 12);
  assert.deepEqual(
    [...conversateApp.harnessState.holds],
    ["conversate:11", "conversate:12"],
  );
  finishResolvers.get(11)();
  await firstFinish;
  assert.deepEqual([...conversateApp.harnessState.holds], ["conversate:12"]);

  layerOptions.stopCapture(12);
  assert.equal(conversateApp.harnessState.holds.size, 0);
  assert.equal(layerOptions.startCapture("onboard"), 0);
  assert.equal(conversateApp.harnessState.holds.size, 0, "failed capture never acquires a hold");
});

test("Conversate releases timeout holds when stop or finish fails", async () => {
  const stopOptions = createHarnessApp({
    startContinuousVoiceCapture: () => 21,
    stopContinuousVoiceCapture: () => { throw new Error("stop failed"); },
  });
  stopOptions.startCapture("onboard");
  assert.throws(() => stopOptions.stopCapture(21), /stop failed/);
  assert.equal(conversateApp.harnessState.holds.size, 0);

  const finishOptions = createHarnessApp({
    startContinuousVoiceCapture: () => 22,
    finishContinuousVoiceCapture: () => { throw new Error("finish failed"); },
  });
  finishOptions.startCapture("onboard");
  await assert.rejects(finishOptions.finishCapture(22), /finish failed/);
  assert.equal(conversateApp.harnessState.holds.size, 0);
});

test("missing native stop callback has an absolute app bound and releases the Conversate hold", async () => {
  const { ContinuousFinishHarness } = await loadContinuousFinishHarness();
  const voice = new ContinuousFinishHarness();
  const layerOptions = createHarnessApp({
    startContinuousVoiceCapture: () => 41,
    finishContinuousVoiceCapture: (generation) => voice.finishContinuousCapture(generation),
  });

  assert.equal(layerOptions.startCapture("onboard"), 41);
  assert.deepEqual([...conversateApp.harnessState.holds], ["conversate:41"]);
  await layerOptions.finishCapture(41);
  assert.equal(voice.timerArmedAtNativeStop, true,
    "the app deadline must exist before crossing the native stop boundary");
  assert.equal(voice.activeCapture, null, "the missing callback is retired by the absolute deadline");
  assert.equal(voice.cancelledGeneration, 41, "late native callbacks lose generation authority");
  assert.equal(voice.clientStops, 1);
  assert.equal(conversateApp.harnessState.holds.size, 0,
    "a missing native callback cannot keep the global screen timeout disabled");
});
