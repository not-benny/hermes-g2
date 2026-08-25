import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const source = read("app/g2/wear-state-requery.ts");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { WearStateRequery } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

class FakeScheduler {
  records = [];

  schedule(callback, delayMs) {
    const record = { callback, delayMs, active: true };
    this.records.push(record);
    return record;
  }

  cancel(record) {
    record.active = false;
  }

  fire(record) {
    record.active = false;
    record.callback();
  }

  active() {
    return this.records.filter((record) => record.active);
  }
}

function harness(maxAttempts = 3) {
  const scheduler = new FakeScheduler();
  const state = {
    session: null,
    connected: false,
    supported: true,
    worn: null,
  };
  const requests = [];
  const inboxWearStates = [];
  const retry = new WearStateRequery({
    scheduler,
    isEligible: (session) =>
      state.session === session &&
      state.connected &&
      state.supported &&
      state.worn === null,
    requestState: (session) => { requests.push(session); },
  }, maxAttempts, 5_000);

  const begin = (session) => {
    state.session = session;
    state.connected = true;
    state.worn = null;
    retry.begin(session);
  };
  const cancel = () => {
    const session = state.session;
    state.connected = false;
    state.worn = null;
    state.session = null;
    retry.cancel(session);
  };
  const wear = (session, wearing) => {
    if (!state.connected || !state.supported || state.session !== session) return false;
    retry.resolve(session);
    state.worn = wearing;
    inboxWearStates.push(wearing ? "worn" : "not-worn");
    return true;
  };
  return { scheduler, state, requests, inboxWearStates, retry, begin, cancel, wear };
}

test("reconnect drops the first wear reply, retries once, then confirmed worn pumps the inbox", () => {
  const subject = harness();
  const communicator = {};
  const oldSession = { communicator, generation: 1 };
  const newSession = { communicator, generation: 2 };

  subject.begin(oldSession);
  const staleTimer = subject.scheduler.active()[0];
  subject.cancel();

  subject.begin(newSession);
  subject.retry.begin(newSession);
  assert.deepEqual(subject.requests, [oldSession, newSession],
    "reconciling the same session must not issue a duplicate query");
  const firstRetry = subject.scheduler.active()[0];

  // A canceled callback can already be queued by the platform. Exact session
  // identity makes it inert after reconnect.
  subject.scheduler.fire(staleTimer);
  assert.deepEqual(subject.requests, [oldSession, newSession]);
  assert.equal(subject.wear(oldSession, true), false,
    "a queued callback from the old generation of the same communicator is stale");
  assert.deepEqual(subject.inboxWearStates, []);

  // No wear callback follows the first new-session request. The bounded timer
  // re-queries, and its fresh callback authorizes the queued inbox exactly once.
  subject.scheduler.fire(firstRetry);
  assert.deepEqual(subject.requests, [oldSession, newSession, newSession]);
  const postRetryTimer = subject.scheduler.active()[0];
  assert.equal(subject.wear(newSession, true), true);
  assert.deepEqual(subject.inboxWearStates, ["worn"]);
  assert.equal(subject.scheduler.active().length, 0, "fresh wear cancels the remaining retry");

  subject.scheduler.fire(postRetryTimer);
  assert.deepEqual(subject.requests, [oldSession, newSession, newSession],
    "a timer already queued before the callback cannot query after resolution");
});

test("one session owns one timer and remains bounded after the final attempt", () => {
  const subject = harness(3);
  const session = { generation: 1 };
  subject.begin(session);

  while (subject.scheduler.active().length) {
    assert.equal(subject.scheduler.active().length, 1, "there is never more than one retry timer");
    subject.scheduler.fire(subject.scheduler.active()[0]);
  }
  assert.equal(subject.requests.length, 3);

  subject.retry.begin(session);
  subject.retry.begin(session);
  assert.equal(subject.requests.length, 3, "lifecycle reconciliation cannot restart an exhausted session");
  assert.equal(subject.scheduler.active().length, 0);
});

test("disconnect, charging, and full-close cancellation leave queued timers and stale callbacks inert", () => {
  for (const reason of ["disconnect", "charging", "full close"]) {
    const subject = harness();
    const session = { reason };
    subject.begin(session);
    const timer = subject.scheduler.active()[0];
    subject.cancel();

    subject.scheduler.fire(timer);
    assert.equal(subject.requests.length, 1, `${reason}: canceled timer queried again`);
    assert.equal(subject.wear(session, true), false, `${reason}: stale wear callback was accepted`);
    assert.deepEqual(subject.inboxWearStates, []);
  }
});

test("controller wiring retires retry authority on every terminal path and accepts only current worn callbacks", () => {
  const controller = read("app/g2/dashboard-controller.ts");
  const begin = controller.slice(
    controller.indexOf("private beginWearStateSession"),
    controller.indexOf("private handlePhoneLockState"),
  );
  assert.match(begin, /this\.wearStateSession !== session/);
  assert.match(begin, /this\.communicator !== communicator/);
  assert.match(begin, /this\.phase !== "connected"/);
  assert.match(begin, /!this\.wearNotifySupported/);
  assert.ok(begin.indexOf("wearStateRequery.resolve(session)") < begin.indexOf("handleWearState(wearing)"),
    "fresh wear must cancel the timer before it pumps the direct inbox");

  const stateChange = controller.slice(
    controller.indexOf("this.offState = communicator.onStateChange"),
    controller.indexOf("this.offRing = communicator.onRingEvent"),
  );
  assert.match(stateChange, /mappedPhase === "connected"[\s\S]*beginWearStateSession\(communicator!\)/);
  assert.match(stateChange, /mappedPhase !== "connected"[\s\S]*retireWearStateSession\(\)/,
    "disconnecting, disconnected, retrying, and charging all retire the query session");

  const close = controller.slice(
    controller.indexOf("private completePendingCommunicatorClose"),
    controller.indexOf("async disconnect()"),
  );
  assert.match(close, /retireWearStateSession\(\)/);
  const disconnect = controller.slice(
    controller.indexOf("async disconnect()"),
    controller.indexOf("launchDebugAllowlistedApp"),
  );
  assert.match(disconnect, /if \(this\.phase === "disconnected"\) return;\s*this\.retireWearStateSession\(\)/);

  const native = read("app/native/faceclaw-communicator.ts");
  assert.match(native, /if \(state\.phase !== "connected"\) this\.latestWearState = null/);
  assert.match(native, /if \(this\.latestPhase !== "connected"\) return;/,
    "the bridge must not cache a native wear callback after its session ended");

  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawBleCommunicator.java");
  const emitWear = java.slice(
    java.indexOf("private void emitWearState"),
    java.indexOf("private void emitPhoneLockStateIfChanged"),
  );
  assert.match(emitWear, /deliveryGeneration\s*=\s*currentGlassesConnectionGeneration\(\)/);
  assert.match(emitWear, /deliveryGeneration\s*!=\s*currentGlassesConnectionGeneration\(\)[\s\S]*return;/,
    "a wear callback posted by an old native connection generation must not cross reconnect");
  assert.ok(
    emitWear.indexOf("deliveryGeneration != currentGlassesConnectionGeneration()") <
      emitWear.indexOf("current.onWearState(wearing)"),
    "native generation authority must be checked before crossing into TypeScript",
  );
});
