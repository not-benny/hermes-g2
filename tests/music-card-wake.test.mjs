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
  const ownershipStart = shell.indexOf("/** Opaque cards exclusively own both pixels and input");
  const ownershipEnd = shell.indexOf("/** Re-baseline idle sleep", ownershipStart);
  const inputStart = shell.indexOf("/** Apply the shared ring sensitivity gate");
  const inputEnd = shell.indexOf("\n  async receiveInput", inputStart);
  const flushStart = shell.indexOf("private flushDeferredAssistantUi(): void");
  const flushEnd = shell.indexOf("\n  private queueAssistantOverlayResult", flushStart);
  const alertStart = shell.indexOf("async showAlert(");
  const alertEnd = shell.indexOf("\n  /** Replace the one shell-owned MCP view", alertStart);
  const remoteStart = shell.indexOf("async showRemoteView(");
  const remoteEnd = shell.indexOf("\n  clearRemoteView", remoteStart);
  const dynamicStart = shell.indexOf("async showDynamicApp(");
  const dynamicEnd = shell.indexOf("\n  clearDynamicApp", dynamicStart);
  const clockCloseStart = shell.indexOf("closeClockAlert(): void");
  const clockCloseEnd = shell.indexOf("\n  isClockAlertVisible(): boolean", clockCloseStart);
  assert.ok(start >= 0 && end > start, "music presentation methods are present");
  assert.ok(ownershipStart >= 0 && ownershipEnd > ownershipStart,
    "opaque-card ownership methods are present");
  assert.ok(inputStart >= 0 && inputEnd > inputStart, "music input ownership methods are present");
  assert.ok(flushStart >= 0 && flushEnd > flushStart, "deferred assistant gate is present");
  assert.ok(alertStart >= 0 && alertEnd > alertStart, "alert presentation method is present");
  assert.ok(remoteStart >= 0 && remoteEnd > remoteStart, "remote-view presentation method is present");
  assert.ok(dynamicStart >= 0 && dynamicEnd > dynamicStart, "dynamic-app presentation method is present");
  assert.ok(clockCloseStart >= 0 && clockCloseEnd > clockCloseStart, "Clock close method is present");
  const source = `
    const isSuccessfulFrameOutcome = (outcome) => typeof outcome === "string" && outcome.startsWith("sent");
    const isReadinessFrameEvidenceOutcome = (outcome) =>
      isSuccessfulFrameOutcome(outcome) || outcome === "discarded: no change from displayed image";
    const ringScrollMinIntervalMs = () => 0;
    const ringSensitivitySetting = { get: () => "maximum" };
    class ShellDynamicAppLayer {
      constructor(state, _onInput, onClose) { this.state = state; this.onClose = onClose; }
      close() { this.onClose(); }
    }
    class ShellRemoteViewLayer {
      constructor(state, _onGesture, onClose) { this.state = state; this.onClose = onClose; }
      close() { this.onClose(); }
    }
    class MusicCardLayer {
      kind = "music";
      constructor(options) { this.options = options; options.actions.events.push("construct"); }
      startPresentation() { this.options.actions.events.push("start"); }
      bumpDeliveryNonce() { this.options.actions.events.push("nonce"); }
      onTrackChanged() { this.options.actions.events.push("track-change"); }
      deferDismissalWhileCovered() {
        this.options.actions.events.push("music-deferred-under-cover");
        return true;
      }
      async handleInput(event) {
        this.options.actions.events.push(["music-input", event.type]);
        if (event.type === "click") {
          this.options.actions.events.push("play-pause");
        } else if (event.type === "scroll-up" || event.type === "scroll-down") {
          const direction = event.type === "scroll-up" ? 1 : -1;
          if (this.skipDirection === direction) {
            this.options.actions.events.push(direction === 1 ? "skip-next" : "skip-previous");
            this.skipDirection = null;
          } else {
            this.skipDirection = direction;
          }
        } else if (event.type === "double-click") {
          await this.options.onDismissed();
        }
      }
      async expire() {
        if (this.options.actions.isTop && !this.options.actions.isTop(this)) {
          this.deferDismissalWhileCovered();
          return;
        }
        await this.options.onDismissed();
      }
    }
    class MusicShellHarness {
      screenOn = false;
      clockAlertLayer = null;
      assistantOnlyPresentation = false;
      activeVoiceLayer = null;
      assistantOverlayRestorePending = false;
      assistantLayer = null;
      pendingAssistantResult = null;
      assistantFlushes = 0;
      musicCard = null;
      musicCardWokeScreen = false;
      musicCardWakeActivityRevision = -1;
      musicCardPresentationPending = null;
      notificationCard = null;
      notificationCardPresentationPending = null;
      notificationModalPresentationPending = null;
      reorderingWindowId = null;
      lastScrollHonoredAtMs = 0;
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
          contains: (layer) => this.stack.layers.includes(layer),
          insertBefore: (layer, cover) => {
            if (this.stack.layers.includes(layer)) return false;
            const index = this.stack.layers.indexOf(cover);
            if (index < 0) return false;
            this.stack.layers.splice(index, 0, layer);
            return true;
          },
          topMatches: (predicate) => {
            const top = this.stack.layers.at(-1);
            return Boolean(top && predicate(top));
          },
          handleInput: async (event) => {
            await this.stack.layers.at(-1)?.handleInput(event);
          },
        };
      }
      noteUserActivity() { this.activityRevision++; }
      cancelEscapeMenuTimer() {}
      flushPendingAssistantOverlay() { this.assistantFlushes++; }
      flushPendingAssistantResult() {
        if (!this.pendingAssistantResult || this.hasOpaqueCardPresentation()) return;
        this.assistantFlushes++;
        this.pendingAssistantResult = null;
      }
      notifyDirectNotificationOpportunity() {}
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
      ${shell.slice(ownershipStart, ownershipEnd)}
      ${shell.slice(inputStart, inputEnd)}
      ${shell.slice(flushStart, flushEnd)}
      ${shell.slice(start, end)}
      ${shell.slice(alertStart, alertEnd)}
      ${shell.slice(remoteStart, remoteEnd)}
      ${shell.slice(dynamicStart, dynamicEnd)}
      ${shell.slice(clockCloseStart, clockCloseEnd)}
    }
    export { MusicShellHarness };
  `;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(moduleUrl(js));
}

async function loadMusicCardLifecycleRuntime() {
  const musicCard = read("app/ui/shell/music-card.ts")
    .replace(/^import[\s\S]*?;\n/gm, "");
  const source = `
    let nowMs = 10_000;
    const Date = { now: () => nowMs };
    const timers = [];
    const setTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false, ran: false };
      timers.push(timer);
      return timer;
    };
    const clearTimeout = (timer) => { timer.cleared = true; };
    const getDefaultMediumFont = () => ({ measureText: () => 0 });
    const getDefaultSmallFont = () => ({ measureText: () => 0 });
    class GrayImage {}
    const truncateText = (_font, text) => text;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const mediaControllerBridge = {
      snapshot: () => ({
        album: "",
        artist: "",
        canSkipNext: true,
        canSkipPrevious: true,
        durationMs: 0,
        packageName: "player",
        playbackState: "playing",
        positionMs: 0,
        title: "Track",
      }),
      onStateChange: () => () => {},
      getAlbumArt: () => null,
      playPause: async () => {},
      skipNext: async () => {},
      skipPrevious: async () => {},
    };
    const SHELL_OPAQUE_BLACK = 1;
    const strictDeliveryMarkerGray = () => 1;
    ${musicCard}
    export const scheduledTimers = () => timers.slice();
    export const runTimer = (timer, force = false) => {
      if (timer.ran || (timer.cleared && !force)) return false;
      timer.ran = true;
      timer.callback();
      return true;
    };
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

async function openMusicInputHarness() {
  const { MusicShellHarness } = await loadMusicShellHarness();
  const events = [];
  const config = {
    actions: { events },
    isDisplayAvailable: () => true,
    onScreenStateChanged: () => {},
    prepareMusicCardDisplay: async () => true,
    requestShellDelivery: async (_isOwner, requireSent = true) => ({
      frameId: requireSent ? 42 : 41,
      outcome: requireSent ? "sent tiles" : "discarded: no change from displayed image",
    }),
    revealMusicCardDisplay: async () => true,
    releaseMusicCardPresentationIsolation: async () => { events.push("release"); },
    requestShellRender: () => { events.push("render"); },
  };
  const subject = new MusicShellHarness(config);
  config.actions.isTop = (layer) => subject.stack.topMatches((top) => top === layer);
  assert.equal(await subject.openMusicCard(), true);
  events.length = 0;
  return { subject, events };
}

test("sleep-origin play/pause stays on Now Playing and expiry restores sleep", async () => {
  const { subject, events } = await openMusicInputHarness();
  const card = subject.musicCard;
  const wakeRevision = subject.activityRevision;

  assert.deepEqual(await subject.receiveTopMusicCardInput({ type: "click", source: "ring" }), {
    shell: true,
    window: false,
  });
  // Firmware commonly follows a control/scroll event with a release event.
  await subject.receiveTopMusicCardInput({ type: "long-press-release", source: "ring" });

  assert.equal(subject.activityRevision, wakeRevision, "card controls do not claim the HUD wake");
  assert.equal(subject.stack.layers.at(-1), card, "the card remains the sole visible owner");
  assert.equal(events.includes("play-pause"), true);
  await card.expire();
  assert.equal(subject.sleeps, 1);
  assert.equal(subject.screenOn, false);
});

test("two-flick skip and companion releases retain sleep ownership", async () => {
  const { subject, events } = await openMusicInputHarness();
  const card = subject.musicCard;
  const wakeRevision = subject.activityRevision;

  await subject.receiveTopMusicCardInput({ type: "scroll-up" });
  await subject.receiveTopMusicCardInput({ type: "long-press-release", source: "ring" });
  await subject.receiveTopMusicCardInput({ type: "scroll-up" });
  await subject.receiveTopMusicCardInput({ type: "long-press-release", source: "ring" });

  assert.equal(events.filter((event) => event === "skip-next").length, 1);
  assert.equal(subject.activityRevision, wakeRevision);
  assert.equal(subject.stack.layers.at(-1), card);
  await card.expire();
  assert.equal(subject.sleeps, 1);
});

test("double-click dismisses a sleep-origin Now Playing card back to sleep", async () => {
  const { subject } = await openMusicInputHarness();
  const wakeRevision = subject.activityRevision;

  await subject.receiveTopMusicCardInput({ type: "double-click", source: "ring" });

  assert.equal(subject.activityRevision, wakeRevision);
  assert.equal(subject.sleeps, 1);
  assert.equal(subject.screenOn, false);
});

test("an untouched Now Playing expiry restores the preceding sleep state", async () => {
  const { subject } = await openMusicInputHarness();
  const card = subject.musicCard;

  await card.expire();

  assert.equal(subject.sleeps, 1);
  assert.equal(subject.screenOn, false);
});

test("Clock coverage defers music expiry and closing Clock never exposes the HUD", async () => {
  const { subject, events } = await openMusicInputHarness();
  const card = subject.musicCard;
  const clock = { kind: "clock" };
  subject.clockAlertLayer = clock;
  subject.stack.push(clock);

  await card.expire();
  assert.equal(subject.musicCard, card);
  assert.equal(subject.stack.layers.at(-1), clock, "Clock remains the authoritative top layer");
  assert.equal(subject.sleeps, 0);
  assert.equal(events.includes("music-deferred-under-cover"), true);

  subject.closeClockAlert();
  assert.equal(subject.stack.layers.at(-1), card,
    "Clock dismissal reveals the retained opaque card, never the HUD");
  assert.equal(subject.screenOn, true);
  await card.expire();
  assert.equal(subject.sleeps, 1, "the re-exposed card still owns return-to-sleep");

  const musicLayer = read("app/ui/shell/music-card.ts");
  assert.match(musicLayer, /setTimeout\(\(\) => \{[\s\S]*this\.deferDismissalWhileCovered\(\)[\s\S]*this\.beginRise\(\)/);
  assert.match(musicLayer, /this\.phase === "rising"[\s\S]*this\.deferDismissalWhileCovered\(\)[\s\S]*this\.options\.onDismissed\(\)/);
  assert.doesNotMatch(
    musicLayer.slice(musicLayer.indexOf("private tick()"), musicLayer.indexOf("private beginRise()")),
    /this\.onRemoved\(\)/,
    "only LayerStack removal may tear down the retained card",
  );
});

test("external removal during music rise cannot rearm an off-stack timer", async () => {
  const {
    MusicCardLayer,
    runTimer,
    scheduledTimers,
  } = await loadMusicCardLifecycleRuntime();
  let installed = true;
  let renders = 0;
  let dismissals = 0;
  let card;
  const stack = {
    contains: (candidate) => installed && candidate === card,
    topMatches: (predicate) => installed && predicate(card),
  };
  card = new MusicCardLayer({
    actions: { requestRender: () => { renders++; } },
    onDismissed: () => { dismissals++; },
  });
  card.startPresentation();
  card.ctx = { stack, actions: { requestRender: () => { renders++; } } };

  const [dismissTimer] = scheduledTimers();
  assert.ok(dismissTimer, "drop completion arms the ordinary card timeout");
  assert.equal(runTimer(dismissTimer), true);
  const animationTimer = scheduledTimers().at(-1);
  assert.notEqual(animationTimer, dismissTimer, "expiry begins a queued rise animation");

  installed = false;
  card.onRemoved();
  const timerCountAfterRemoval = scheduledTimers().length;
  const rendersAfterRemoval = renders;
  // Simulate an already-queued callback reaching the event loop despite teardown.
  assert.equal(runTimer(animationTimer, true), true);
  assert.equal(scheduledTimers().length, timerCountAfterRemoval,
    "the stale rise callback cannot arm another dismissal timer");
  assert.equal(renders, rendersAfterRemoval, "the stale callback cannot repaint an absent card");
  assert.equal(dismissals, 0, "LayerStack teardown remains the only removal completion");
  assert.equal(card.deferDismissalWhileCovered(), false,
    "an absent card is not misclassified as a covered card");

  const layerSource = read("app/ui/shell/music-card.ts");
  assert.match(layerSource, /this\.presentationStarted = false;[\s\S]*this\.ctx = null;/);
  assert.match(layerSource, /this\.ctx\.stack\.contains\(this\)/,
    "covered deferral requires exact stack membership");
  assert.match(layerSource, /private tick\(\): void \{\s*if \(!this\.presentationStarted\) return;/);
});

test("terminal Clock release re-exposes music and cannot stack a dynamic app above it", async () => {
  const { subject, events } = await openMusicInputHarness();
  const card = subject.musicCard;
  const clock = { kind: "clock" };
  subject.clockAlertLayer = clock;
  subject.stack.push(clock);
  subject.config.releaseTerminalClockAlertVisual = () => false;
  const dynamicState = {
    viewId: "clock-result",
    revision: 1,
    title: "Clock result",
    components: [],
    scrollOffset: 0,
  };

  await card.expire();
  await assert.rejects(
    subject.showDynamicApp(dynamicState, undefined, undefined, () => false, () => {}),
    /active Clock alert owns the glasses display/i,
  );
  assert.equal(subject.clockAlertLayer, clock, "a nonterminal Clock remains authoritative");
  assert.equal(subject.stack.layers.at(-1), clock);

  subject.config.releaseTerminalClockAlertVisual = () => true;
  await assert.rejects(
    subject.showDynamicApp(dynamicState, undefined, undefined, () => false, () => {}),
    /opaque card owns the display/i,
  );
  assert.equal(subject.clockAlertLayer, null, "the terminal Clock retires atomically");
  assert.equal(subject.dynamicAppLayer ?? null, null);
  assert.equal(subject.musicCard, card);
  assert.equal(subject.stack.layers.at(-1), card,
    "the exact sleep-origin card is re-exposed instead of being covered or evicted");
  assert.equal(events.includes("render"), true);

  await card.expire();
  assert.equal(subject.sleeps, 1);
  assert.equal(subject.screenOn, false);
});

test("genuine external activity claims the wake and prevents stale card sleep", async () => {
  const { subject } = await openMusicInputHarness();
  const card = subject.musicCard;

  subject.noteUserActivity();
  await card.expire();

  assert.equal(subject.sleeps, 0);
  assert.equal(subject.screenOn, true);
  assert.equal(subject.stack.layers.length, 0, "the claimed wake returns to the ordinary HUD");
});

test("a queued assistant final cannot steal a music wake and waits for a later wake", async () => {
  const { subject } = await openMusicInputHarness();
  const card = subject.musicCard;
  const wakeRevision = subject.activityRevision;
  subject.pendingAssistantResult = "queued result";

  subject.noteAssistantResultActivity();
  subject.flushDeferredAssistantUi();

  assert.equal(subject.activityRevision, wakeRevision);
  assert.equal(subject.pendingAssistantResult, "queued result");
  assert.equal(subject.assistantFlushes, 0);
  assert.equal(subject.stack.layers.at(-1), card);
  await card.expire();
  assert.equal(subject.sleeps, 1);

  subject.wake();
  subject.flushDeferredAssistantUi();
  assert.equal(subject.pendingAssistantResult, null, "a later explicit wake may deliver the retained final");
  assert.equal(subject.assistantFlushes, 1);
});

test("an active Now Playing card rejects unrelated alert, remote-view and dynamic-app overlays", async () => {
  const { subject } = await openMusicInputHarness();
  const remoteState = { viewId: "remote", revision: 1 };
  const dynamicState = {
    viewId: "dynamic",
    revision: 1,
    title: "Dynamic",
    components: [],
    scrollOffset: 0,
  };

  await assert.rejects(subject.showAlert("blocked"), /opaque card owns the display/i);
  await assert.rejects(
    subject.showRemoteView(remoteState, undefined, undefined, () => false, () => {}),
    /opaque card owns the display/i,
  );
  await assert.rejects(
    subject.showDynamicApp(dynamicState, undefined, undefined, () => false, () => {}),
    /opaque card owns the display/i,
  );
  assert.equal(subject.stack.layers.at(-1), subject.musicCard);
  assert.equal(subject.sleeps, 0);
});

test("Clock preemption revokes a remote-view strict ACK and restores its prior layer below Clock", async () => {
  const { MusicShellHarness } = await loadMusicShellHarness();
  let strictOwner;
  let releaseStrict;
  const strict = new Promise((resolve) => { releaseStrict = resolve; });
  const subject = new MusicShellHarness({
    actions: { events: [] },
    isDisplayAvailable: () => true,
    requestShellDelivery: async (isOwner) => {
      strictOwner = isOwner;
      await strict;
    },
    requestShellRender: () => {},
  });
  subject.screenOn = true;
  const prior = { kind: "prior-remote" };
  subject.remoteViewLayer = prior;
  subject.stack.push(prior);

  const pending = subject.showRemoteView(
    { viewId: "remote-next", revision: 2 },
    undefined,
    undefined,
    () => false,
    () => {},
  );
  await Promise.resolve();
  assert.equal(strictOwner(), true);
  const clock = { kind: "clock" };
  subject.clockAlertLayer = clock;
  subject.stack.push(clock);
  assert.equal(strictOwner(), false,
    "a Clock frame cannot acknowledge the now-covered remote view");
  releaseStrict();
  await assert.rejects(pending, /superseded before delivery completed/i);
  assert.equal(subject.remoteViewLayer, prior);
  assert.deepEqual(subject.stack.layers, [prior, clock],
    "rollback restores the prior view underneath the authoritative Clock");
});

test("Clock preemption revokes a dynamic-app strict ACK and restores its prior layer below Clock", async () => {
  const { MusicShellHarness } = await loadMusicShellHarness();
  let strictOwner;
  let releaseStrict;
  const strict = new Promise((resolve) => { releaseStrict = resolve; });
  const subject = new MusicShellHarness({
    actions: { events: [] },
    isDisplayAvailable: () => true,
    requestShellDelivery: async (isOwner) => {
      strictOwner = isOwner;
      await strict;
      return { frameId: 9, outcome: "sent tiles" };
    },
    requestShellRender: () => {},
  });
  subject.screenOn = true;
  const prior = { state: { viewId: "dynamic" }, close: () => {} };
  subject.dynamicAppLayer = prior;
  subject.stack.push(prior);
  const state = {
    viewId: "dynamic",
    revision: 2,
    title: "Updated",
    components: [],
    scrollOffset: 0,
  };

  const pending = subject.showDynamicApp(state, undefined, undefined, () => false, () => {});
  await Promise.resolve();
  assert.equal(strictOwner(), true);
  const clock = { kind: "clock" };
  subject.clockAlertLayer = clock;
  subject.stack.push(clock);
  assert.equal(strictOwner(), false,
    "a Clock frame cannot acknowledge the now-covered dynamic app");
  releaseStrict();
  await assert.rejects(pending, /did not receive a current transport acknowledgement/i);
  assert.equal(subject.dynamicAppLayer, prior);
  assert.deepEqual(subject.stack.layers, [prior, clock],
    "rollback restores the prior dynamic layer underneath the authoritative Clock");
});

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
