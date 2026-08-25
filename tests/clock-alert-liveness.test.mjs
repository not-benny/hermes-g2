import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const coordinatorSource = read("app/clock/alert-coordinator.ts")
  .replace(/^import[\s\S]*?;\n/gm, "");
const harness = `
class ClockAlertTimeline {
  sizeValue = 0;
  size() { return this.sizeValue; }
  clear() { this.sizeValue = 0; }
  entriesSnapshot() { return []; }
  remove() {}
  setWearState() {}
  add() {}
  restoreTiming() {}
  restoreRouting() {}
  project() { return { phase: "idle", active: [], expired: [], nextTransitionAtMs: null }; }
  startPending() { return []; }
  shiftStarted() {}
}
const clockStore = {};
const clockSchedulerBridge = {
  clearCampaigns() {},
  dismissNotification() {},
};
const buildClockAlertPayload = () => new Uint8Array();
const CLOCK_ALERT_PHRASE_MS = 1_000;
`;
const coordinatorJs = ts.transpileModule(`${harness}\n${coordinatorSource}`, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { ClockAlertCoordinator } = await import(
  `data:text/javascript;base64,${Buffer.from(coordinatorJs).toString("base64")}`
);

function fakeStore(initialOccurrences) {
  const occurrences = initialOccurrences.map((occurrence) => ({ ...occurrence }));
  const dismissed = [];
  return {
    dismissed,
    snapshot() {
      return {
        available: true,
        revision: 1,
        timers: [],
        alarms: [],
        worldClocks: [],
        occurrences: occurrences.map((occurrence) => ({ ...occurrence })),
      };
    },
    dismissOccurrence(id) {
      dismissed.push(id);
      const index = occurrences.findIndex((occurrence) => occurrence.id === id);
      if (index >= 0) occurrences.splice(index, 1);
    },
  };
}

const occurrence = (id, status) => ({
  id,
  itemId: `item-${id}`,
  kind: "timer",
  status,
  dueAtMs: 1_000,
  wasOffHead: true,
});

test("terminal Clock feedback cancels its retry and releases durable silent input ownership", () => {
  const store = fakeStore([
    occurrence("silent-a", "silent"),
    occurrence("silent-b", "silent"),
  ]);
  const coordinator = new ClockAlertCoordinator(store, () => 2_000);
  coordinator.summary = { kind: "timer", label: "Two timers", count: 2 };
  coordinator.visualSignature = "failed-terminal-frame";
  const retry = setTimeout(() => assert.fail("terminal visual retry was not cancelled"), 60_000);
  coordinator.phaseTimer = retry;
  const epoch = coordinator.cancellationEpoch;

  assert.equal(coordinator.releaseTerminalVisualForForeground(), true);
  assert.deepEqual(store.dismissed, ["silent-a", "silent-b"]);
  assert.equal(coordinator.summary, null);
  assert.equal(coordinator.visualSignature, null);
  assert.equal(coordinator.phaseTimer, null);
  assert.equal(coordinator.cancellationEpoch, epoch + 1);
});

test("an active Clock timeline cannot yield its visual to a foreground dashboard", () => {
  const store = fakeStore([occurrence("active", "silent")]);
  const coordinator = new ClockAlertCoordinator(store, () => 2_000);
  coordinator.timeline.sizeValue = 1;
  coordinator.summary = { kind: "timer", label: "Active timer", count: 1 };
  const epoch = coordinator.cancellationEpoch;

  assert.equal(coordinator.releaseTerminalVisualForForeground(), false);
  assert.deepEqual(store.dismissed, []);
  assert.notEqual(coordinator.summary, null);
  assert.equal(coordinator.cancellationEpoch, epoch);
});

test("a newly durable pending occurrence blocks yield before timeline reconciliation", () => {
  const store = fakeStore([occurrence("pending", "pending")]);
  const coordinator = new ClockAlertCoordinator(store, () => 2_000);

  assert.equal(coordinator.ownsBuzzer(), false);
  assert.equal(coordinator.releaseTerminalVisualForForeground(), false);
  assert.deepEqual(store.dismissed, []);
});

test("dynamic apps gate stale work before atomically replacing terminal Clock chrome", () => {
  const shell = read("app/ui/shell/shell.ts");
  const show = shell.slice(
    shell.indexOf("async showDynamicApp("),
    shell.indexOf("clearDynamicApp(", shell.indexOf("async showDynamicApp(")),
  );
  assert.ok(show.indexOf("The dynamic app operation is stale") < show.indexOf("releaseTerminalClockAlertLayer()"));
  assert.match(show, /clockAlertLayer && !this\.releaseTerminalClockAlertLayer\(\)/);
  const release = shell.slice(
    shell.indexOf("private releaseTerminalClockAlertLayer"),
    shell.indexOf("isClockAlertVisible", shell.indexOf("private releaseTerminalClockAlertLayer")),
  );
  assert.match(release, /releaseTerminalClockAlertVisual\?\.\(\) !== true/);
  assert.match(release, /this\.clockAlertLayer = null;[\s\S]*this\.stack\.remove\(layer\)/);
  assert.doesNotMatch(release, /requestShellRender/,
    "the dashboard replacement owns the next paint, avoiding an exposed HUD frame");

  const controller = read("app/g2/dashboard-controller.ts");
  assert.match(controller, /releaseTerminalClockAlertVisual: \(\) =>[\s\S]*releaseTerminalVisualForForeground\(\)/);
});
