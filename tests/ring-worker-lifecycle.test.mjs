import assert from "node:assert/strict";
import test from "node:test";

class Lifecycle {
  constructor() { this.workers = { display: true, ring: true }; this.owner = true; this.resources = { gatt: 2, wake: 1, receiver: 1 }; this.releases = 0; }
  close() {
    if (this.workers.display || this.workers.ring) return false;
    if (!this.owner) return true;
    this.resources = { gatt: 0, wake: 0, receiver: 0 }; this.owner = false; this.releases += 1; return true;
  }
}

test("non-cooperative worker blocks replacement and Disconnected", () => {
  const lifecycle = new Lifecycle();
  assert.equal(lifecycle.close(), false);
  assert.equal(lifecycle.owner, true);
  assert.deepEqual(lifecycle.resources, { gatt: 2, wake: 1, receiver: 1 });
  assert.equal(lifecycle.close(), false);
});

test("both workers exiting permits exactly-once resource release", () => {
  const lifecycle = new Lifecycle(); lifecycle.workers.display = false;
  assert.equal(lifecycle.close(), false);
  lifecycle.workers.ring = false;
  assert.equal(lifecycle.close(), true);
  assert.equal(lifecycle.close(), true);
  assert.equal(lifecycle.releases, 1);
  assert.deepEqual(lifecycle.resources, { gatt: 0, wake: 0, receiver: 0 });
});
