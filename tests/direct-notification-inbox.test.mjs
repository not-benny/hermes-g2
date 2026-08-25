import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

const shellUrl = dataUrl(`
  export const shell = {
    canStartDirectAssistantResultPresentation: () => false,
    notifyAssistantResult: async () => { throw new Error("unused singleton"); },
  };
`);
const storeUrl = dataUrl(`
  export const directNotificationStore = {
    accept: () => { throw new Error("unused singleton"); },
    snapshot: () => ({ available: false, revision: 0, pending: [] }),
    acknowledge: () => false,
    onChange: () => () => {},
  };
`);
const inboxJs = transpile(read("app/assistant/direct-notification-inbox.ts"))
  .replace('"../ui/shell/shell"', JSON.stringify(shellUrl))
  .replace('"./direct-notification-store"', JSON.stringify(storeUrl));
const { DirectNotificationInbox } = await import(dataUrl(inboxJs));

const hash = (seed) => seed.padEnd(64, seed[0] ?? "0").slice(0, 64).replace(/[^a-f0-9]/g, "a");

class FakeStore {
  pending = [];
  nextRevision = 1;
  failAcknowledge = false;
  events = [];
  available = true;
  listeners = new Set();

  accept({ operationId, text }, guard) {
    if (guard && !guard()) throw new Error("superseded");
    const existing = this.pending.find((item) => item.operationId === operationId);
    if (existing) return { status: "queued", identity: this.identity(existing) };
    const item = {
      operationId,
      operationHash: hash(operationId),
      digest: hash(`d${operationId}`),
      text,
      receivedAtMs: 1_700_000_000_000 + this.nextRevision,
      insertionRevision: this.nextRevision++,
    };
    this.pending.push(item);
    this.emit();
    return { status: "queued", identity: this.identity(item) };
  }

  snapshot() {
    return {
      available: this.available,
      revision: this.nextRevision,
      pending: this.pending.map(({ operationId, ...item }) => ({ ...item })),
    };
  }

  acknowledge(identity, guard) {
    this.events.push("secure-ack-start");
    if (guard && !guard()) throw new Error("superseded");
    if (this.failAcknowledge) {
      this.failAcknowledge = false;
      this.events.push("secure-ack-failed");
      throw new Error("secure write failed");
    }
    const index = this.pending.findIndex((item) =>
      item.operationHash === identity.operationHash &&
      item.digest === identity.digest &&
      item.insertionRevision === identity.insertionRevision);
    if (index < 0) throw new Error("stale");
    this.pending.splice(index, 1);
    this.events.push("secure-ack-committed");
    this.emit();
    return true;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  replacePending(items) {
    this.pending = items;
    this.emit();
  }

  setAvailable(available) {
    this.available = available;
    if (!available) this.pending = [];
    this.emit();
  }

  identity(item) {
    return {
      operationHash: item.operationHash,
      digest: item.digest,
      insertionRevision: item.insertionRevision,
    };
  }
}

function harness(presentImplementation, options = {}) {
  const deferred = [];
  const store = new FakeStore();
  const presentations = [];
  const presenter = {
    canStart: options.canStart ?? (() => true),
    present: async (notification, position, total, signal, isAllowed, onStrictFrameAcknowledged, onClosed) => {
      const presentation = { notification, position, total, signal, isAllowed, onStrictFrameAcknowledged, onClosed };
      presentations.push(presentation);
      return presentImplementation
        ? presentImplementation(presentation, store, presentations.length)
        : (() => {
            onStrictFrameAcknowledged();
            return { acknowledged: true, successAllowed: true };
          })();
    },
  };
  const inbox = new DirectNotificationInbox({
    store,
    presenter,
    defer: (callback) => deferred.push(callback),
    ...options.dependencies,
  });
  return { inbox, store, presentations, deferred };
}

function manualDeadlines() {
  const deadlines = [];
  return {
    dependencies: {
      presentationDeadlineMs: 25,
      setPresentationDeadline(callback, delayMs) {
        const deadline = { callback, delayMs, cancelled: false };
        deadlines.push(deadline);
        return deadline;
      },
      clearPresentationDeadline(handle) {
        handle.cancelled = true;
      },
    },
    deadlines,
    fireNext() {
      const deadline = deadlines.find((candidate) => !candidate.cancelled);
      assert.ok(deadline, "expected an armed presentation deadline");
      assert.equal(deadline.delayMs, 25);
      deadline.cancelled = true;
      deadline.callback();
    },
  };
}

async function runDeferred(subject) {
  assert.ok(subject.deferred.length, "expected a deferred presentation attempt");
  while (subject.deferred.length) {
    subject.deferred.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("debug diagnostics expose only content-free scheduling and presentation state", async () => {
  let rejectPresentation;
  const subject = harness(() => new Promise((_resolve, reject) => {
    rejectPresentation = reject;
  }));
  assert.deepEqual(subject.inbox.getDiagnostics(), {
    active: false,
    scheduled: false,
    paused: false,
    presentationEnabled: true,
    retryRetained: false,
  });

  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("diagnostics", "Private result text");
  assert.equal(subject.inbox.getDiagnostics().scheduled, true);
  await runDeferred(subject);
  assert.deepEqual(subject.inbox.getDiagnostics(), {
    active: true,
    scheduled: false,
    paused: false,
    presentationEnabled: true,
    retryRetained: false,
  });

  subject.inbox.retryPresentation();
  assert.equal(subject.inbox.getDiagnostics().retryRetained, true);
  subject.inbox.setPresentationEnabled(false);
  assert.deepEqual(subject.inbox.getDiagnostics(), {
    active: true,
    scheduled: false,
    paused: false,
    presentationEnabled: false,
    retryRetained: false,
  });
  rejectPresentation(new Error("debug test release"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.inbox.getDiagnostics().active, false);
});

test("unknown and confirmed off-head states retain FIFO records without presenting", async () => {
  const subject = harness();
  subject.inbox.acceptResult("one", "First result");
  assert.equal(subject.store.pending.length, 1);
  assert.equal(subject.deferred.length, 0);
  subject.inbox.setWearState("not-worn");
  assert.equal(subject.deferred.length, 0);

  subject.inbox.setWearState("worn");
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 1);
  assert.equal(subject.presentations[0].notification.text, "First result");
  assert.equal(subject.store.pending.length, 0, "strict ACK tombstones only at presentation");
});

test("one acknowledged FIFO card remains active and explicit dismiss pumps the next", async () => {
  const subject = harness();
  subject.inbox.acceptResult("one", "First result");
  subject.inbox.acceptResult("two", "Second result");
  subject.inbox.setWearState("worn");
  await runDeferred(subject);

  assert.equal(subject.presentations.length, 1);
  assert.deepEqual(
    [subject.presentations[0].position, subject.presentations[0].total],
    [1, 2],
  );
  subject.inbox.retryPresentation();
  assert.equal(subject.deferred.length, 0, "the acknowledged card stays in RAM until closed");

  subject.presentations[0].onClosed("dismissed");
  await runDeferred(subject);
  assert.equal(subject.presentations[1].notification.text, "Second result");
  assert.deepEqual(
    subject.store.events.slice(0, 2),
    ["secure-ack-start", "secure-ack-committed"],
  );
});

test("global timeout/sleep closes the card without waking immediately for the next FIFO item", async () => {
  const subject = harness();
  subject.inbox.acceptResult("one", "First result");
  subject.inbox.acceptResult("two", "Second result");
  subject.inbox.setWearState("worn");
  await runDeferred(subject);

  subject.presentations[0].onClosed("sleep");
  assert.equal(subject.deferred.length, 0, "sleep must not pump the next item");
  assert.equal(subject.presentations.length, 1);

  subject.inbox.retryPresentation();
  await runDeferred(subject);
  assert.equal(subject.presentations[1].notification.text, "Second result");
});

test("global sleep invalidates an already-scheduled wake until a confirmed later opportunity", async () => {
  const subject = harness();
  subject.inbox.acceptResult("sleep-race", "Wait for a real wake");
  subject.inbox.setWearState("worn");
  subject.inbox.pauseUntilNextOpportunity();
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 0);

  subject.inbox.retryPresentation();
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 1);
});

test("a pre-ACK transport failure keeps the same record retryable on a later opportunity", async () => {
  const subject = harness((presentation, _store, attempt) => {
    if (attempt === 1) throw new Error("transport failed before strict ACK");
    presentation.onStrictFrameAcknowledged();
    return { acknowledged: true, successAllowed: true };
  });
  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("retry", "Retry me");
  await runDeferred(subject);
  assert.equal(subject.store.pending.length, 1);
  assert.equal(subject.deferred.length, 0, "failure must not flash-loop");

  subject.inbox.retryPresentation();
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 2);
  assert.equal(subject.store.pending.length, 0);
});

test("a never-settling pre-ACK presenter loses active ownership at the bounded deadline", async () => {
  const clock = manualDeadlines();
  const subject = harness(
    () => new Promise(() => {}),
    { dependencies: clock.dependencies },
  );
  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("deadline", "Keep this encrypted");
  await runDeferred(subject);

  assert.equal(subject.inbox.getDiagnostics().active, true);
  assert.equal(subject.presentations[0].signal.aborted, false);
  clock.fireNext();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subject.presentations[0].signal.aborted, true);
  assert.equal(subject.inbox.getDiagnostics().active, false);
  assert.equal(subject.store.pending.length, 1);
  assert.equal(subject.deferred.length, 0, "a deadline alone is not a retry edge");
});

test("a presenter callback arriving after its deadline cannot tombstone the pending record", async () => {
  const clock = manualDeadlines();
  let resolveLate;
  const subject = harness(
    () => new Promise((resolve) => { resolveLate = resolve; }),
    { dependencies: clock.dependencies },
  );
  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("late-ack", "Never acknowledge this stale clone");
  await runDeferred(subject);

  const stale = subject.presentations[0];
  clock.fireNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => stale.onStrictFrameAcknowledged(),
    /superseded/,
  );
  resolveLate({ acknowledged: true, successAllowed: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subject.store.pending.length, 1);
  assert.equal(subject.store.events.includes("secure-ack-committed"), false);
  assert.equal(subject.inbox.getDiagnostics().active, false);
});

test("one retained external recovery edge survives a stuck presenter's deadline", async () => {
  const clock = manualDeadlines();
  const subject = harness(
    (presentation, _store, attempt) => {
      if (attempt === 1) return new Promise(() => {});
      presentation.onStrictFrameAcknowledged();
      return { acknowledged: true, successAllowed: true };
    },
    { dependencies: clock.dependencies },
  );
  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("deadline-retry", "Retry once after recovery");
  await runDeferred(subject);

  subject.inbox.retryPresentation();
  subject.inbox.retryPresentation();
  assert.equal(subject.inbox.getDiagnostics().retryRetained, true);
  clock.fireNext();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subject.deferred.length, 1, "repeated recovery edges retain one FIFO pump");
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 2);
  assert.equal(subject.store.pending.length, 0);
});

test("a transient unavailable shell slot is rechecked once without polling", async () => {
  let slotAvailable = false;
  const subject = harness(undefined, { canStart: () => slotAvailable });
  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("slot-race", "Wait for the shell slot");
  await runDeferred(subject);

  assert.equal(subject.presentations.length, 0);
  assert.equal(subject.deferred.length, 0, "the bounded recheck must not timer-spin");

  slotAvailable = true;
  subject.inbox.retryPresentationAfterLayerTeardown();
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 1);
  assert.equal(subject.store.pending.length, 0);
});

test("a confirmed wake racing firmware-exit abort retains exactly one retry after active release", async () => {
  const subject = harness((presentation, _store, attempt) => {
    if (attempt > 1) {
      presentation.onStrictFrameAcknowledged();
      return { acknowledged: true, successAllowed: true };
    }
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error("firmware layout exited before strict ACK"));
      presentation.signal.addEventListener("abort", abort, { once: true });
      if (presentation.signal.aborted) abort();
    });
  });
  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("firmware-exit", "Keep me through the layout restart");
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 1);

  // The firmware-exit path revokes the in-flight pre-ACK clone. A real screen
  // wake can arrive synchronously before that rejected promise releases its
  // active token; repeated recovery signals still retain only one FIFO pump.
  subject.inbox.pauseUntilNextOpportunity();
  assert.equal(subject.presentations[0].signal.aborted, true);
  subject.inbox.retryPresentation();
  subject.inbox.retryPresentation();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subject.store.pending.length, 1, "pre-ACK abort keeps the encrypted row");
  assert.equal(subject.deferred.length, 1, "the racing lifecycle edge is retained once");
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 2);
  assert.equal(subject.store.pending.length, 0);
});

test("a pre-ACK teardown callback cannot turn its own failure into a tight retry", async () => {
  let subject;
  subject = harness((presentation, _store, attempt) => {
    if (attempt > 1) {
      presentation.onStrictFrameAcknowledged();
      return { acknowledged: true, successAllowed: true };
    }
    presentation.onClosed("preempted");
    // Models the stack-wide layer-removal opportunity emitted after the
    // direct layer's own onRemoved callback but before rejection settles.
    subject.inbox.retryPresentationAfterLayerTeardown();
    throw new Error("strict frame failed before ACK");
  });
  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("teardown-retry", "Wait for a later opportunity");
  await runDeferred(subject);

  assert.equal(subject.presentations.length, 1);
  assert.equal(subject.store.pending.length, 1);
  assert.equal(subject.deferred.length, 0,
    "the failed card's own teardown must not enqueue another attempt");

  subject.inbox.retryPresentation();
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 2);
  assert.equal(subject.store.pending.length, 0);
});

test("secure ACK failure pauses immediate redisplay but a fresh wear cycle recovers", async () => {
  const subject = harness((presentation) => {
    presentation.onStrictFrameAcknowledged();
    return { acknowledged: true, successAllowed: true };
  });
  subject.store.failAcknowledge = true;
  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("secure-retry", "Keep until secure commit");
  await runDeferred(subject);
  assert.equal(subject.store.pending.length, 1, "failed tombstone write must leave pending text durable");
  assert.equal(subject.deferred.length, 0, "failed tombstone write must not flash-loop");
  assert.equal(subject.inbox.getDiagnostics().paused, true);

  subject.inbox.setWearState("worn");
  assert.equal(subject.deferred.length, 0, "repeated same-state callbacks are not a recovery edge");
  subject.inbox.setWearState("not-worn");
  subject.inbox.setWearState("worn");
  assert.equal(subject.inbox.getDiagnostics().paused, false);
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 2);
  assert.equal(subject.store.pending.length, 0);
});

test("a failed card's own teardown opportunity cannot clear its secure-write pause", async () => {
  let subject;
  subject = harness((presentation) => {
    try {
      presentation.onStrictFrameAcknowledged();
      return { acknowledged: true, successAllowed: true };
    } catch (error) {
      presentation.onClosed("preempted");
      // Models the shell stack's generic layer-removal opportunity firing
      // before notifyAssistantResult's rejected promise settles.
      subject.inbox.retryPresentationAfterLayerTeardown();
      throw error;
    }
  });
  subject.store.failAcknowledge = true;
  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("teardown-pause", "Do not flash-loop");
  await runDeferred(subject);
  assert.equal(subject.store.pending.length, 1);
  assert.equal(subject.deferred.length, 0);
  subject.inbox.setWearState("worn");
  assert.equal(subject.deferred.length, 0);

  subject.inbox.setWearState("not-worn");
  subject.inbox.setWearState("worn");
  await runDeferred(subject);
  assert.equal(subject.store.pending.length, 0);
});

test("wear revocation inside strict ACK prevents a false delivery", async () => {
  const subject = harness((presentation) => {
    subject.inbox.setWearState("unknown");
    presentation.onStrictFrameAcknowledged();
    return { acknowledged: true, successAllowed: true };
  });
  subject.inbox.setWearState("worn");
  subject.inbox.acceptResult("revoked", "Do not lose me");
  await runDeferred(subject);
  assert.equal(subject.store.pending.length, 1);
  assert.equal(subject.store.events.includes("secure-ack-committed"), false);
});

test("live proactive opt-out aborts an exact pre-ACK card, retains it, and re-enable retries", async () => {
  const subject = harness((presentation, _store, attempt) => {
    if (attempt > 1) {
      presentation.onStrictFrameAcknowledged();
      return { acknowledged: true, successAllowed: true };
    }
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error("presentation disabled"));
      presentation.signal.addEventListener("abort", abort, { once: true });
      if (presentation.signal.aborted) abort();
    });
  });
  subject.inbox.acceptResult("opt-out", "Keep encrypted while disabled");
  subject.inbox.setWearState("worn");
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 1);

  subject.inbox.setPresentationEnabled(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.presentations[0].signal.aborted, true);
  assert.equal(subject.store.pending.length, 1);
  assert.equal(subject.deferred.length, 0);

  subject.inbox.setPresentationEnabled(true);
  await runDeferred(subject);
  assert.equal(subject.presentations.length, 2);
  assert.equal(subject.store.pending.length, 0);
});

test("unreadable store state cancels scheduled and active pre-ACK plaintext ownership", async () => {
  const scheduled = harness();
  scheduled.inbox.acceptResult("scheduled", "Never clone after ciphertext loss");
  scheduled.inbox.setWearState("worn");
  scheduled.store.setAvailable(false);
  await runDeferred(scheduled);
  assert.equal(scheduled.presentations.length, 0,
    "an invalidated deferred callback must not acquire a plaintext clone");

  const active = harness((presentation) => new Promise((_resolve, reject) => {
    const abort = () => reject(new Error("encrypted document unavailable"));
    presentation.signal.addEventListener("abort", abort, { once: true });
    if (presentation.signal.aborted) abort();
  }));
  active.inbox.acceptResult("active", "Scrub this exact clone");
  active.inbox.setWearState("worn");
  await runDeferred(active);
  active.store.setAvailable(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.presentations[0].signal.aborted, true);
  assert.equal(active.store.events.includes("secure-ack-committed"), false);
  assert.equal(active.deferred.length, 0);
});

test("valid external head replacement revokes pre-ACK old text and retries the replacement", async () => {
  const subject = harness((presentation, _store, attempt) => {
    if (attempt > 1) {
      presentation.onStrictFrameAcknowledged();
      return { acknowledged: true, successAllowed: true };
    }
    return new Promise((_resolve, reject) => {
      presentation.signal.addEventListener("abort", () => reject(new Error("head replaced")), { once: true });
    });
  });
  subject.inbox.acceptResult("old", "Old private text");
  subject.inbox.setWearState("worn");
  await runDeferred(subject);
  const replacement = {
    operationId: "new",
    operationHash: hash("new"),
    digest: hash("dnew"),
    text: "New private text",
    receivedAtMs: 1_700_000_000_500,
    insertionRevision: 50,
  };
  subject.store.replacePending([replacement]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.presentations[0].signal.aborted, true);
  await runDeferred(subject);
  assert.equal(subject.presentations[1].notification.text, "New private text");
  assert.equal(subject.store.pending.length, 0);
});

test("post-ACK RAM-held card survives store unavailability until its own close lifecycle", async () => {
  const subject = harness();
  subject.inbox.acceptResult("shown", "Already shown");
  subject.inbox.setWearState("worn");
  await runDeferred(subject);
  assert.equal(subject.store.pending.length, 0);
  subject.store.setAvailable(false);
  assert.equal(subject.presentations[0].signal.aborted, false,
    "the ACKed card no longer depends on its tombstoned queue row");
  subject.presentations[0].onClosed("sleep");
  assert.equal(subject.deferred.length, 0);
});
