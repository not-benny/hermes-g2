import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

async function loadRouting() {
  const js = ts.transpileModule(read("app/ui/shell/assistant-routing.ts"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

async function loadAssistantOverlayLifecycleHarness() {
  const shell = read("app/ui/shell/shell.ts");
  const ownershipStart = shell.indexOf("/** Opaque cards exclusively own both pixels and input");
  const ownershipEnd = shell.indexOf("/** Re-baseline idle sleep", ownershipStart);
  const flowStart = shell.indexOf("sendToAssistant(text: string");
  const flowEnd = shell.indexOf("\n  private flushPendingAssistantResult", flowStart);
  const rehideStart = shell.indexOf("private rehideAssistantOverlayForRetry(layer: AssistantLayer)");
  const rehideEnd = shell.indexOf("\n  /** Wake and strictly deliver", rehideStart);
  assert.ok(ownershipStart >= 0 && ownershipEnd > ownershipStart);
  assert.ok(flowStart >= 0 && flowEnd > flowStart);
  assert.ok(rehideStart >= 0 && rehideEnd > rehideStart);
  const source = `
    const assistantBackendSetting = { get: () => "external" };
    const playEventBeep = async () => {};
    const assistantReplyNeedsOverlay = (text) => !text || text.includes("?");
    const isSuccessfulFrameOutcome = (outcome) =>
      typeof outcome === "string" && outcome.startsWith("sent");
    const startDetachedCleanup = (task) => { void Promise.resolve().then(task); };
    class AssistantLayer {
      constructor(_actions, options) { this.options = options; }
      startTurn() { this.running = true; }
      onTurnDone(text) { this.running = false; this.reply = text; }
      onError(text) { this.running = false; this.reply = text; }
      getReplyText() { return this.reply ?? ""; }
      isRunning() { return this.running === true; }
      onRemoved() {
        if (this.removed) return;
        this.removed = true;
        this.options.onRemoved();
      }
    }
    class Session {
      active = false;
      isTurnActive() { return this.active; }
      sendUtterance(_text, _context, callbacks) {
        this.active = true;
        this.callbacks = callbacks;
      }
      cancel() { this.active = false; }
      finish(text) {
        this.active = false;
        this.callbacks.onTurnDone({ text, stopReason: "end" });
      }
    }
    class LifecycleHarness {
      screenOn = true;
      activeVoiceLayer = null;
      assistantLayer = null;
      detachedAssistantLayer = null;
      assistantTurnBackgrounded = false;
      assistantOverlayRestorePending = false;
      assistantOverlayDelivery = false;
      isolatedAssistantTurn = null;
      pendingAssistantResult = null;
      pendingAssistantResultIsolated = false;
      musicCard = null;
      musicCardPresentationPending = null;
      notificationCard = null;
      notificationCardPresentationPending = null;
      activityRevision = 0;
      strictRequests = [];
      ordinaryRenders = 0;
      constructor() {
        this.session = new Session();
        this.assistantSession = this.session;
        const base = { kind: "base" };
        this.stack = {
          layers: [base],
          push: (layer) => this.stack.layers.push(layer),
          detach: (layer) => {
            const index = this.stack.layers.indexOf(layer);
            if (index < 0) return false;
            this.stack.layers.splice(index, 1);
            return true;
          },
          topMatches: (predicate) => predicate(this.stack.layers.at(-1)),
          clearToBase: () => {
            while (this.stack.layers.length > 1) this.stack.layers.pop().onRemoved?.();
          },
        };
        this.config = {
          actions: {},
          requestShellRender: () => { this.ordinaryRenders++; },
          requestShellDelivery: (isOwner) => new Promise((resolve) => {
            this.strictRequests.push({ isOwner, resolve });
          }),
          prepareAssistantResultDisplay: async () => true,
          waitForShellRenderIdle: async () => {},
          isDisplayAvailable: () => true,
        };
      }
      ensureAssistantSession() { this.assistantSession = this.session; return this.session; }
      buildAssistantContext() { return {}; }
      wake() { this.screenOn = true; return true; }
      noteUserActivity() { this.activityRevision++; }
      restartScreenTimeout() {}
      startAssistantFollowUp() {}
      closeAssistantLayer() {}
      setAssistantOnlyPresentation() {}
      flushPendingAssistantResult() {}
      notifyDirectNotificationOpportunity() {}
      retryPendingAssistantResult() { this.flushDeferredAssistantUi(); }
      clearVisibleLayersForSleep() {
        this.screenOn = false;
        this.stack.clearToBase();
      }
      ${shell.slice(ownershipStart, ownershipEnd)}
      ${shell.slice(flowStart, flowEnd)}
      ${shell.slice(rehideStart, rehideEnd)}
    }
    export { LifecycleHarness };
  `;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}

async function settleUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

test("short tool results stay in the background while conversational replies need the overlay", async () => {
  const { assistantReplyNeedsOverlay } = await loadRouting();
  assert.equal(assistantReplyNeedsOverlay("Bedroom light on ."), false);
  assert.equal(assistantReplyNeedsOverlay("Timer set for ten minutes."), false);
  assert.equal(assistantReplyNeedsOverlay("Which bedroom light did you mean?"), true);
  assert.equal(assistantReplyNeedsOverlay("What brightness? ."), true);
  assert.equal(assistantReplyNeedsOverlay("Say bedroom or kitchen."), true);
  assert.equal(assistantReplyNeedsOverlay("Pick bedroom or kitchen."), true);
  assert.equal(assistantReplyNeedsOverlay("Select lamp one or lamp two."), true);
  assert.equal(assistantReplyNeedsOverlay("Respond with red or blue."), true);
  assert.equal(assistantReplyNeedsOverlay("Please provide your postcode."), true);
  assert.equal(assistantReplyNeedsOverlay("Please enter the six-digit code."), true);
  assert.equal(assistantReplyNeedsOverlay("I need your approval to proceed."), true);
  assert.equal(assistantReplyNeedsOverlay("Your approval is required to proceed."), true);
  assert.equal(assistantReplyNeedsOverlay("Confirmed, bedroom light is on."), false);
  assert.equal(assistantReplyNeedsOverlay("Confirmation email sent."), false);
  assert.equal(assistantReplyNeedsOverlay("Your approval was recorded."), false);
  assert.equal(assistantReplyNeedsOverlay("Your reservation confirmation was sent."), false);
  assert.equal(assistantReplyNeedsOverlay("I need you to know the timer finished."), false);
  assert.equal(assistantReplyNeedsOverlay("Please choose one of the following options."), true);
  assert.equal(assistantReplyNeedsOverlay("x".repeat(161)), true);
  const incidentReply = "I can add **“Mimecast creation”**, but I don’t have a connected “Blocker Board” destination. Should I add it to your **Work Tasks** inbox instead?";
  assert.equal([...incidentReply].length, 146, "preserve the exact P1 incident reply");
  assert.equal(assistantReplyNeedsOverlay(incidentReply), true);
});

test("assistant turns are detached before thinking starts and progress stays private", () => {
  const shell = read("app/ui/shell/shell.ts");
  const layer = read("app/ui/shell/assistant.ts");
  const run = shell.slice(shell.indexOf("private runAssistantTurn"), shell.indexOf("private startAssistantFollowUp"));
  const backgroundIndex = run.indexOf("this.backgroundAssistantLayer(layer)");
  const startIndex = run.indexOf("layer.startTurn()");
  const sendIndex = run.indexOf("session.sendUtterance");
  assert.ok(backgroundIndex >= 0, "turn must enter background mode");
  assert.ok(startIndex > backgroundIndex, "thinking state must start only after the layer is detached");
  assert.ok(sendIndex > startIndex, "backend work must start only after the hidden state is installed");
  assert.match(run, /onTextDelta:\s*\(\)\s*=>\s*\{\}/);
  assert.match(run, /onToolActivity:\s*\(\)\s*=>\s*\{\}/);
  assert.doesNotMatch(run, /assistantTool/);
  assert.match(run, /layer\.onTurnDone\(result\.text\)/);
  assert.match(shell, /private assistantTurnBackgrounded = false/);
  assert.match(shell, /private backgroundAssistantLayer\(layer: AssistantLayer\)/);
  assert.match(shell, /this\.assistantTurnBackgrounded = true[\s\S]*this\.stack\.detach\(layer\)/);
  assert.match(shell, /private detachStaleRunningAssistantLayer\(\): void[\s\S]*layer\.isRunning\(\)[\s\S]*this\.backgroundAssistantLayer\(layer\)/);
  const thinkingPaint = layer.slice(layer.indexOf("paint(ctx:"), layer.indexOf("const displayText"));
  assert.match(thinkingPaint, /if \(this\.phase === "thinking"\)[\s\S]*return image/);
  assert.doesNotMatch(thinkingPaint, /drawText|fillRoundedRect|drawRoundedRect|Working/);
});

test("sleeping PTT rejects a second press and sleeps after handing off hidden work", () => {
  const shell = read("app/ui/shell/shell.ts");
  const input = shell.slice(shell.indexOf("async receiveInput("), shell.indexOf("foregroundWindow():", shell.indexOf("async receiveInput(")));
  const activeGuard = input.indexOf("this.assistantSession?.isTurnActive()", input.indexOf("A second sleeping PTT press"));
  const activity = input.indexOf("this.noteUserActivity()", activeGuard);
  const isolate = input.indexOf("this.setAssistantOnlyPresentation(true)", activeGuard);
  const wake = input.indexOf('this.wake("sidebar")', activeGuard);
  assert.ok(activeGuard >= 0 && activeGuard < activity && activeGuard < isolate && activeGuard < wake,
    "active-turn rejection must precede activity, isolation, and wake side effects");
  assert.match(input.slice(input.indexOf("A second sleeping PTT press"), activity),
    /return \{ shell: false, window: false \}/);

  const dialog = shell.slice(shell.indexOf("private openVoiceDialog"), shell.indexOf("private buildVoiceSendTargets"));
  assert.match(dialog, /queueMicrotask\(\(\) => \{[\s\S]*this\.finishSleepingAssistantVoiceHandoff\(\)/);
  assert.match(dialog, /this\.finishSleepingAssistantVoiceDismissal\(options\.returnToSleepOnClose === true\)/);
  const handoff = shell.slice(shell.indexOf("private finishSleepingAssistantVoiceHandoff"), shell.indexOf("private rehideAssistantOverlayForRetry"));
  assert.match(handoff, /this\.assistantOnlyPresentation[\s\S]*this\.assistantTurnBackgrounded[\s\S]*this\.assistantSession\?\.isTurnActive\(\)/);
  assert.match(handoff, /this\.isolatedAssistantTurn = layer[\s\S]*this\.sleep\(\)/);
  const sleep = shell.slice(shell.indexOf("sleep(): void"), shell.indexOf("acquireAssistantResultWake"));
  assert.doesNotMatch(sleep, /assistantSession\?\.cancel|assistantTurnBackgrounded = false/,
    "sleep must leave the detached hidden turn running");
});

test("sleep-origin voice discard blanks before releasing isolated app surfaces", () => {
  const shell = read("app/ui/shell/shell.ts");
  const input = shell.slice(shell.indexOf("async receiveInput("), shell.indexOf("foregroundWindow():", shell.indexOf("async receiveInput(")));
  const sleepingRoute = input.slice(input.indexOf("A sleeping long-press"), input.indexOf("if (!this.screenOn)", input.indexOf("A sleeping long-press") + 1));
  assert.match(sleepingRoute, /returnToSleepOnClose: true/);
  const dismissal = shell.slice(shell.indexOf("private finishSleepingAssistantVoiceDismissal"), shell.indexOf("private rehideAssistantOverlayForRetry"));
  assert.match(dismissal, /!returnToSleepOnClose/);
  assert.match(dismissal, /this\.assistantSession\?\.isTurnActive\(\)/);
  assert.match(dismissal, /if \(this\.screenOn\) this\.sleep\(\)/);

  const sleep = shell.slice(shell.indexOf("sleep(): void"), shell.indexOf("acquireAssistantResultWake"));
  assert.ok(
    sleep.indexOf("this.config.onScreenStateChanged(false)") <
      sleep.indexOf("this.setAssistantOnlyPresentation(false)"),
    "the compositor blank must queue before retained app surfaces are restored",
  );
});

test("sleeping PTT isolation returns only for its final and releases on failed delivery", () => {
  const shell = read("app/ui/shell/shell.ts");
  assert.match(shell, /private isolatedAssistantTurn: AssistantLayer \| null = null/);
  assert.match(shell, /private pendingAssistantResultIsolated = false/);
  const finish = shell.slice(shell.indexOf("private finishBackgroundAssistantTurn"), shell.indexOf("private flushDeferredAssistantUi"));
  assert.match(finish, /const isolated = this\.isolatedAssistantTurn === layer/);
  assert.match(finish, /if \(isolated\) this\.assistantOnlyPresentationOwnership\.claim\(\)/,
    "a queued isolated successor must immediately make older cleanup stale");
  assert.match(finish, /this\.pendingAssistantResultIsolated = isolated/);
  assert.match(finish, /this\.pendingAssistantResultRevision\+\+/);
  assert.ok(
    finish.indexOf("this.noteAssistantResultActivity()") < finish.indexOf("this.flushPendingAssistantResult()"),
    "completion must invalidate older wake ownership before acquiring the final's provisional wake",
  );
  const resultActivity = shell.slice(
    shell.indexOf("private noteAssistantResultActivity"),
    shell.indexOf("/** Re-baseline idle sleep"),
  );
  assert.match(resultActivity, /if \(this\.hasOpaqueCardPresentation\(\)\) return;/,
    "assistant completion must defer activity while a sleep-origin opaque card owns the display");
  assert.match(resultActivity, /this\.noteUserActivity\(\)/);
  const overlay = shell.slice(shell.indexOf("private flushPendingAssistantOverlay"), shell.indexOf("private flushPendingAssistantResult"));
  assert.match(overlay, /const isolationClaim = isolated \? this\.setAssistantOnlyPresentation\(true\) : null/);
  assert.match(overlay, /this\.beginIsolatedAssistantResultDisplay\(isPending\)/);
  assert.match(overlay, /preparation\?\.commit\(\)[\s\S]*strictAcknowledged = true/);
  assert.match(overlay,
    /this\.rehideAssistantOverlayForRetry\(layer\);[\s\S]*preparation\?\.rollback\(\);[\s\S]*this\.releaseAssistantOnlyPresentation\(isolationClaim\)/);
  assert.match(overlay, /this\.isolatedAssistantTurn = null/);
  const compact = shell.slice(shell.indexOf("private flushPendingAssistantResult"), shell.indexOf("private startAssistantFollowUp"));
  assert.match(compact, /const isolated = this\.pendingAssistantResultIsolated/);
  assert.match(compact, /const revision = this\.pendingAssistantResultRevision/);
  assert.match(compact, /this\.pendingAssistantResultRevision === revision/,
    "equal reply text must not let an older delivery own a newer result");
  assert.match(compact, /const isolationClaim = isolated \? this\.setAssistantOnlyPresentation\(true\) : null/);
  assert.match(compact, /this\.beginIsolatedAssistantResultDisplay\(isPending\)/);
  assert.match(compact, /isolated \? \(\) => preparation\?\.commit\(\) : undefined/);
  assert.match(compact, /if \(isolated && !delivered\) \{[\s\S]*preparation\?\.rollback\(\);[\s\S]*this\.releaseAssistantOnlyPresentation\(isolationClaim\)/);
  assert.match(compact, /queuedNext = this\.pendingAssistantResult !== null &&[\s\S]*this\.pendingAssistantResultRevision !== revision/);
  const controller = read("app/g2/dashboard-controller.ts");
  assert.match(controller,
    /prepareAssistantResultPresentationIsolation:\s*\(isAllowed\)\s*=>[\s\S]*this\.prepareMusicCardDisplay\(isAllowed\)/);
  assert.doesNotMatch(controller,
    /prepareAssistantResultPresentationIsolation:[^\n]*beginDirectAssistantResultDisplay/,
    "in-turn PTT finals must not inherit the proactive confirmed-worn gate");
  const opaquePreparation = shell.slice(
    shell.indexOf("private beginIsolatedAssistantResultDisplay"),
    shell.indexOf("private flushPendingAssistantOverlay"),
  );
  assert.match(opaquePreparation, /prepareOpaqueDisplay:[\s\S]*primeBlankFrame:[\s\S]*acquireWake:[\s\S]*revealOpaqueDisplay:/,
    "sleep-origin replies must follow the notification-card blank, prime, wake, reveal order");
  assert.match(opaquePreparation, /releaseOpaqueDisplay:[\s\S]*startDetachedCleanup\(release\)/,
    "the compositor lease must survive until strict commit or rollback");
  assert.match(shell, /const isolationClaim = isolated \? this\.setAssistantOnlyPresentation\(true\) : null/g,
    "each async isolated result must retain its exact assistant-only surface claim");
  assert.match(shell, /this\.releaseAssistantOnlyPresentation\(isolationClaim\)/,
    "a stale result cleanup must not release a newer voice query's isolation");
  const alert = shell.slice(shell.indexOf("async showAlert("), shell.indexOf("/** Replace the one shell-owned MCP view"));
  assert.match(alert,
    /lifetime === "until-dismiss-or-sleep"[\s\S]*startDetachedCleanup\(\(\) => this\.config\.requestShellRender\(\)\)/,
    "strict failure must return promptly so the provisional wake can roll back");
});

test("context dashboard displacement retires background-overlay bookkeeping", () => {
  const shell = read("app/ui/shell/shell.ts");
  const showDynamicApp = shell.slice(
    shell.indexOf("async showDynamicApp("),
    shell.indexOf("clearDynamicApp(", shell.indexOf("async showDynamicApp(")),
  );
  assert.match(
    showDynamicApp,
    /if \(displacedAssistant\) \{[\s\S]*this\.detachedAssistantLayer = displacedAssistant;[\s\S]*this\.assistantTurnBackgrounded = false;[\s\S]*this\.assistantOverlayRestorePending = false;/,
  );
  assert.match(
    showDynamicApp,
    /isolationClaim = this\.setAssistantOnlyPresentation\(true\)[\s\S]*this\.releaseAssistantOnlyPresentation\(isolationClaim\)/,
    "a stale atomic dashboard failure must not release a newer assistant-only owner",
  );
  assert.doesNotMatch(
    showDynamicApp,
    /if \(!this\.screenOn\) this\.setAssistantOnlyPresentation\(false\)/,
    "atomic dashboard cleanup must never use an owner-free isolation release",
  );
});

test("background completion uses a compact persistent result unless conversation must reopen", () => {
  const shell = read("app/ui/shell/shell.ts");
  assert.match(shell, /assistantReplyNeedsOverlay/);
  assert.match(shell, /private finishBackgroundAssistantTurn\(layer: AssistantLayer\)/);
  assert.match(shell, /if \(!reply \|\| assistantReplyNeedsOverlay\(reply\)\)/);
  assert.match(shell, /assistantReplyNeedsOverlay\(reply\)[\s\S]*this\.queueAssistantOverlayResult\(layer\)/);
  assert.match(shell, /private restoreBackgroundAssistantLayer\(layer: AssistantLayer\)/);
  const run = shell.slice(shell.indexOf("private runAssistantTurn"), shell.indexOf("private startAssistantFollowUp"));
  assert.match(run, /onTurnDone:[\s\S]*this\.finishBackgroundAssistantTurn\(layer\)/);
  assert.match(run, /onError:[\s\S]*this\.queueAssistantOverlayResult\(layer\)/);
  assert.match(shell, /private pendingAssistantResult: string \| null = null/);
  assert.match(shell, /private flushPendingAssistantResult\(\): void/);
  assert.match(shell, /this\.pendingAssistantResult = reply[\s\S]*this\.flushPendingAssistantResult\(\)/);
  assert.match(shell, /await this\.config\.prepareAssistantResultDisplay\(\)[\s\S]*await this\.showAlert\(\s*pending/);
  assert.match(shell, /await this\.showAlert\(\s*pending,[\s\S]*isPending/);
  assert.match(
    shell,
    /const queuedNext = this\.pendingAssistantResult !== null &&[\s\S]*this\.pendingAssistantResultRevision !== revision;[\s\S]*if \(queuedNext\) this\.flushPendingAssistantResult\(\)/,
  );
  const bridgeState = shell.slice(shell.indexOf("assistantBridge.onStateChange"), shell.indexOf("registerWindow"));
  assert.match(bridgeState, /this\.retryPendingAssistantResult\(\)/);
});

test("a retained result retries when the real G2 display reconnects", () => {
  const shell = read("app/ui/shell/shell.ts");
  assert.match(
    shell,
    /retryPendingAssistantResult\(\): void \{[\s\S]*this\.flushDeferredAssistantUi\(\)/,
  );
  const controller = read("app/g2/dashboard-controller.ts");
  const stateCallback = controller.slice(
    controller.indexOf("this.offState = communicator.onStateChange"),
    controller.indexOf("this.offRing = communicator.onRingEvent"),
  );
  assert.match(
    stateCallback,
    /this\.setPhase\(mappedPhase\);[\s\S]*if \(mappedPhase === "connected"\) \{[\s\S]*shell\.retryPendingAssistantResult\(\)/,
  );
});

test("Cockpit projection cannot duplicate the authoritative voice result on the glasses", () => {
  const shell = read("app/ui/shell/shell.ts");
  const subscribe = shell.slice(
    shell.indexOf("private subscribeToTopBarSettings"),
    shell.indexOf("/** Add a window"),
  );
  assert.doesNotMatch(subscribe, /cockpit\.onAssistantResult/,
    "Cockpit is a passive projection of the same G2 turn, not a second UI completion path");
  assert.match(subscribe, /Host MCP CallToolResult is the sole authority/);

  const bridge = read("app/assistant/bridge-client.ts");
  const send = bridge.slice(bridge.indexOf("sendUtterance("), bridge.indexOf("private connect"));
  assert.match(send, /this\.hostMcpClient\.callVoiceTurn/);
  assert.match(send, /turn\.callbacks\.onTurnDone\(\{ stopReason: result\.stopReason, text: result\.text \}\)/);
});

test("legacy bridge progress is inert and only the Host MCP terminal result completes the UI turn", () => {
  const bridge = read("app/assistant/bridge-client.ts");
  const frames = bridge.slice(bridge.indexOf("private handleMessage"), bridge.indexOf("private handleCtl"));
  const send = bridge.slice(bridge.indexOf("sendUtterance("), bridge.indexOf("private connect"));

  assert.match(frames, /case "chat":\s*\n\s*return; \/\/ Legacy custom turns are never an authority path\./);
  assert.doesNotMatch(bridge, /private handleChat|text-delta|tool-activity|turn-done/);
  assert.match(send, /this\.hostMcpClient\.callVoiceTurn/);
  assert.match(send, /turn\.callbacks\.onTurnDone\(\{ stopReason: result\.stopReason, text: result\.text \}\)/);
  assert.doesNotMatch(send, /onTextDelta|onToolActivity/);
});

test("completed short and interactive results cross the same wake barrier", () => {
  const shell = read("app/ui/shell/shell.ts");
  const shortResult = shell.slice(
    shell.indexOf("private flushPendingAssistantResult"),
    shell.indexOf("private startAssistantFollowUp"),
  );
  const interactive = shell.slice(
    shell.indexOf("private flushPendingAssistantOverlay"),
    shell.indexOf("private flushPendingAssistantResult"),
  );
  assert.doesNotMatch(
    shortResult.slice(0, shortResult.indexOf("const pending")),
    /!this\.screenOn/,
    "screen-off must not block entry into the wake path",
  );
  assert.ok(
    shortResult.indexOf("this.pendingAssistantResultDelivery = true") <
      shortResult.indexOf("await this.config.prepareAssistantResultDisplay()"),
    "delivery gate must be installed before shell.wake re-enters deferred flushing",
  );
  assert.ok(
    shortResult.indexOf("await this.config.prepareAssistantResultDisplay()") <
      shortResult.indexOf("await this.showAlert"),
    "short result must wait for display readiness before strict alert delivery",
  );
  assert.match(
    shortResult,
    /await this\.showAlert\([\s\S]*"until-dismiss-or-sleep"/,
    "completed short results must remain until explicit dismissal or global display sleep",
  );
  assert.ok(
    interactive.indexOf("await this.config.prepareAssistantResultDisplay()") <
      interactive.indexOf("this.restoreBackgroundAssistantLayer(layer)"),
    "interactive result must wait for display readiness before becoming visible",
  );
  assert.ok(
    interactive.indexOf("await this.config.waitForShellRenderIdle()") <
      interactive.indexOf("this.restoreBackgroundAssistantLayer(layer)"),
    "interactive result must drain ordinary rendering before installing its card",
  );
  assert.ok(
    interactive.indexOf("this.restoreBackgroundAssistantLayer(layer)") <
      interactive.indexOf("await this.config.requestShellDelivery(isOwner)"),
    "interactive result must retain retry ownership until its own frame ACK",
  );
  const installedToStrict = interactive.slice(
    interactive.indexOf("this.restoreBackgroundAssistantLayer(layer)"),
    interactive.indexOf("await this.config.requestShellDelivery(isOwner)"),
  );
  assert.doesNotMatch(installedToStrict, /requestShellRender/,
    "no ordinary render may race the installed card's first strict frame");
  assert.match(interactive,
    /const receipt = await this\.config\.requestShellDelivery\(isOwner\);[\s\S]*receipt\.frameId <= 0[\s\S]*!isSuccessfulFrameOutcome\(receipt\.outcome\)[\s\S]*this\.assistantOverlayRestorePending = false/);

  const controller = read("app/g2/dashboard-controller.ts");
  assert.match(controller, /prepareAssistantResultDisplay:\s*\(isAllowed\)\s*=>\s*this\.prepareAssistantResultDisplay\(isAllowed\)/);
  const prepare = controller.slice(
    controller.indexOf("private async prepareAssistantResultDisplay"),
    controller.indexOf("private repaintForWake"),
  );
  assert.match(prepare, /beginAssistantResultDisplay/);
  assert.match(prepare, /acquireWake:\s*\(\)\s*=>\s*shell\.acquireAssistantResultWake\("sidebar"\)/);
  assert.match(prepare, /awaitReady:\s*\(\)\s*=>\s*this\.ensureEvenHubSessionActive\(\)/);
  assert.match(prepare, /this\.communicator === communicator/);
  assert.match(prepare, /rollbackWake:[\s\S]*shell\.rollbackAssistantResultWake/);
});

test("a visually hidden active turn no longer prevents idle display sleep", () => {
  const shell = read("app/ui/shell/shell.ts");
  const timeout = shell.slice(shell.indexOf("applyScreenTimeout("), shell.indexOf("openNotificationModal("));
  assert.match(
    timeout,
    /const visibleAssistantTurn =[\s\S]*this\.assistantSession\?\.isTurnActive\(\)[\s\S]*!this\.assistantTurnBackgrounded/,
  );
  assert.match(
    timeout,
    /this\.activeVoiceLayer[\s\S]*visibleAssistantTurn[\s\S]*this\.screenTimeoutHolds\.size > 0[\s\S]*this\.musicCard/,
    "an explicit foreground hold suspends idle sleep without making hidden agent work visible",
  );
  assert.doesNotMatch(timeout, /this\.activeVoiceLayer \|\| this\.assistantSession\?\.isTurnActive\(\)/);
  assert.doesNotMatch(timeout, /alertLayer/, "a persistent result must still yield to the global screen timeout");
  const sleep = shell.slice(shell.indexOf("sleep(): void"), shell.indexOf("acquireAssistantResultWake"));
  assert.match(sleep, /this\.stack\.clearToBase\(\)/, "global sleep removes the persistent result card");
  assert.match(sleep, /this\.alertLayer = null;[\s\S]*this\.alertRevision\+\+;/,
    "sleep retires both the retained card and any in-flight strict ownership");
});

test("installed and accepted completed presentations start a fresh global reading interval", () => {
  const shell = read("app/ui/shell/shell.ts");
  const restart = shell.slice(
    shell.indexOf("private restartScreenTimeout"),
    shell.indexOf("/** Turn the screen on"),
  );
  assert.match(restart, /this\.lastInputAtMs = nowMs/);
  assert.doesNotMatch(restart, /assistantResultWakeOwnership/,
    "presentation timing must not invalidate a provisional direct-result wake lease");

  const alert = shell.slice(shell.indexOf("async showAlert("), shell.indexOf("/** Replace the one shell-owned MCP view"));
  const pushed = alert.indexOf("this.stack.push(layer)");
  const installedBaseline = alert.indexOf("this.restartScreenTimeout()", pushed);
  const delivered = alert.indexOf("await (abortPromise");
  const rebased = alert.indexOf("this.restartScreenTimeout()", delivered);
  const timerArmed = alert.indexOf("layer.armTransientDismissTimer()", delivered);
  const committed = alert.indexOf("onStrictFrameAcknowledged?.()", delivered);
  assert.ok(pushed >= 0 && pushed < installedBaseline && installedBaseline < delivered,
    "installation prevents a stale idle deadline from racing strict delivery");
  assert.ok(delivered >= 0 && delivered < rebased && rebased < timerArmed && timerArmed < committed,
    "accepted presentation restarts global reading time and only then arms transient expiry before wake commit");

  const interactive = shell.slice(
    shell.indexOf("private flushPendingAssistantOverlay"),
    shell.indexOf("private flushPendingAssistantResult"),
  );
  assert.match(interactive, /this\.restoreBackgroundAssistantLayer\(layer\)[\s\S]*this\.restartScreenTimeout\(\);[\s\S]*await this\.config\.requestShellDelivery\(isOwner\)/);
  assert.match(interactive, /await this\.config\.requestShellDelivery\(isOwner\)[\s\S]*isSuccessfulFrameOutcome\(receipt\.outcome\)[\s\S]*this\.restartScreenTimeout\(\)/);
});

test("an unacknowledged interactive result releases input ownership and remains retryable", () => {
  const shell = read("app/ui/shell/shell.ts");
  const interactive = shell.slice(
    shell.indexOf("private flushPendingAssistantOverlay"),
    shell.indexOf("private flushPendingAssistantResult"),
  );
  assert.match(interactive,
    /const retainedForRetry = !strictAcknowledged && this\.assistantLayer === layer;[\s\S]*this\.rehideAssistantOverlayForRetry\(layer\);[\s\S]*startDetachedCleanup\(\(\) => this\.config\.requestShellRender\(\)\)/,
    "no-change, superseded, or thrown strict delivery must detach before best-effort repaint");

  const rehide = shell.slice(
    shell.indexOf("private rehideAssistantOverlayForRetry"),
    shell.indexOf("async notifyAssistantResult", shell.indexOf("private rehideAssistantOverlayForRetry")),
  );
  assert.match(rehide, /if \(this\.assistantLayer !== layer\) return false/);
  assert.match(rehide, /this\.stack\.detach\(layer\)/,
    "retryable failure must not fire AssistantLayer teardown");
  assert.match(rehide, /this\.assistantTurnBackgrounded = true/);
  assert.match(rehide, /this\.assistantOverlayRestorePending = true/);

  const input = shell.slice(
    shell.indexOf("async receiveInput("),
    shell.indexOf("foregroundWindow():", shell.indexOf("async receiveInput(")),
  );
  const releaseIndex = input.indexOf("this.rehideUnacknowledgedAssistantOverlayBeforeInput()");
  const stackRouteIndex = input.indexOf("if (!this.stack.isAtBase())");
  assert.ok(releaseIndex >= 0 && releaseIndex < stackRouteIndex,
    "input must release a provisional card before choosing the top-layer route");
  const provisional = shell.slice(
    shell.indexOf("private rehideUnacknowledgedAssistantOverlayBeforeInput"),
    shell.indexOf("private restoreBackgroundAssistantLayer"),
  );
  assert.match(provisional, /this\.assistantOverlayDelivery/);
  assert.match(provisional, /this\.assistantOverlayRestorePending/);
  assert.match(provisional, /this\.stack\.topMatches/);
  assert.match(provisional, /this\.rehideAssistantOverlayForRetry\(layer\)/);

  assert.match(shell,
    /retryPendingAssistantResult\(\): void \{[\s\S]*this\.flushDeferredAssistantUi\(\)/,
    "the retained exact layer must retry after a display recovery edge");
});

test("sleep teardown during an unresolved strict result cannot poison the next assistant turn", async () => {
  const { LifecycleHarness } = await loadAssistantOverlayLifecycleHarness();
  const subject = new LifecycleHarness();

  subject.sendToAssistant("first");
  const firstLayer = subject.assistantLayer;
  subject.session.finish("First clarification?");
  await settleUntil(() => subject.strictRequests.length === 1,
    "the first completed overlay never entered strict delivery");
  assert.equal(subject.stack.layers.at(-1), firstLayer);

  // Global sleep clears the exact installed layer while its transport receipt
  // remains unresolved. Its onRemoved callback must retire all lifecycle flags.
  subject.clearVisibleLayersForSleep();
  assert.equal(subject.assistantLayer, null);
  assert.equal(subject.assistantTurnBackgrounded, false);
  assert.equal(subject.assistantOverlayRestorePending, false);

  subject.sendToAssistant("second");
  const secondLayer = subject.assistantLayer;
  assert.notEqual(secondLayer, firstLayer);
  assert.equal(subject.assistantTurnBackgrounded, true);
  assert.notEqual(subject.stack.layers.at(-1), secondLayer,
    "the new thinking layer stays detached");

  // Input/reconnect while the stale strict send is unresolved cannot install
  // either old or new content or hand input to an invisible result layer.
  assert.equal(subject.rehideUnacknowledgedAssistantOverlayBeforeInput(), false);
  subject.retryPendingAssistantResult();
  assert.notEqual(subject.stack.layers.at(-1), secondLayer);

  subject.session.finish("Second clarification?");
  subject.retryPendingAssistantResult();
  assert.equal(subject.strictRequests.length, 1,
    "the stale strict transaction keeps the new final detached until it retires");

  subject.strictRequests[0].resolve({ frameId: 51, outcome: "sent tiles" });
  await settleUntil(() => subject.assistantOverlayDelivery === false,
    "the stale strict transaction did not retire");
  assert.notEqual(subject.stack.layers.at(-1), firstLayer);
  assert.notEqual(subject.stack.layers.at(-1), secondLayer);

  subject.retryPendingAssistantResult();
  await settleUntil(() => subject.strictRequests.length === 2,
    "the retained second final did not retry after reconnect");
  assert.equal(subject.stack.layers.at(-1), secondLayer);
  assert.equal(subject.assistantOverlayRestorePending, true,
    "logical completion waits for the exact second frame receipt");

  subject.strictRequests[1].resolve({ frameId: 52, outcome: "sent tiles" });
  await settleUntil(() => subject.assistantOverlayRestorePending === false,
    "the second final did not commit after strict delivery");
  assert.equal(subject.stack.layers.at(-1), secondLayer);
});

test("strict result alert waits for ordinary shell rendering before becoming visible", () => {
  const shell = read("app/ui/shell/shell.ts");
  const showAlert = shell.slice(shell.indexOf("async showAlert("), shell.indexOf("/** Replace the one shell-owned MCP view"));
  const waitIndex = showAlert.indexOf("await this.config.waitForShellRenderIdle");
  const pushIndex = showAlert.indexOf("this.stack.push(layer)");
  assert.ok(waitIndex >= 0, "showAlert must wait for the ordinary render slot");
  assert.ok(pushIndex > waitIndex, "the alert must not enter the stack until the render slot is owned");
  assert.match(showAlert, /this\.stack\.topMatches\(\(top\) => top === layer\)/);

  const controller = read("app/g2/dashboard-controller.ts");
  assert.match(controller, /waitForShellRenderIdle:\s*\(\)\s*=>\s*this\.waitForShellRenderIdle\(\)/);
});

test("failed direct delivery releases inbox ownership before cleanup repaint drains", () => {
  const shell = read("app/ui/shell/shell.ts");
  const direct = shell.slice(
    shell.indexOf("async notifyAssistantResult("),
    shell.indexOf("/** Show a compact text popup"),
  );
  const failure = direct.slice(direct.indexOf("} catch (error)"));
  assert.match(failure, /startDetachedCleanup\(\(\) => this\.config\.requestShellRender\(\)\)/);
  assert.doesNotMatch(failure, /await this\.config\.requestShellRender\(\)/);
  assert.ok(
    failure.indexOf("startDetachedCleanup") < failure.indexOf("preparation?.rollback()"),
    "cleanup repaint starts without delaying wake rollback and presenter rejection",
  );
});

test("active turns reject new assistant capture without resetting the live layer", () => {
  const shell = read("app/ui/shell/shell.ts");
  const send = shell.slice(shell.indexOf("\n  sendToAssistant(text"), shell.indexOf("private runAssistantTurn"));
  assert.match(send, /if \(session\.isTurnActive\(\)\) return;/);
  assert.doesNotMatch(send, /restoreBackgroundAssistantLayer/);
  const targets = shell.slice(shell.indexOf("private buildVoiceSendTargets"), shell.indexOf("sendTextToForegroundWindow"));
  assert.match(targets, /this\.isAssistantAvailable\(\) && !this\.assistantSession\?\.isTurnActive\(\)/);
  const followUp = shell.slice(shell.indexOf("private startAssistantFollowUp"), shell.indexOf("private closeAssistantLayer"));
  assert.match(followUp, /if \(session\.isTurnActive\(\)\) return;/);
  assert.doesNotMatch(followUp, /restoreBackgroundAssistantLayer/);
});

test("hands-free capture forwards endpointing through the dashboard action boundary", () => {
  const controller = read("app/g2/dashboard-controller.ts");
  const sharedActions = controller.slice(
    controller.indexOf("const sharedActions"),
    controller.indexOf("this.sharedActions = sharedActions"),
  );
  assert.match(
    sharedActions,
    /startVoiceCapture:\s*\(endpointing\??:\s*boolean\)\s*=>\s*this\.startVoiceCapture\(endpointing\)/,
  );
});
