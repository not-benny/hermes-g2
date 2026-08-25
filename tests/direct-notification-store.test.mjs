import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const dataUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

const settingsStubUrl = dataUrl(`
  export const getStringSetting = () => "";
  export const hasStoredSecretSetting = () => false;
  export const onSettingsStoreChanged = () => () => {};
  export const removeSecretSetting = () => {};
  export const setStringSetting = () => {};
`);
const policyUrl = dataUrl(transpile(read("app/assistant/display-policy.ts")));
const storeJs = transpile(read("app/assistant/direct-notification-store.ts"))
  .replace('"../native/settings-store"', JSON.stringify(settingsStubUrl))
  .replace('"./display-policy"', JSON.stringify(policyUrl));
const storeModule = await import(dataUrl(storeJs));

const {
  DirectNotificationStore,
  DirectNotificationStoreError,
  MAX_DIRECT_NOTIFICATION_ENCODED_BYTES,
  MAX_DIRECT_NOTIFICATION_TOMBSTONES,
  MAX_PENDING_DIRECT_NOTIFICATIONS,
  decodeDirectNotificationDocument,
  normalizeDirectNotificationText,
} = storeModule;

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function assertStoreError(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof DirectNotificationStoreError);
    assert.equal(error.code, code);
    assert.equal(error.message, code, "persistence errors must remain content-free");
    return true;
  });
}

/**
 * Models the production secret-setting boundary: the store sees plaintext only
 * through load/save, while the durable representation is authenticated cipher
 * text. Tests can restart stores against the same vault and inspect either side
 * of that boundary deliberately.
 */
function createEncryptedVault(initialPlaintext = null) {
  const key = Buffer.alloc(32, 0x5a);
  const listeners = new Set();
  let durable = null;
  let failNextSave = false;
  let failNextPurge = false;
  let successfulSaves = 0;
  let saveAttempts = 0;

  const seal = (plaintext) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const open = (ciphertext) => {
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length < 28) throw new Error("unreadable");
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(12, 28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  };

  if (initialPlaintext !== null) durable = seal(initialPlaintext);

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    persistence: {
      hasStoredValue: () => durable !== null,
      load: () => durable === null ? "" : open(durable),
      save: (plaintext) => {
        saveAttempts++;
        if (failNextSave) {
          failNextSave = false;
          throw new Error("secure write failed");
        }
        durable = seal(plaintext);
        successfulSaves++;
      },
      purge: () => {
        if (failNextPurge) {
          failNextPurge = false;
          throw new Error("secure purge failed");
        }
        durable = null;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    ciphertext: () => durable === null ? null : Buffer.from(durable),
    plaintext: () => durable === null ? "" : open(durable),
    setPlaintext: (plaintext) => {
      durable = seal(plaintext);
      notify();
    },
    setCiphertext: (ciphertext) => {
      durable = ciphertext === null ? null : Buffer.from(ciphertext);
      notify();
    },
    failSaveOnce: () => { failNextSave = true; },
    failPurgeOnce: () => { failNextPurge = true; },
    successfulSaves: () => successfulSaves,
    saveAttempts: () => saveAttempts,
  };
}

function createClock(start = 1_725_000_000_000) {
  let value = start;
  return {
    now: () => value,
    set: (next) => { value = next; },
    tick: (amount = 1) => { value += amount; return value; },
  };
}

function createStore(vault = createEncryptedVault(), clock = createClock(), overrides = {}) {
  return {
    vault,
    clock,
    store: new DirectNotificationStore({
      persistence: vault.persistence,
      digest: sha256,
      now: clock.now,
      ...overrides,
    }),
  };
}

test("durable encrypted FIFO survives restart without persisting raw operation IDs", () => {
  const vault = createEncryptedVault();
  const clock = createClock(1_725_000_000_111);
  const firstStore = createStore(vault, clock).store;

  const first = firstStore.accept({ operationId: "reminder.private-001", text: "Call Alice." });
  clock.set(1_725_000_005_222);
  const second = firstStore.accept({ operationId: "reminder.private-002", text: "Leave for the train." });

  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  assert.deepEqual(firstStore.snapshot().pending.map(({ text, receivedAtMs, insertionRevision }) => ({
    text, receivedAtMs, insertionRevision,
  })), [
    { text: "Call Alice.", receivedAtMs: 1_725_000_000_111, insertionRevision: 1 },
    { text: "Leave for the train.", receivedAtMs: 1_725_000_005_222, insertionRevision: 2 },
  ]);
  assert.equal(firstStore.peek().text, "Call Alice.", "peek is the FIFO head");

  const decrypted = vault.plaintext();
  const document = JSON.parse(decrypted);
  assert.equal(document.revision, 2);
  assert.deepEqual(document.pending.map((record) => record.operationHash), [
    sha256("reminder.private-001"),
    sha256("reminder.private-002"),
  ]);
  assert.equal(decrypted.includes("reminder.private-001"), false, "raw operation IDs are never persisted");
  assert.equal(decrypted.includes("reminder.private-002"), false, "raw operation IDs are never persisted");

  const durableBytes = vault.ciphertext();
  assert.equal(durableBytes.toString("utf8").includes("Call Alice."), false);
  assert.equal(durableBytes.toString("utf8").includes("reminder.private-001"), false);

  firstStore.dispose();
  const restarted = createStore(vault, clock).store;
  assert.deepEqual(restarted.snapshot().pending.map((record) => record.text), [
    "Call Alice.",
    "Leave for the train.",
  ]);
  assert.equal(restarted.snapshot().revision, 2);

  const detached = restarted.snapshot();
  detached.pending[0].text = "mutated by caller";
  assert.equal(restarted.peek().text, "Call Alice.", "observable snapshots cannot mutate private state");
});

test("pending retries deduplicate exactly while operation-ID conflicts remain protected", () => {
  const { store, vault } = createStore();
  const accepted = store.accept({ operationId: "same-op", text: "Package delivered." });
  const savesAfterFirst = vault.successfulSaves();
  const replay = store.accept({ operationId: "same-op", text: "Package delivered." });

  assert.deepEqual(replay, accepted);
  assert.equal(vault.successfulSaves(), savesAfterFirst, "pending replay does not rewrite the vault");
  assert.equal(store.snapshot().revision, 1);
  assert.equal(store.snapshot().pending.length, 1);
  assertStoreError(
    () => store.accept({ operationId: "same-op", text: "Package delayed." }),
    "operation_conflict",
  );
  assert.equal(store.snapshot().pending[0].text, "Package delivered.");
});

test("strict ACK atomically replaces private text with a bounded durable tombstone", () => {
  const vault = createEncryptedVault();
  const clock = createClock(1000);
  const store = createStore(vault, clock).store;
  const accepted = store.accept({ operationId: "delivered-op", text: "Sensitive final result." });
  const staleCopy = { ...accepted.identity, insertionRevision: accepted.identity.insertionRevision + 1 };

  assertStoreError(() => store.acknowledge(staleCopy), "stale");
  clock.set(2000);
  assert.equal(store.acknowledge(accepted.identity), true);
  assert.equal(store.snapshot().pending.length, 0);
  assert.equal(vault.plaintext().includes("Sensitive final result."), false, "ACK erases private text");

  const persisted = JSON.parse(vault.plaintext());
  assert.deepEqual(persisted.delivered, [{
    operationHash: sha256("delivered-op"),
    digest: sha256("Sensitive final result."),
    receivedAtMs: 1000,
    deliveredAtMs: 2000,
  }]);
  assert.equal(store.acknowledge(accepted.identity), false, "duplicate strict ACK is idempotent");
  assert.deepEqual(store.accept({ operationId: "delivered-op", text: "Sensitive final result." }), {
    status: "historical_acknowledgement",
    identity: null,
  });
  assertStoreError(
    () => store.accept({ operationId: "delivered-op", text: "Changed result." }),
    "operation_conflict",
  );

  store.dispose();
  const restarted = createStore(vault, clock).store;
  assert.equal(
    restarted.accept({ operationId: "delivered-op", text: "Sensitive final result." }).status,
    "historical_acknowledgement",
  );
});

test("pending and tombstone record limits are enforced without eviction of pending work", () => {
  const { store, vault } = createStore();
  for (let index = 0; index < MAX_PENDING_DIRECT_NOTIFICATIONS; index++) {
    store.accept({ operationId: `pending-${index}`, text: `Pending result ${index}.` });
  }
  const beforeCapacityFailure = vault.ciphertext();
  assertStoreError(
    () => store.accept({ operationId: "pending-overflow", text: "Must not evict the head." }),
    "capacity",
  );
  assert.equal(store.snapshot().pending.length, MAX_PENDING_DIRECT_NOTIFICATIONS);
  assert.equal(store.peek().text, "Pending result 0.");
  assert.deepEqual(vault.ciphertext(), beforeCapacityFailure, "capacity failure does not touch durable state");

  const tombstoneVault = createEncryptedVault();
  const clock = createClock(10_000);
  const tombstoneStore = createStore(tombstoneVault, clock).store;
  for (let index = 0; index < MAX_DIRECT_NOTIFICATION_TOMBSTONES + 2; index++) {
    const accepted = tombstoneStore.accept({ operationId: `done-${index}`, text: `Done ${index}.` });
    clock.tick();
    tombstoneStore.acknowledge(accepted.identity);
    clock.tick();
  }
  const document = JSON.parse(tombstoneVault.plaintext());
  assert.equal(document.delivered.length, MAX_DIRECT_NOTIFICATION_TOMBSTONES);
  assert.equal(document.delivered[0].operationHash, sha256("done-2"));
  assert.equal(document.delivered.at(-1).operationHash, sha256("done-129"));
  assert.equal(
    tombstoneStore.accept({ operationId: "done-2", text: "Done 2." }).status,
    "historical_acknowledgement",
  );
  assert.equal(
    tombstoneStore.accept({ operationId: "done-0", text: "Done 0." }).status,
    "queued",
    "an entry outside the explicit 128-operation idempotency window may be queued again",
  );
});

test("oldest tombstones are pruned before 32 KiB can reduce pending capacity", () => {
  const vault = createEncryptedVault();
  const clock = createClock(20_000);
  const store = createStore(vault, clock).store;
  for (let index = 0; index < MAX_DIRECT_NOTIFICATION_TOMBSTONES; index++) {
    const accepted = store.accept({ operationId: `history-${index}`, text: `History ${index}.` });
    clock.tick();
    store.acknowledge(accepted.identity);
    clock.tick();
  }

  for (let index = 0; index < MAX_PENDING_DIRECT_NOTIFICATIONS; index++) {
    store.accept({
      operationId: `large-pending-${index}`,
      text: `${String(index).padStart(2, "0")}-${"x".repeat(156)}`,
    });
  }
  const prunedDocument = JSON.parse(vault.plaintext());
  assert.equal(prunedDocument.pending.length, MAX_PENDING_DIRECT_NOTIFICATIONS);
  assert.ok(prunedDocument.delivered.length < MAX_DIRECT_NOTIFICATION_TOMBSTONES,
    "history, never pending work, pays the encoded-byte budget");
  const lastDurable = vault.ciphertext();
  assert.ok(Buffer.byteLength(vault.plaintext(), "utf8") <= MAX_DIRECT_NOTIFICATION_ENCODED_BYTES);

  assertStoreError(
    () => store.accept({ operationId: "large-final", text: `zz-${"y".repeat(157)}` }),
    "capacity",
  );
  assert.deepEqual(vault.ciphertext(), lastDurable);
  assert.equal(
    decodeDirectNotificationDocument("x".repeat(MAX_DIRECT_NOTIFICATION_ENCODED_BYTES + 1)),
    null,
  );
});

test("unsafe raw Unicode is rejected before trim/NFC while safe text is canonicalized", () => {
  const forbidden = [
    "Ready\u0000", "\nReady", "Ready\r", "Ready\u0085",
    "Ready\u2028later", "Ready\u2029later",
    "\u061cReady", "\u200eReady", "\u200fReady",
    "\u202aReady", "\u202bReady", "\u202cReady", "\u202dReady", "\u202eReady",
    "\u2066Ready", "\u2067Ready", "\u2068Ready", "\u2069Ready",
    `bad-${String.fromCharCode(0xd800)}`,
    `bad-${String.fromCharCode(0xdc00)}`,
  ];
  for (const candidate of forbidden) {
    assert.equal(normalizeDirectNotificationText(candidate), null, JSON.stringify(candidate));
  }

  assert.equal(normalizeDirectNotificationText("  Cafe\u0301 is ready.  "), "Café is ready.");
  assert.equal(normalizeDirectNotificationText("Safe emoji \ud83d\ude80"), "Safe emoji 🚀");
  for (const candidate of ["", "   ", "<b>markup</b>", "`command`", "https://example.test", "x".repeat(161)]) {
    assert.equal(normalizeDirectNotificationText(candidate), null, JSON.stringify(candidate));
  }

  const { store } = createStore();
  const accepted = store.accept({ operationId: "nfc-op", text: "  Cafe\u0301 is ready.  " });
  assert.equal(store.peek().text, "Café is ready.");
  assert.equal(accepted.identity.digest, sha256("Café is ready."));
  for (const [index, text] of forbidden.entries()) {
    assertStoreError(() => store.accept({ operationId: `unsafe-${index}`, text }), "invalid_text");
  }
});

test("operation IDs, digest output, and timestamps are validated before persistence", () => {
  const { store, vault } = createStore();
  for (const operationId of ["", "slash/not-allowed", "space not allowed", "x".repeat(65), "emoji-🚀"]) {
    assertStoreError(() => store.accept({ operationId, text: "Valid result." }), "invalid_operation_id");
  }
  assert.equal(vault.saveAttempts(), 0);

  const invalidDigest = createStore(createEncryptedVault(), createClock(), { digest: () => "not-a-digest" });
  assertStoreError(
    () => invalidDigest.store.accept({ operationId: "op", text: "Valid result." }),
    "unavailable",
  );
  assert.equal(invalidDigest.vault.saveAttempts(), 0);

  const throwingDigest = createStore(createEncryptedVault(), createClock(), { digest: () => { throw new Error("boom"); } });
  assertStoreError(
    () => throwingDigest.store.accept({ operationId: "op", text: "Valid result." }),
    "unavailable",
  );

  const invalidClock = createStore(createEncryptedVault(), createClock(), { now: () => Number.NaN });
  assertStoreError(
    () => invalidClock.store.accept({ operationId: "op", text: "Valid result." }),
    "unavailable",
  );
  assert.equal(invalidClock.vault.saveAttempts(), 0);
});

test("authorization guards deny new, duplicate, historical, and ACK mutations", () => {
  const { store, vault } = createStore();
  const deniedAtStart = vault.saveAttempts();
  assertStoreError(
    () => store.accept({ operationId: "guarded", text: "Guarded result." }, () => false),
    "superseded",
  );
  assertStoreError(
    () => store.accept({ operationId: "guarded", text: "Guarded result." }, () => { throw new Error("revoked"); }),
    "superseded",
  );
  assert.equal(vault.saveAttempts(), deniedAtStart, "denied guard is checked before the secure write");
  assert.equal(store.snapshot().pending.length, 0);

  let guardCalls = 0;
  const accepted = store.accept(
    { operationId: "guarded", text: "Guarded result." },
    () => { guardCalls++; return true; },
  );
  assert.equal(guardCalls, 1);
  const savesAfterAccept = vault.successfulSaves();
  assertStoreError(
    () => store.accept({ operationId: "guarded", text: "Guarded result." }, () => false),
    "superseded",
  );
  assertStoreError(() => store.acknowledge(accepted.identity, () => false), "superseded");
  assert.equal(vault.successfulSaves(), savesAfterAccept);
  assert.equal(store.snapshot().pending.length, 1);

  assert.equal(store.acknowledge(accepted.identity, () => true), true);
  const savesAfterAck = vault.successfulSaves();
  assertStoreError(
    () => store.accept({ operationId: "guarded", text: "Guarded result." }, () => false),
    "superseded",
  );
  assertStoreError(() => store.acknowledge(accepted.identity, () => false), "superseded");
  assert.equal(vault.successfulSaves(), savesAfterAck);
});

test("secure commit failures never publish RAM state and remain retryable", () => {
  const { store, vault } = createStore();
  const observations = [];
  store.onChange((snapshot) => observations.push(snapshot));

  vault.failSaveOnce();
  assertStoreError(
    () => store.accept({ operationId: "retryable", text: "Retry this result." }),
    "persistence_failed",
  );
  assert.deepEqual(store.snapshot(), { available: true, revision: 0, pending: [] });
  assert.equal(vault.ciphertext(), null);
  assert.equal(observations.length, 0, "observers only see a successful durable commit");

  const accepted = store.accept({ operationId: "retryable", text: "Retry this result." });
  assert.equal(store.snapshot().revision, 1);
  assert.equal(observations.length, 1);

  const beforeFailedAck = vault.ciphertext();
  vault.failSaveOnce();
  assertStoreError(() => store.acknowledge(accepted.identity), "persistence_failed");
  assert.equal(store.peek().text, "Retry this result.");
  assert.deepEqual(vault.ciphertext(), beforeFailedAck);
  assert.equal(observations.length, 1);

  assert.equal(store.acknowledge(accepted.identity), true);
  assert.equal(store.snapshot().pending.length, 0);
  assert.equal(observations.length, 2);
});

test("future, malformed, and cryptographically unreadable values are preserved unavailable", async (t) => {
  const cases = [
    ["future version", JSON.stringify({ version: 2, revision: 0, pending: [], delivered: [] })],
    ["malformed JSON", "{not-json"],
    ["unknown field", JSON.stringify({ version: 1, revision: 0, pending: [], delivered: [], extra: true })],
  ];
  for (const [name, plaintext] of cases) {
    await t.test(name, () => {
      const vault = createEncryptedVault(plaintext);
      const original = vault.ciphertext();
      const store = createStore(vault).store;
      assert.deepEqual(store.snapshot(), { available: false, revision: 0, pending: [] });
      assertStoreError(() => store.accept({ operationId: "blocked", text: "Must be preserved." }), "unavailable");
      assert.deepEqual(vault.ciphertext(), original);
      assert.equal(vault.saveAttempts(), 0);
    });
  }

  await t.test("failed authenticated decryption", () => {
    const vault = createEncryptedVault();
    vault.setCiphertext(randomBytes(48));
    const original = vault.ciphertext();
    const store = createStore(vault).store;
    assert.equal(store.snapshot().available, false);
    assertStoreError(() => store.peek(), "unavailable");
    assert.deepEqual(vault.ciphertext(), original);
    assert.equal(vault.saveAttempts(), 0);
  });
});

test("an external unreadable update scrubs decrypted RAM and only explicit recovery purges it", () => {
  const { store, vault } = createStore();
  store.accept({ operationId: "private-op", text: "Private result in RAM." });
  const validCiphertext = vault.ciphertext();

  vault.setPlaintext("{malformed");
  const malformedCiphertext = vault.ciphertext();
  assert.deepEqual(store.snapshot(), { available: false, revision: 0, pending: [] });
  assertStoreError(() => store.peek(), "unavailable");
  assert.deepEqual(vault.ciphertext(), malformedCiphertext, "reload never silently purges unreadable data");

  vault.setCiphertext(validCiphertext);
  assert.equal(store.snapshot().available, true);
  assert.equal(store.peek().text, "Private result in RAM.");

  vault.setPlaintext(JSON.stringify({ version: 99 }));
  vault.failPurgeOnce();
  assertStoreError(() => store.discardUnreadableData(), "persistence_failed");
  assert.equal(store.snapshot().available, false);
  store.discardUnreadableData();
  assert.deepEqual(store.snapshot(), { available: true, revision: 0, pending: [] });
  assert.equal(vault.ciphertext(), null);
  assertStoreError(() => store.discardUnreadableData(), "unavailable");
});

test("the strict decoder rejects non-canonical, ambiguous, duplicate, and oversized documents", () => {
  const hashA = "a".repeat(64);
  const hashB = "b".repeat(64);
  const digestA = "c".repeat(64);
  const digestB = "d".repeat(64);
  const pendingA = {
    operationHash: hashA,
    digest: digestA,
    text: "First.",
    receivedAtMs: 1,
    insertionRevision: 1,
  };
  const pendingB = {
    operationHash: hashB,
    digest: digestB,
    text: "Second.",
    receivedAtMs: 2,
    insertionRevision: 2,
  };
  const valid = {
    version: 1,
    revision: 2,
    pending: [pendingA, pendingB],
    delivered: [],
  };
  assert.deepEqual(decodeDirectNotificationDocument(JSON.stringify(valid)), valid);

  const invalidDocuments = [
    { ...valid, version: 2 },
    { ...valid, extra: true },
    { ...valid, revision: -1 },
    { ...valid, pending: [{ ...pendingA, extra: true }] },
    { ...valid, pending: [{ ...pendingA, operationHash: "A".repeat(64) }] },
    { ...valid, pending: [{ ...pendingA, text: "Cafe\u0301" }] },
    { ...valid, pending: [{ ...pendingA, insertionRevision: 3 }] },
    { ...valid, pending: [pendingB, pendingA] },
    { ...valid, pending: [pendingA, { ...pendingB, operationHash: hashA }] },
    {
      ...valid,
      delivered: [{ operationHash: hashA, digest: digestB, receivedAtMs: 1, deliveredAtMs: 3 }],
    },
    {
      ...valid,
      pending: [],
      delivered: [{ operationHash: hashA, digest: digestA, receivedAtMs: -1, deliveredAtMs: 3 }],
    },
    {
      ...valid,
      pending: Array.from({ length: MAX_PENDING_DIRECT_NOTIFICATIONS + 1 }, (_, index) => ({
        ...pendingA,
        operationHash: index.toString(16).padStart(64, "0"),
        insertionRevision: index + 1,
      })),
    },
    {
      ...valid,
      pending: [],
      delivered: Array.from({ length: MAX_DIRECT_NOTIFICATION_TOMBSTONES + 1 }, (_, index) => ({
        operationHash: index.toString(16).padStart(64, "0"),
        digest: digestA,
        receivedAtMs: 1,
        deliveredAtMs: 2,
      })),
    },
  ];
  for (const document of invalidDocuments) {
    assert.equal(decodeDirectNotificationDocument(JSON.stringify(document)), null);
  }
  assert.equal(decodeDirectNotificationDocument(""), null);
  assert.equal(decodeDirectNotificationDocument("not JSON"), null);
});
