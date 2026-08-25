import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

async function loadMusicShellHarness() {
  const shell = read("app/ui/shell/shell.ts");
  const start = shell.indexOf("async openMusicCard(): Promise<boolean>");
  const end = shell.indexOf("\n  private closeNotificationModal", start);
  assert.ok(start >= 0 && end > start, "music presentation methods are present");
  const source = `
    const isSuccessfulFrameOutcome = (outcome) => typeof outcome === "string" && outcome.startsWith("sent");
    const isReadinessFrameEvidenceOutcome = (outcome) =>
      isSuccessfulFrameOutcome(outcome) || outcome === "discarded: no change from displayed image";
    class MusicCardLayer {
      kind = "music";
      constructor(options) { this.options = options; options.actions.events.push("construct"); }
      startPresentation() { this.options.actions.events.push("start"); }
      bumpDeliveryNonce() { this.options.actions.events.push("nonce"); }
      onTrackChanged() { this.options.actions.events.push("track-change"); }
    }
    class MusicShellHarness {
      screenOn = false;
      clockAlertLayer = null;
      assistantOnlyPresentation = false;
      activeVoiceLayer = null;
      musicCard = null;
      musicCardWokeScreen = false;
      musicCardWakeActivityRevision = -1;
      musicCardPresentationPending = null;
      activityRevision = 0;
      sleeps = 0;
      assistantResultWakeOwnership = { invalidate: () => {} };
      constructor(config) {
        this.config = config;
        this.stack = {
          layers: [],
          isAtBase: () => this.stack.layers.length === 0,
          push: (layer) => this.stack.layers.push(layer),
          remove: (layer) => {
            const index = this.stack.layers.indexOf(layer);
            if (index < 0) return false;
            this.stack.layers.splice(index, 1);
            return true;
          },
          topMatches: (predicate) => {
            const top = this.stack.layers.at(-1);
            return Boolean(top && predicate(top));
          },
        };
      }
      wake() {
        this.config.actions.events.push("wake");
        if (this.screenOn) return false;
        this.activityRevision++;
        this.screenOn = true;
        this.config.onScreenStateChanged(true);
        return true;
      }
      sleep() {
        this.config.actions.events.push("sleep");
        this.sleeps++;
        this.screenOn = false;
        this.musicCard = null;
        this.musicCardWokeScreen = false;
        this.musicCardWakeActivityRevision = -1;
        const pending = this.musicCardPresentationPending !== null;
        this.musicCardPresentationPending = null;
        this.stack.layers = [];
        if (pending) void this.config.releaseMusicCardPresentationIsolation();
      }
      restartScreenTimeout() {}
      ${shell.slice(start, end)}
    }
    export { MusicShellHarness };
  `;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(moduleUrl(js));
}

async function loadMusicControllerHarness() {
  const controller = read("app/g2/dashboard-controller.ts");
  const start = controller.indexOf("private async prepareMusicCardDisplay");
  const end = controller.indexOf("/** Poll the zero-wait Java barrier", start);
  const clockStart = controller.indexOf("private async showClockAlertVisual");
  const clockEnd = controller.indexOf("private async releaseClockAlertSession", clockStart);
  const clockPrepareStart = controller.indexOf("private async prepareClockAlertSession");
  const clockPrepareEnd = controller.indexOf("private async ensureClockRecoveryConnection", clockPrepareStart);
  const ensureStart = controller.indexOf("private ensureEvenHubSessionActive(): Promise<boolean>");
  const ensureEnd = controller.indexOf("/**\n   * Acquire Now Playing", ensureStart);
  const wakeWordStart = controller.indexOf("private async handleWakeWord");
  const wakeWordEnd = controller.indexOf("private onMediaStateForCard", wakeWordStart);
  assert.ok(start >= 0 && end > start, "music compositor transaction methods are present");
  assert.ok(clockStart >= 0 && clockEnd > clockStart, "Clock presentation method is present");
  assert.ok(clockPrepareStart >= 0 && clockPrepareEnd > clockPrepareStart, "Clock prepare method is present");
  assert.ok(ensureStart >= 0 && ensureEnd > ensureStart && wakeWordStart >= 0 && wakeWordEnd > wakeWordStart,
    "generic wake methods are present");
  const source = `
    const EVENHUB_WAKE_READY_TIMEOUT_MS = 1000;
    const clockAlertCoordinator = { ownsBuzzer: () => false };
    const shellState = {
      screenOn: false,
      windows: [
        { windowId: "foreground", surfaceId: "surface-foreground" },
        { windowId: "background", surfaceId: "surface-background" },
      ],
      musicPending: false,
    };
    const shell = {
      isScreenOn: () => shellState.screenOn,
      foregroundWindow: () => shellState.windows[0],
      getWindows: () => shellState.windows,
      isMusicCardPresentationPending: () => shellState.musicPending,
      showClockAlert: async () => { shellState.clockShows = (shellState.clockShows ?? 0) + 1; return true; },
      wake: () => { shellState.wakes = (shellState.wakes ?? 0) + 1; return true; },
    };
    class MusicControllerHarness {
      phase = "connected";
      evenHubSessionSuspended = true;
      assistantOnlySurfaceIsolationActive = false;
      musicCardPresentationSequence = 0;
      musicCardPresentationLease = null;
      musicCardPresentationRelease = null;
      constructor(communicator, events) {
        this.communicator = communicator;
        this.events = events;
      }
      cancelEvenHubSuspendTimer() { this.events.push("cancel-suspend"); }
      scheduleEvenHubSuspend() { this.events.push("schedule-suspend"); }
      async awaitEvenHubSessionReadyWithoutBlocking() { this.events.push("ready"); return true; }
      async ensureEvenHubSessionActive() { this.events.push("generic-wake"); return true; }
      appendLog(message) { this.events.push(["log", message]); }
      formatError(error) { return String(error); }
      ${controller.slice(start, end)}
      ${controller.slice(clockPrepareStart, clockPrepareEnd)}
      ${controller.slice(clockStart, clockEnd)}
    }
    class ExplicitWakeHarness {
      phase = "connected";
      musicCardPresentationLease = { id: 1 };
      musicCardPresentationRelease = null;
      evenHubResumePromise = null;
      communicator = { setG2ScreenOn: async () => { throw new Error("must stay gated"); } };
      logs = [];
      appendLog(message) { this.logs.push(message); }
      requestShellRender() {}
      repaintForWake() {}
      ${controller.slice(ensureStart, ensureEnd)}
      ${controller.slice(wakeWordStart, wakeWordEnd)}
    }
    export { ExplicitWakeHarness, MusicControllerHarness, shellState };
  `;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(moduleUrl(js));
}

test("Now Playing primes the exact retained card before the only unblank", async () => {
  const { MusicShellHarness } = await loadMusicShellHarness();
  const events = [];
  const visibleFrames = [];
  let subject;
  const config = {
    actions: { events },
    isDisplayAvailable: () => true,
    onScreenStateChanged: () => events.push("screen-on"),
    prepareMusicCardDisplay: async (isOwner) => {
      events.push("prepare");
      assert.equal(subject.screenOn, false);
      assert.equal(isOwner(), true);
      return true;
    },
    requestShellDelivery: async (isOwner, requireSent = true) => {
      assert.equal(isOwner(), true);
      if (!requireSent) {
        events.push("prime");
        assert.equal(subject.screenOn, false, "retained card prime stays physically/logically blank");
        return { frameId: 11, outcome: "discarded: no change from displayed image" };
      }
      events.push("strict");
      return { frameId: 12, outcome: "sent tiles" };
    },
    revealMusicCardDisplay: async (isOwner) => {
      events.push("reveal");
      assert.equal(isOwner(), true);
      visibleFrames.push(subject.stack.layers.at(-1)?.kind ?? "hud");
      return true;
    },
    releaseMusicCardPresentationIsolation: async () => { events.push("release"); },
    requestShellRender: () => { events.push("ordinary"); },
  };
  subject = new MusicShellHarness(config);

  assert.equal(await subject.openMusicCard(), true);
  assert.deepEqual(visibleFrames, ["music"], "the first unblanked retained frame is Now Playing");
  assert.ok(events.indexOf("prepare") < events.indexOf("prime"));
  assert.ok(events.indexOf("prime") < events.indexOf("wake"));
  assert.ok(events.indexOf("wake") < events.indexOf("reveal"));
  assert.ok(events.indexOf("reveal") < events.indexOf("strict"));
  assert.ok(events.indexOf("strict") < events.indexOf("release"));
  assert.equal(events.slice(0, events.indexOf("prepare")).includes("ordinary"), false,
    "construction cannot queue a pre-isolation HUD render");
});

test("failed strict music delivery cannot erase a wake claimed by later user activity", async () => {
  const { MusicShellHarness } = await loadMusicShellHarness();
  const events = [];
  let finishStrict;
  const strict = new Promise((resolve) => { finishStrict = resolve; });
  let subject;
  subject = new MusicShellHarness({
    actions: { events },
    isDisplayAvailable: () => true,
    onScreenStateChanged: () => {},
    prepareMusicCardDisplay: async () => true,
    requestShellDelivery: async (_isOwner, requireSent = true) => {
      if (!requireSent) return { frameId: 21, outcome: "discarded: no change from displayed image" };
      events.push("strict-wait");
      return strict;
    },
    revealMusicCardDisplay: async () => true,
    releaseMusicCardPresentationIsolation: async () => { events.push("release"); },
    requestShellRender: () => { events.push("replacement-prime"); },
    waitForShellRenderIdle: async () => {},
  });
  const opening = subject.openMusicCard();
  while (!events.includes("strict-wait")) await Promise.resolve();
  subject.activityRevision++;
  finishStrict({ frameId: 22, outcome: "discarded: transport failed" });

  assert.equal(await opening, false);
  assert.equal(subject.sleeps, 0, "stale rollback must not sleep a user-owned wake");
  assert.equal(events.includes("replacement-prime"), true);
  assert.equal(events.includes("release"), true);
});

test("blanked session and combined assistant/music isolation are ACKed in safe order", async () => {
  const { MusicControllerHarness, shellState } = await loadMusicControllerHarness();
  const events = [];
  const communicator = {
    setScreenBlanked: async (value) => { events.push(["blank", value]); },
    setG2ScreenOn: async (value) => { events.push(["power", value]); },
    resumeEvenHubSession: async () => { events.push("resume"); return true; },
    setSurfaceVisible: async (id, visible) => { events.push(["surface", id, visible]); },
  };
  const subject = new MusicControllerHarness(communicator, events);
  assert.equal(await subject.prepareMusicCardDisplay(() => true), true);
  assert.deepEqual(events.slice(1), [
    ["blank", true],
    ["power", true],
    "resume",
    ["blank", true],
    "ready",
    ["surface", "surface-foreground", false],
    ["surface", "surface-background", false],
  ]);
  assert.equal(events[0], "cancel-suspend");

  shellState.screenOn = true;
  assert.equal(await subject.revealMusicCardDisplay(() => true), true);
  assert.deepEqual(events.at(-1), ["blank", false], "unblank occurs only after all hide ACKs");

  subject.assistantOnlySurfaceIsolationActive = true;
  const releaseStart = events.length;
  await subject.releaseMusicCardPresentationIsolation();
  const releaseSurfaces = events.slice(releaseStart)
    .filter((entry) => Array.isArray(entry) && entry[0] === "surface");
  assert.deepEqual(releaseSurfaces, [
    ["surface", "surface-foreground", false],
    ["surface", "surface-background", false],
  ], "music release cannot restore app surfaces through assistant-only ownership");
});

test("Clock retries instead of unblanking through an in-flight music lease", async () => {
  const { MusicControllerHarness, shellState } = await loadMusicControllerHarness();
  const events = [];
  const subject = new MusicControllerHarness({}, events);
  shellState.musicPending = true;
  shellState.clockShows = 0;

  assert.equal(await subject.showClockAlertVisual({ mode: "ringing" }), false);
  assert.equal(await subject.prepareClockAlertSession(true), false);
  assert.equal(shellState.clockShows, 0, "Clock must not install through pending music");
  assert.equal(events.includes("generic-wake"), false, "Clock must not run its unblanking wake barrier");

  shellState.musicPending = false;
  assert.equal(await subject.showClockAlertVisual({ mode: "ringing" }), true);
  assert.equal(shellState.clockShows, 1);
  assert.equal(events.includes("generic-wake"), true);
});

test("explicit wakeword cannot bypass the universal music unblank gate", async () => {
  const { ExplicitWakeHarness, shellState } = await loadMusicControllerHarness();
  shellState.wakes = 0;
  const subject = new ExplicitWakeHarness();

  await subject.handleWakeWord("Hermes");
  assert.equal(shellState.wakes, 1, "the logical wake edge is still recorded");
  assert.equal(subject.logs.some((line) => line.includes("wake barrier timed out")), true);
  assert.equal(subject.musicCardPresentationLease.id, 1,
    "the explicit wake cannot consume or supersede music's exact lease");
});
