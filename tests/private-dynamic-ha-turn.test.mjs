import assert from "node:assert/strict";
import test from "node:test";
import { PrivateDynamicHaTurn } from "../hermes-host/private-dynamic-ha-turn.mjs";

const identity = { tenant: "private", device: "phone", connectionGeneration: "connection-1", turnGeneration: "turn-1" };

test("turn driver opens, polls, routes one exact wearer event, then restores before close on cancellation", async () => {
  const controller = new AbortController();
  const calls = [];
  let revision = 1;
  const phone = { async callTool(name, args, options) {
    calls.push({ kind: "phone", name, args, options });
    if (name.endsWith(".read_events")) return { view_id: "opaque_dynamic_view_0001", revision, events: [{
      event_id: "event-1", view_id: "opaque_dynamic_view_0001", revision, action_handle: "opaque_action_handle_0001", kind: "activate",
    }] };
    throw new Error("unexpected phone tool");
  } };
  const runtime = {
    async openLivingRoom(value, options) { calls.push({ kind: "open", value, options }); return { viewId: "opaque_dynamic_view_0001", revision: 1 }; },
    async deliverInput(value, event, options) {
      calls.push({ kind: "deliver", value, event, options }); revision = 2; controller.abort();
      return { state: "on", viewId: "opaque_dynamic_view_0001", revision, changed: true };
    },
    async restoreAndClose(value, options) { calls.push({ kind: "restore-close", value, options }); return { restorations: [{ restored: true }] }; },
  };
  const turn = new PrivateDynamicHaTurn({ runtime, phone, pollIntervalMs: 1, sleep: async () => {} });
  const result = await turn.run(identity, { operationId: "eval-1", signal: controller.signal });
  assert.equal(result.actions, 1);
  assert.equal(calls.filter((call) => call.kind === "deliver").length, 1);
  assert.equal(calls.find((call) => call.kind === "open").options.signal, controller.signal);
  assert.equal(calls.find((call) => call.name?.endsWith(".read_events")).options.signal, controller.signal);
  assert.equal(calls.find((call) => call.kind === "deliver").options.signal, controller.signal);
  assert.equal(calls.at(-1).kind, "restore-close");
  assert.equal(calls.find((call) => call.name?.endsWith(".read_events")).args.revision, 1);
});

test("malformed, foreign, or out-of-order phone events fail closed and still enter restoration", async () => {
  const calls = [];
  const phone = { async callTool() { return { view_id: "other", revision: 1, events: [{ event_id: "x" }] }; } };
  const runtime = {
    async openLivingRoom() { return { viewId: "opaque_dynamic_view_0001", revision: 1 }; },
    async deliverInput() { throw new Error("must not execute"); },
    async restoreAndClose() { calls.push("restore"); return { restorations: [] }; },
  };
  const turn = new PrivateDynamicHaTurn({ runtime, phone, pollIntervalMs: 1, sleep: async () => {} });
  await assert.rejects(() => turn.run(identity, { operationId: "eval-2", signal: new AbortController().signal }), /malformed|stale/i);
  assert.deepEqual(calls, ["restore"]);
});
