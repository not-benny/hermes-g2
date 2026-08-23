import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireDurableLedgerLease, DurableMutationLedger } from "../hermes-host/durable-mutation-ledger.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "hermes-g2-ledger-"));
  return { directory, path: join(directory, "mutations.json"), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("durable ledger survives restart and binds an operation ID to one canonical payload", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const payload = { version: 1, operation_id: "op-1", area: "Living Room", entity_id: "light.example", domain: "light", expected_revision: "revision-1", target: "on" };
  const first = new DurableMutationLedger({ path: f.path });
  assert.deepEqual(await first.reserve("op-1", payload), { state: "pending", replay: false, purpose: "mutation", parentOperationId: null });

  const restarted = new DurableMutationLedger({ path: f.path });
  assert.deepEqual(await restarted.reserve("op-1", structuredClone(payload)), { state: "pending", replay: true, purpose: "mutation", parentOperationId: null });
  await assert.rejects(() => restarted.reserve("op-1", { ...payload, target: "off" }), /different payload/i);

  const mode = (await stat(f.path)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal((await readFile(f.path, "utf8")).includes("sentinel-token"), false);
});

test("completed and rejected outcomes replay durably without redispatch authority", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const payload = { operation_id: "op-2", target: "off" };
  const ledger = new DurableMutationLedger({ path: f.path });
  await ledger.reserve("op-2", payload);
  await ledger.complete("op-2", { applied: true, area: "Living Room", before: { state: "on" }, after: { state: "off" } });

  const completed = await new DurableMutationLedger({ path: f.path }).reserve("op-2", payload);
  assert.equal(completed.state, "completed");
  assert.equal(completed.replay, true);
  assert.equal(completed.outcome.after.state, "off");

  await ledger.reserve("op-3", { operation_id: "op-3" });
  await ledger.reject("op-3", "stale_revision");
  assert.deepEqual(await new DurableMutationLedger({ path: f.path }).reserve("op-3", { operation_id: "op-3" }),
    { state: "rejected", replay: true, code: "stale_revision", purpose: "mutation", parentOperationId: null });
});

test("ledger rejects prototype keys and relative persistence paths", async (t) => {
  assert.throws(() => new DurableMutationLedger({ path: "relative-ledger.json" }), /absolute/i);
  const f = await fixture(); t.after(f.cleanup);
  const ledger = new DurableMutationLedger({ path: f.path });
  await assert.rejects(() => ledger.reserve("__proto__", { target: "on" }), /operation ID/i);
  await assert.rejects(() => ledger.reserve("constructor", { target: "on" }), /operation ID/i);
});

test("one live process lease exclusively owns a durable ledger", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const release = await acquireDurableLedgerLease(f.path);
  assert.equal(release.canonicalPath, f.path);
  await assert.rejects(() => acquireDurableLedgerLease(f.path), /already owned/i);
  const alias = join(f.directory, "..", f.directory.slice(f.directory.lastIndexOf("/") + 1), "mutations.json");
  await assert.rejects(() => acquireDurableLedgerLease(alias), /already owned/i);
  await release();
  const releaseAgain = await acquireDurableLedgerLease(f.path);
  await releaseAgain();
});

test("ledger lease rejects a symlinked ledger file", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const target = join(f.directory, "target.json");
  const alias = join(f.directory, "alias.json");
  await writeFile(target, "{}\n", { mode: 0o600 });
  await symlink(target, alias);
  await assert.rejects(() => acquireDurableLedgerLease(alias), /non-linked/i);
});

test("ledger lease rejects an existing group/world-readable ledger", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await writeFile(f.path, "{}\n", { mode: 0o644 });
  await assert.rejects(() => acquireDurableLedgerLease(f.path), /owner-only/i);
});
