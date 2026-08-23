import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DurableCompanionJournal } from "../hermes-host/durable-companion-journal.mjs";

const record = { operationId: "operation_journal_1234", fingerprint: "a".repeat(64), status: "reserved" };

test("companion journal durably reserves opaque fingerprints and outcomes owner-only", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-companion-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "operations.json");
  const journal = new DurableCompanionJournal({ path });
  assert.equal(journal.reserve(record), true);
  assert.equal(journal.complete(record.operationId, "accepted"), true);
  assert.equal((await stat(path)).mode & 0o077, 0);
  const encoded = await readFile(path, "utf8");
  assert.equal(encoded.includes("credential"), false);
  assert.equal(encoded.includes("prompt"), false);
  assert.equal(encoded.includes("payload"), false);

  const restarted = new DurableCompanionJournal({ path });
  assert.deepEqual(restarted.records(), [{ ...record, status: "complete", outcome: "accepted" }]);
  assert.equal(restarted.reserve(record), false);
  assert.throws(() => restarted.reserve({ ...record, fingerprint: "b".repeat(64) }), /fingerprint conflict/);
  assert.throws(() => restarted.reserve({ ...record, operationId: "operation_extra_1234", payload: "private" }), /invalid/);
});

test("companion journal rejects linked storage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hermes-companion-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target.json");
  const first = new DurableCompanionJournal({ path: target });
  first.reserve(record);
  const linked = join(directory, "linked.json");
  await symlink(target, linked);
  assert.throws(() => new DurableCompanionJournal({ path: linked }), /owner-only regular non-linked/);
});
