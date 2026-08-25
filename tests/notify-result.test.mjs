import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

const settingsUrl = dataUrl(`
  export const getStringSetting = () => "";
  export const hasStoredSecretSetting = () => false;
  export const onSettingsStoreChanged = () => () => {};
  export const removeSecretSetting = () => {};
  export const setStringSetting = () => {};
`);
const policyUrl = dataUrl(transpile(read("app/assistant/display-policy.ts")));
const storeJs = transpile(read("app/assistant/direct-notification-store.ts"))
  .replace('"../native/settings-store"', JSON.stringify(settingsUrl))
  .replace('"./display-policy"', JSON.stringify(policyUrl));
const storeUrl = dataUrl(storeJs);
const handlerJs = transpile(read("app/assistant/notify-result-handler.ts"))
  .replace('"./direct-notification-store"', JSON.stringify(storeUrl));

const {
  DirectNotificationStore,
  DirectNotificationStoreError,
} = await import(storeUrl);
const { createNotifyResultHandler } = await import(dataUrl(handlerJs));
const { BRIDGE_PINNED_PHONE_INPUT_SCHEMAS } = await import(dataUrl(transpile(
  read("app/assistant/bridge-phone-contract-schemas.ts"),
)));

const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const PROACTIVE_G2_CONTEXT = Object.freeze({
  caller: "mcp",
  proactive: true,
  profileId: "even-g2",
  connectionGeneration: "connection-1",
  turnGeneration: null,
});
const invoke = (handler, args, signal, isAllowed, context = PROACTIVE_G2_CONTEXT) =>
  handler(args, signal, isAllowed, context);

function memoryStore(options = {}) {
  let encoded = options.encoded ?? "";
  let saves = 0;
  const store = new DirectNotificationStore({
    persistence: {
      hasStoredValue: () => options.storedValuePresent ?? Boolean(encoded),
      load: () => encoded,
      save: (next) => {
        saves++;
        if (options.failSave) throw new Error("secure write failed");
        options.onSave?.();
        encoded = next;
      },
      purge: () => { encoded = ""; },
    },
    digest,
    now: () => 1_700_000_000_000 + saves,
  });
  return { store, encoded: () => encoded, saves: () => saves };
}

function handlerFor(store) {
  return createNotifyResultHandler({
    enqueueResult: (operationId, text, guard) => store.accept({ operationId, text }, guard),
  });
}

test("durable acceptance returns queued; only a strict-delivery tombstone becomes historical", async () => {
  const subject = memoryStore();
  const handler = handlerFor(subject.store);
  const request = { operation_id: "agent-final.1", text: "  Front door is locked.  " };

  const first = await invoke(handler, request);
  assert.deepEqual(JSON.parse(first.content), {
    status: "queued", operation_id: "agent-final.1",
  });
  assert.equal(subject.saves(), 1, "queued is returned only after encrypted persistence.save completes");
  const pendingReplay = await invoke(handler, {
    operation_id: "agent-final.1", text: "Front door is locked.",
  });
  assert.equal(JSON.parse(pendingReplay.content).status, "queued");
  assert.equal(subject.saves(), 1, "pending idempotent replay does not rewrite or display");

  const pending = subject.store.snapshot().pending[0];
  subject.store.acknowledge({
    operationHash: pending.operationHash,
    digest: pending.digest,
    insertionRevision: pending.insertionRevision,
  });
  const deliveredReplay = await invoke(handler, {
    operation_id: "agent-final.1", text: "Front door is locked.",
  });
  assert.equal(JSON.parse(deliveredReplay.content).status, "historical_acknowledgement");
});

test("operation conflicts and capacity failures are explicit without reflecting private text", async () => {
  const subject = memoryStore();
  const handler = handlerFor(subject.store);
  await invoke(handler, { operation_id: "same", text: "Original private result" });
  const conflict = await invoke(handler, { operation_id: "same", text: "Different private result" });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /reused with different/);
  assert.doesNotMatch(conflict.error, /Original|Different|private/);

  for (let index = 1; index < 32; index++) {
    const accepted = await invoke(handler, { operation_id: `fill-${index}`, text: `Result ${index}` });
    assert.equal(accepted.ok, true);
  }
  const full = await invoke(handler, { operation_id: "overflow", text: "Must stay private" });
  assert.equal(full.ok, false);
  assert.match(full.error, /inbox is full/);
  assert.doesNotMatch(full.error, /Must stay private/);
});

test("malformed IDs, payload shapes, and non-inert text never reach persistence", async () => {
  const subject = memoryStore();
  const handler = handlerFor(subject.store);
  for (const args of [
    { operation_id: "bad/id", text: "Ready." },
    { operation_id: "ok", text: "https://example.test" },
    { operation_id: "ok", text: "<b>Ready</b>" },
    { operation_id: "ok", text: "x".repeat(161) },
    { operation_id: "ok", text: "line one\nline two" },
    { operation_id: "ok", text: `unsafe ${String.fromCharCode(0x202e)}` },
    { operation_id: "ok", text: `unsafe ${String.fromCharCode(0xd800)}` },
    { operation_id: "ok", text: "Ready.", extra: true },
  ]) {
    const result = await invoke(handler, args);
    assert.equal(result.ok, false, JSON.stringify(args));
  }
  assert.equal(subject.saves(), 0);
});

test("only authenticated proactive even-g2 calls can mutate the phone-owned inbox", async () => {
  const subject = memoryStore();
  const handler = handlerFor(subject.store);
  const request = { operation_id: "context-1", text: "Final result." };
  const rejectedContexts = [
    null,
    { caller: "direct", proactive: false, profileId: "even-g2", connectionGeneration: "c", turnGeneration: null },
    { caller: "mcp", proactive: false, profileId: "even-g2", connectionGeneration: "c", turnGeneration: null },
    { caller: "mcp", proactive: true, profileId: "custom", connectionGeneration: "c", turnGeneration: null },
    { caller: "mcp", proactive: true, profileId: "even-g2", connectionGeneration: "c", turnGeneration: "turn-1" },
    { caller: "mcp", proactive: true, profileId: "even-g2", turnGeneration: null },
  ];
  for (const context of rejectedContexts) {
    const result = await invoke(handler, request, undefined, undefined, context);
    assert.equal(result.ok, false, JSON.stringify(context));
    assert.match(result.error, /authenticated proactive calls/);
  }
  assert.equal(subject.saves(), 0);
  assert.equal((await invoke(handler, request)).ok, true);
});

test("abort and proactive revocation are checked at the synchronous durable transaction", async () => {
  const subject = memoryStore();
  const handler = handlerFor(subject.store);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await invoke(handler,
    { operation_id: "aborted", text: "Do not retain" }, aborted.signal)).ok, false);

  let allowed = false;
  assert.equal((await invoke(handler,
    { operation_id: "revoked", text: "Do not retain" }, undefined, () => allowed)).ok, false);
  assert.equal(subject.saves(), 0);

  allowed = true;
  const accepted = await invoke(handler,
    { operation_id: "allowed", text: "Retain atomically" }, undefined, () => allowed);
  assert.equal(JSON.parse(accepted.content).status, "queued");
  assert.equal(subject.saves(), 1);
});

test("authorization changing immediately after secure save still reports the committed queue truth", async () => {
  let allowed = true;
  const subject = memoryStore({ onSave: () => { allowed = false; } });
  const result = await invoke(
    handlerFor(subject.store),
    { operation_id: "commit-race", text: "Already durable" },
    undefined,
    () => allowed,
  );
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(result.content).status, "queued");
  assert.equal(subject.store.snapshot().pending.length, 1);
});

test("persistence and unreadable-ciphertext failures fail closed without content leakage", async () => {
  for (const subject of [
    memoryStore({ failSave: true }),
    memoryStore({ storedValuePresent: true, encoded: "" }),
  ]) {
    const result = await invoke(handlerFor(subject.store), {
      operation_id: "private-op", text: "Highly private result body",
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /encrypted direct-notification inbox is unavailable/);
    assert.doesNotMatch(result.error, /private-op|Highly private|result body/);
  }
});

test("handler maps store error codes without accepting arbitrary implementation errors", async () => {
  for (const [code, expected] of [
    ["operation_conflict", /reused with different/],
    ["capacity", /inbox is full/],
    ["superseded", /no longer authorized/],
    ["persistence_failed", /inbox is unavailable/],
    ["stale", /inbox is unavailable/],
    ["unavailable", /inbox is unavailable/],
  ]) {
    const handler = createNotifyResultHandler({
      enqueueResult: () => { throw new DirectNotificationStoreError(code); },
    });
    const result = await invoke(handler, { operation_id: "safe", text: "Private text" });
    assert.equal(result.ok, false);
    assert.match(result.error, expected);
    assert.doesNotMatch(result.error, /Private text/);
  }
  const arbitrary = createNotifyResultHandler({ enqueueResult: () => { throw new Error("Private text"); } });
  const result = await invoke(arbitrary, { operation_id: "safe", text: "Private text" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "The direct notification could not be retained safely");
});

test("phone wiring uses the durable inbox and does not acknowledge from the MCP handler", () => {
  const tools = read("app/assistant/system-tools.ts");
  const registration = tools.slice(
    tools.indexOf('name: "glasses.notify_result"'),
    tools.indexOf("let renderViewManager"),
  );
  assert.match(registration, /BRIDGE_PINNED_PHONE_INPUT_SCHEMAS\["glasses\.notify_result"\]/);
  assert.deepEqual(BRIDGE_PINNED_PHONE_INPUT_SCHEMAS["glasses.notify_result"].required,
    ["operation_id", "text"]);
  assert.equal(BRIDGE_PINNED_PHONE_INPUT_SCHEMAS["glasses.notify_result"].properties.text.maxLength, 160);
  assert.match(registration, /proactive:\s*true/);
  assert.match(registration, /directNotificationInbox\.acceptResult/);
  assert.doesNotMatch(registration, /shell\.notifyAssistantResult/);

  const handler = read("app/assistant/notify-result-handler.ts");
  assert.match(handler, /context\?\.caller === "mcp"/);
  assert.match(handler, /context\.proactive === true/);
  assert.match(handler, /deps\.enqueueResult\(args\.operation_id, text, isAuthorized\)/);
  assert.match(handler, /status: "queued" \| "historical_acknowledgement"/);
  assert.doesNotMatch(handler, /notifyAssistantResult|status:\s*"acknowledged"/,
    "MCP acceptance must not claim wearer-visible delivery");

  const store = read("app/assistant/direct-notification-store.ts");
  assert.match(store, /DIRECT_NOTIFICATION_STORAGE_KEY = "assistant\.directNotifications\.v1"/);
  assert.match(store, /operationHash:\s*string/);
  assert.doesNotMatch(store, /operationId:\s*string;[\s\S]*type DirectNotificationDocument/,
    "raw operation IDs must not be part of the persisted document schema");
});
