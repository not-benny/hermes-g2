import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const load = async (path) => {
  const js = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
};

const { AssistantResultWakeOwnership, prepareAtomicAssistantResultLayer } = await load("app/ui/shell/assistant-result-wake.ts");
const { beginAssistantResultDisplayWake, runAssistantResultDisplayWake } = await load("app/g2/assistant-result-display.ts");
const { TrackedFrameEvidenceWaiters } = await load("app/g2/tracked-frame-evidence.ts");
const { awaitWithAbortSignal, isStrictLayerOwner, startDetachedCleanup } = await load("app/ui/shell/strict-layer-owner.ts");

function harness(initiallyOn) {
  const ownership = new AssistantResultWakeOwnership();
  let screenOn = initiallyOn;
  let wakes = 0;
  let sleeps = 0;
  let rebaselines = 0;
  return {
    ownership,
    screenOn: () => screenOn,
    wakes: () => wakes,
    sleeps: () => sleeps,
    rebaselines: () => rebaselines,
    acquire: () => ownership.acquire(screenOn, () => {
      wakes++;
      screenOn = true;
      return true;
    }, () => {
      rebaselines++;
    }),
    commit: (lease) => ownership.commit(lease),
    rollback: (lease) => ownership.rollback(lease, () => screenOn, () => {
      sleeps++;
      screenOn = false;
    }),
  };
}

function deferredReadiness() {
  let release;
  return {
    promise: () => new Promise((resolve) => { release = resolve; }),
    release: (value) => release(value),
  };
}

test("sleep-origin atomic result remains uninstalled until the blank wake render drains", async () => {
  const drain = deferredReadiness();
  const events = [];
  const preparation = { ready: true, rollback: () => events.push("rollback") };
  const pending = prepareAtomicAssistantResultLayer({
    enterIsolation: () => events.push("isolate-blank"),
    prepare: async () => { events.push("wake-ready"); return preparation; },
    isReadyCurrent: () => true,
    drainBlankRender: async () => {
      events.push("blank-drain-start");
      await drain.promise();
      events.push("blank-drain-finished");
    },
    installFinalLayer: () => events.push("install-final"),
    releaseIsolationIfAsleep: () => events.push("release-isolation"),
  });
  await Promise.resolve();
  assert.deepEqual(events, ["isolate-blank", "wake-ready", "blank-drain-start"]);
  assert.equal(events.includes("install-final"), false);
  drain.release();
  assert.equal(await pending, preparation);
  assert.deepEqual(events, [
    "isolate-blank", "wake-ready", "blank-drain-start", "blank-drain-finished", "install-final",
  ]);
});

test("superseded atomic wake rolls back without ever installing the final layer", async () => {
  const events = [];
  let current = true;
  await assert.rejects(prepareAtomicAssistantResultLayer({
    enterIsolation: () => events.push("isolate-blank"),
    prepare: async () => ({ ready: true, rollback: () => events.push("rollback") }),
    isReadyCurrent: () => current,
    drainBlankRender: async () => { current = false; events.push("drained"); },
    installFinalLayer: () => events.push("install-final"),
    releaseIsolationIfAsleep: () => events.push("release-isolation"),
  }));
  assert.deepEqual(events, ["isolate-blank", "drained", "rollback", "release-isolation"]);
});

test("revocation during EvenHub readiness rolls back the exact wake it created", async () => {
  const screen = harness(false);
  const readiness = deferredReadiness();
  let allowed = true;
  const pending = runAssistantResultDisplayWake({
    isAllowed: () => allowed,
    canPrepare: () => true,
    acquireWake: screen.acquire,
    awaitReady: readiness.promise,
    isReadyCurrent: screen.screenOn,
    commitWake: screen.commit,
    rollbackWake: screen.rollback,
  });
  assert.equal(screen.screenOn(), true);
  assert.equal(screen.wakes(), 1);
  allowed = false;
  readiness.release(true);
  assert.equal(await pending, false);
  assert.equal(screen.sleeps(), 1);
  assert.equal(screen.screenOn(), false);
});

test("revocation never blanks a pre-existing display or another owner's wake", async () => {
  for (const otherOwnerClaimsWake of [false, true]) {
    const screen = harness(!otherOwnerClaimsWake);
    const readiness = deferredReadiness();
    let allowed = true;
    const pending = runAssistantResultDisplayWake({
      isAllowed: () => allowed,
      canPrepare: () => true,
      acquireWake: screen.acquire,
      awaitReady: readiness.promise,
      isReadyCurrent: screen.screenOn,
      commitWake: screen.commit,
      rollbackWake: screen.rollback,
    });
    assert.equal(screen.screenOn(), true);
    if (otherOwnerClaimsWake) screen.ownership.invalidate();
    allowed = false;
    readiness.release(true);
    assert.equal(await pending, false);
    assert.equal(screen.sleeps(), 0, otherOwnerClaimsWake ? "other owner" : "pre-existing screen");
    assert.equal(screen.screenOn(), true);
  }
});

test("overlapping assistant waiters transfer rollback ownership and any accepted waiter commits it", () => {
  const rejected = harness(false);
  const first = rejected.acquire();
  const second = rejected.acquire();
  assert.equal(rejected.rollback(first), false);
  assert.equal(rejected.rollback(second), true);
  assert.equal(rejected.sleeps(), 1);

  const accepted = harness(false);
  const older = accepted.acquire();
  const newer = accepted.acquire();
  accepted.commit(older);
  assert.equal(accepted.rollback(newer), false);
  assert.equal(accepted.sleeps(), 0);
});

test("a direct result retains provisional wake ownership after readiness until strict ACK", async () => {
  const screen = harness(false);
  const transaction = await beginAssistantResultDisplayWake({
    isAllowed: () => true,
    canPrepare: () => true,
    acquireWake: screen.acquire,
    awaitReady: async () => true,
    isReadyCurrent: screen.screenOn,
    commitWake: screen.commit,
    rollbackWake: screen.rollback,
  });
  assert.equal(transaction.ready, true);
  assert.equal(screen.screenOn(), true);
  transaction.rollback();
  assert.equal(screen.sleeps(), 1, "pre-ACK failure must still own and roll back the wake");

  const acknowledged = harness(false);
  const committed = await beginAssistantResultDisplayWake({
    isAllowed: () => true,
    canPrepare: () => true,
    acquireWake: acknowledged.acquire,
    awaitReady: async () => true,
    isReadyCurrent: acknowledged.screenOn,
    commitWake: acknowledged.commit,
    rollbackWake: acknowledged.rollback,
  });
  committed.commit();
  committed.rollback();
  assert.equal(acknowledged.sleeps(), 0, "post-ACK rollback must be inert");
});

test("current-epoch frame evidence unblocks a hanging readiness barrier", async () => {
  const screen = harness(false);
  const owner = {};
  const waiters = new TrackedFrameEvidenceWaiters();
  let current = true;
  let hasEvidence = false;
  const pending = beginAssistantResultDisplayWake({
    isAllowed: () => true,
    canPrepare: () => current,
    acquireWake: screen.acquire,
    awaitReady: () => new Promise(() => {}),
    awaitTrackedFrameEvidence: () =>
      waiters.wait(owner, 7, () => current, () => hasEvidence),
    isReadyCurrent: screen.screenOn,
    commitWake: screen.commit,
    rollbackWake: screen.rollback,
  });
  assert.equal(waiters.pendingCount(), 1);
  hasEvidence = true;
  waiters.signal(owner, 7);
  const transaction = await pending;
  assert.equal(transaction.ready, true,
    "current evidence must win without waiting for hung create-layout bookkeeping");
  assert.equal(waiters.pendingCount(), 0);
  transaction.rollback();
  assert.equal(screen.sleeps(), 1,
    "tracked evidence does not commit the provisional wake before the result's own strict ACK");
});

test("evidence invalidation rejects and removes a hanging direct waiter", async () => {
  const screen = harness(false);
  const owner = {};
  const waiters = new TrackedFrameEvidenceWaiters();
  const pending = beginAssistantResultDisplayWake({
    isAllowed: () => true,
    canPrepare: () => true,
    acquireWake: screen.acquire,
    awaitReady: () => new Promise(() => {}),
    awaitTrackedFrameEvidence: () =>
      waiters.wait(owner, 3, () => true, () => false),
    isReadyCurrent: screen.screenOn,
    commitWake: screen.commit,
    rollbackWake: screen.rollback,
  });
  assert.equal(waiters.pendingCount(), 1);
  waiters.invalidate();
  const transaction = await pending;
  assert.equal(transaction.ready, false);
  assert.equal(waiters.pendingCount(), 0);
  assert.equal(screen.sleeps(), 1);
});

test("stale communicator or epoch evidence cannot settle a current waiter", async () => {
  const waiters = new TrackedFrameEvidenceWaiters();
  const currentOwner = {};
  const staleOwner = {};
  let evidence = false;
  const waiting = waiters.wait(currentOwner, 11, () => true, () => evidence);
  waiters.signal(staleOwner, 11);
  waiters.signal(currentOwner, 10);
  assert.equal(waiters.pendingCount(), 1,
    "neither a stale communicator nor stale epoch may consume the waiter");
  evidence = true;
  waiters.signal(currentOwner, 11);
  assert.equal(await waiting.promise, true);
  assert.equal(waiters.pendingCount(), 0);

  const immediate = waiters.wait(currentOwner, 11, () => true, () => true);
  assert.equal(await immediate.promise, true,
    "already-recorded current evidence must resolve immediately");
  assert.equal(waiters.pendingCount(), 0);
});

test("a readiness winner cleans up its losing evidence waiter", async () => {
  const screen = harness(false);
  const waiters = new TrackedFrameEvidenceWaiters();
  const transaction = await beginAssistantResultDisplayWake({
    isAllowed: () => true,
    canPrepare: () => true,
    acquireWake: screen.acquire,
    awaitReady: async () => true,
    awaitTrackedFrameEvidence: () =>
      waiters.wait({}, 1, () => true, () => false),
    isReadyCurrent: screen.screenOn,
    commitWake: screen.commit,
    rollbackWake: screen.rollback,
  });
  assert.equal(transaction.ready, true);
  assert.equal(waiters.pendingCount(), 0,
    "Promise.race must not retain the losing event waiter");
  transaction.rollback();
});

test("late evidence cannot authorize after presentation authority is revoked", async () => {
  const screen = harness(false);
  const waiters = new TrackedFrameEvidenceWaiters();
  const owner = {};
  let allowed = true;
  const pending = beginAssistantResultDisplayWake({
    isAllowed: () => allowed,
    canPrepare: () => true,
    acquireWake: screen.acquire,
    awaitReady: () => new Promise(() => {}),
    awaitTrackedFrameEvidence: () =>
      waiters.wait(owner, 1, () => true, () => false),
    isReadyCurrent: screen.screenOn,
    commitWake: screen.commit,
    rollbackWake: screen.rollback,
  });
  allowed = false;
  waiters.signal(owner, 1);
  const rejected = await pending;
  assert.equal(rejected.ready, false);
  assert.equal(screen.sleeps(), 1);
  assert.equal(waiters.pendingCount(), 0);
});

test("authorization is checked before acquiring a wake", async () => {
  const screen = harness(false);
  assert.equal(await runAssistantResultDisplayWake({
    isAllowed: () => false,
    canPrepare: () => true,
    acquireWake: screen.acquire,
    awaitReady: async () => true,
    isReadyCurrent: screen.screenOn,
    commitWake: screen.commit,
    rollbackWake: screen.rollback,
  }), false);
  assert.equal(screen.wakes(), 0);
  assert.equal(screen.sleeps(), 0);
});

test("failed strict delivery never waits for a best-effort cleanup render", async () => {
  let started = 0;
  let release;
  const cleanup = new Promise((resolve) => { release = resolve; });
  assert.equal(startDetachedCleanup(() => {
    started++;
    return cleanup;
  }), undefined);
  assert.equal(started, 1);
  release();
  await cleanup;

  assert.doesNotThrow(() => startDetachedCleanup(() => {
    throw new Error("cleanup failed synchronously");
  }));
});

test("cancellation releases a direct result from unresolved display preparation", async () => {
  const controller = new AbortController();
  const neverPrepared = new Promise(() => {});
  const pending = awaitWithAbortSignal(
    neverPrepared,
    controller.signal,
    "cancelled during preparation",
  );
  controller.abort();
  await assert.rejects(pending, /cancelled during preparation/);
});

test("cancellation releases a direct result from an unresolved shell-idle wait", async () => {
  const controller = new AbortController();
  const neverIdle = new Promise(() => {});
  const pending = awaitWithAbortSignal(
    neverIdle,
    controller.signal,
    "cancelled while waiting for idle",
  );
  controller.abort();
  await assert.rejects(pending, /cancelled while waiting for idle/);
});

test("an authorized direct result rebaselines an already-on display before readiness", async () => {
  const screen = harness(true);
  const readiness = deferredReadiness();
  let rebaselinesObservedDuringReadiness = 0;
  const pending = beginAssistantResultDisplayWake({
    isAllowed: () => true,
    canPrepare: () => true,
    acquireWake: screen.acquire,
    awaitReady: () => {
      rebaselinesObservedDuringReadiness = screen.rebaselines();
      return readiness.promise();
    },
    isReadyCurrent: screen.screenOn,
    commitWake: screen.commit,
    rollbackWake: screen.rollback,
  });

  assert.equal(screen.rebaselines(), 1);
  assert.equal(rebaselinesObservedDuringReadiness, 1,
    "the timeout clock must reset before asynchronous display preparation");
  assert.equal(screen.wakes(), 0, "an already-on display does not need a physical wake");
  readiness.release(true);
  const transaction = await pending;
  assert.equal(transaction.ready, true);
  transaction.commit();
});

test("authoritative lock availability blocks before wake and revokes during readiness", async () => {
  const prelocked = harness(false);
  assert.equal(await runAssistantResultDisplayWake({
    isAllowed: () => true,
    canPrepare: () => false,
    acquireWake: prelocked.acquire,
    awaitReady: async () => true,
    isReadyCurrent: prelocked.screenOn,
    commitWake: prelocked.commit,
    rollbackWake: prelocked.rollback,
  }), false);
  assert.equal(prelocked.wakes(), 0);

  const duringWake = harness(false);
  const readiness = deferredReadiness();
  let unlocked = true;
  const pending = runAssistantResultDisplayWake({
    isAllowed: () => true,
    canPrepare: () => unlocked,
    acquireWake: duringWake.acquire,
    awaitReady: readiness.promise,
    isReadyCurrent: duringWake.screenOn,
    commitWake: duringWake.commit,
    rollbackWake: duringWake.rollback,
  });
  assert.equal(duringWake.screenOn(), true);
  unlocked = false;
  readiness.release(true);
  assert.equal(await pending, false);
  assert.equal(duringWake.sleeps(), 1);
});

test("strict layer ownership is lost as soon as another overlay becomes top", () => {
  const alert = {};
  assert.equal(isStrictLayerOwner(4, 4, alert, alert, true), true);
  assert.equal(isStrictLayerOwner(4, 4, alert, alert, false), false);
  assert.equal(isStrictLayerOwner(4, 5, alert, alert, true), false);
  assert.equal(isStrictLayerOwner(4, 4, alert, {}, true), false);
});

test("shell and controller wire confirmed-current wear through transactional strict delivery", () => {
  const shell = read("app/ui/shell/shell.ts");
  const notify = shell.slice(shell.indexOf("async notifyAssistantResult("), shell.indexOf("async showAlert("));
  assert.match(notify, /prepareDirectAssistantResultDisplay\(isWakeOwner\)/);
  assert.match(notify,
    /awaitWithAbortSignal\(\s*this\.config\.prepareDirectAssistantResultDisplay\(isWakeOwner\),\s*signal/,
    "direct preparation must release inbox ownership when its AbortSignal is revoked");
  assert.match(notify,
    /awaitWithAbortSignal\(\s*this\.config\.waitForShellRenderIdle\(\),\s*signal/,
    "the ordinary render drain must not retain inbox ownership after cancellation");
  assert.match(notify, /isDirectAssistantResultPresentationAllowed/);
  assert.match(notify, /this\.directNotificationLayer === null/);
  assert.match(notify, /this\.directNotificationLayer = directLayer/);
  assert.match(notify, /const returnToSleepOnClose = !this\.screenOn/);
  assert.match(notify, /ownsPriorSleep && wasTop && this\.screenOn\) this\.sleep\(\)/,
    "dismissing a direct result that woke the lens restores sleep rather than the HUD");
  const secureAck = notify.indexOf("presentation.onStrictFrameAcknowledged()");
  const wakeCommit = notify.indexOf("preparation!.commit()");
  const cue = notify.indexOf('playEventBeep("assistantReply"');
  assert.ok(secureAck >= 0 && secureAck < wakeCommit,
    "encrypted tombstone commit must run synchronously before wake lease commit");
  assert.ok(wakeCommit < cue, "the audible cue is presentation-only and follows strict commit");
  assert.match(notify, /headerTrailing:\s*directHeader\.trailing/,
    "queue position is drawn separately so timestamp truncation cannot hide it");
  assert.match(notify, /markCloseReason\("preempted"\)/);
  const alert = shell.slice(shell.indexOf("async showAlert("), shell.indexOf("async showRemoteView("));
  assert.match(alert, /isStrictLayerOwner\(/);
  assert.match(alert, /this\.stack\.topMatches\(\(top\) => top === layer\)/);
  assert.doesNotMatch(alert, /directNotificationLayer\s*=/,
    "ordinary alerts must not replace the dedicated direct-notification slot");

  const sleep = shell.slice(shell.indexOf("sleep(): void"), shell.indexOf("acquireAssistantResultWake"));
  assert.match(sleep, /markCloseReason\("sleep"\)/);
  assert.match(sleep, /this\.stack\.clearToBase\(\)/);
  assert.match(sleep, /suppressDirectNotificationOpportunity = true/);
  const opportunity = shell.slice(
    shell.indexOf("private notifyDirectNotificationOpportunity"),
    shell.indexOf("retryPendingAssistantResult"),
  );
  assert.match(opportunity, /this\.screenOn && !this\.suppressDirectNotificationOpportunity/);
  assert.match(alert, /onRemoved:\s*\(\) => this\.notifyDirectNotificationOpportunity\(\)/,
    "ordinary-alert teardown during sleep must not schedule a FIFO wake");
  const acquireWake = shell.slice(
    shell.indexOf("acquireAssistantResultWake"),
    shell.indexOf("commitAssistantResultWake"),
  );
  assert.match(acquireWake, /restartScreenTimeout\(\)/,
    "an already-on authorized result must rebaseline timeout before readiness");

  const controller = read("app/g2/dashboard-controller.ts");
  assert.match(controller, /prepareAssistantResultDisplay:\s*\(isAllowed\)\s*=>\s*this\.prepareAssistantResultDisplay\(isAllowed\)/);
  assert.match(controller, /isAssistantResultPresentationAllowed:\s*\(\)\s*=>\s*this\.isAssistantResultPresentationAllowed\(\)/);
  assert.match(controller, /isDirectAssistantResultPresentationAllowed:\s*\(\)\s*=>\s*this\.isDirectAssistantResultPresentationAllowed\(\)/);
  assert.match(controller, /prepareDirectAssistantResultDisplay:\s*\(isAllowed\)\s*=>\s*this\.beginDirectAssistantResultDisplay\(isAllowed\)/);
  assert.match(controller,
    /onDirectNotificationOpportunity:\s*\(\)\s*=>\s*directNotificationInbox\.retryPresentationAfterLayerTeardown\(\)/,
    "shell layer removal uses the non-retaining retry path");
  const displayWake = controller.slice(
    controller.indexOf('const displayShouldWake = event.kind === "display-wake"'),
    controller.indexOf('frameTimings.spanStart(frameId, "handle-input")'),
  );
  assert.match(displayWake,
    /if \(displayShouldWake\) \{[\s\S]*directNotificationInbox\.retryPresentation\(\)/,
    "an explicit firmware display wake retries even when the shell still believes it is on");
  const prepare = controller.slice(
    controller.indexOf("private async prepareAssistantResultDisplay"),
    controller.indexOf("private repaintForWake"),
  );
  assert.match(prepare, /beginDirectAssistantResultDisplay/);
  assert.match(prepare, /acquireAssistantResultWake/);
  assert.match(prepare, /rollbackAssistantResultWake/);
  assert.match(prepare, /this\.isAssistantResultPresentationAllowed\(\)/);
  assert.match(prepare, /this\.isDirectAssistantResultPresentationAllowed\(\)/);
  assert.match(prepare, /allowTrackedFrameEvidence && communicator !== null[\s\S]*waitForCurrentTrackedShellFrameEvidence/,
    "only direct queued results may race exact tracked frame evidence against readiness");
  assert.match(prepare, /awaitTrackedFrameEvidence/);
  assert.match(prepare, /this\.communicator === communicator/,
    "the wake transaction must retain exact communicator identity");
  assert.match(controller,
    /isReadinessFrameEvidenceOutcome\(outcome\)[\s\S]*trackedFrameEpoch === this\.trackedShellFrameEpoch[\s\S]*this\.trackedShellFrameEvidence =[\s\S]*trackedShellFrameEvidenceWaiters\.signal\(communicator, trackedFrameEpoch\)/,
    "fallback evidence must come from a sent or exact no-change frame in the current lifecycle epoch");
  assert.match(controller,
    /if \(requireSent && !isSuccessfulFrameOutcome\(outcome\)\)/,
    "the direct result card must still reject no-change and every other non-sent receipt");
  assert.match(controller,
    /this\.phase === "connected" && phase !== "connected"[\s\S]*invalidateTrackedShellFrameEvidence\(\)/,
    "disconnect must cancel current-epoch evidence waiters rather than leave a hung preparation");
  assert.match(controller, /invalidateTrackedShellFrameEvidence\(\)[\s\S]*directNotificationInbox\.pauseUntilNextOpportunity\(\)/,
    "sleep or firmware exit must invalidate physical-frame evidence before a later retry");
  assert.match(controller, /return !this\.glassesLocked && !this\.lockSurfaceVisible/);

  const wearGate = controller.slice(
    controller.indexOf("private currentDirectNotificationWearState"),
    controller.indexOf("private isDirectAssistantResultPresentationAllowed"),
  );
  assert.match(wearGate, /this\.phase === "connected"/);
  assert.match(wearGate, /this\.communicator !== null/);
  assert.match(wearGate, /this\.wearNotifySupported/);
  assert.match(wearGate, /this\.glassesWorn === true/);
  assert.match(wearGate, /return "unknown"/,
    "unsupported/null wear must fail closed rather than authorize presentation");
  assert.match(controller, /assistantAllowProactiveSetting\.get\(\)[\s\S]*currentDirectNotificationWearState\(\) === "worn"/,
    "presentation must live-gate the proactive privacy setting as well as wear");
  assert.match(controller, /directNotificationInbox\.setPresentationEnabled\(assistantAllowProactiveSetting\.get\(\)\)/);
  assert.match(controller, /directNotificationInbox\.pauseUntilNextOpportunity\(\)/,
    "screen sleep invalidates deferred queue wake ownership");
  const firmwareExit = controller.slice(
    controller.indexOf("if (event.kind === \"sys-event\")"),
    controller.indexOf("if (outcome.shell)", controller.indexOf("if (event.kind === \"sys-event\")")),
  );
  assert.match(firmwareExit,
    /FOREGROUND_EXIT_EVENT[\s\S]*ABNORMAL_EXIT_EVENT[\s\S]*SYSTEM_EXIT_EVENT[\s\S]*directNotificationInbox\.pauseUntilNextOpportunity\(\)/,
    "firmware layout exit revokes an active pre-ACK direct card");
  const frameMetrics = controller.slice(
    controller.indexOf("this.offFrameMetrics = communicator.onFrameMetrics"),
    controller.indexOf("this.offFirmwareInfo = communicator.onFirmwareInfo"),
  );
  assert.match(frameMetrics, /this\.phase === "connected"[\s\S]*directNotificationInbox\.retryPresentation\(\)/,
    "a later successful compositor frame must recover a retained pre-ACK notification");
  assert.match(controller, /onWearState\(\(wearing\) => \{[\s\S]*this\.wearStateSession !== session[\s\S]*this\.communicator !== communicator/,
    "wear callbacks must retain both exact transport generation and communicator identity");
  assert.match(controller, /setPhase\(mappedPhase\);\s*this\.syncDirectNotificationWearState\(\);/);
});
