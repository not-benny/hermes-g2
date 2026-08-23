import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isReviewedPrivateAddress } from "../hermes-host/private-dynamic-ha-server.mjs";

const server = new URL("../hermes-host/private-dynamic-ha-server.mjs", import.meta.url);

test("private end-to-end server documents exact WSS, durable ledger, trigger, and restoration gates", () => {
  const help = spawnSync(process.execPath, [server.pathname, "--help"], { encoding: "utf8", env: {} });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /WSS/i);
  assert.match(help.stdout, /durable-ledger/i);
  assert.match(help.stdout, /say exactly/i);
  assert.match(help.stdout, /receipt-restored/i);
  assert.equal(/HA_TOKEN|PRIVATE_BRIDGE_TOKEN/.test(help.stdout), false);
});

test("private end-to-end server refuses incomplete configuration without echoing values", () => {
  const env = { PRIVATE_BRIDGE_BIND_HOST: "0.0.0.0", PRIVATE_BRIDGE_TOKEN: "sentinel-private-bridge-token" };
  const result = spawnSync(process.execPath, [server.pathname], { encoding: "utf8", env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed safely/i);
  assert.equal(result.stderr.includes("sentinel"), false);
  assert.equal(result.stdout, "");
});

test("server binds only reviewed private, tunnel, or loopback literals", () => {
  for (const host of ["127.0.0.1", "10.0.0.2", "172.20.1.2", "192.168.1.2", "100.100.1.2", "::1", "fd00::1"]) {
    assert.equal(isReviewedPrivateAddress(host), true, host);
  }
  for (const host of ["0.0.0.0", "::", "8.8.8.8", "example.com", "172.15.1.2", "100.128.1.2"]) {
    assert.equal(isReviewedPrivateAddress(host), false, host);
  }
});
