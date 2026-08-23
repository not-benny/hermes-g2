import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/ConnectionHealthTracker.java", import.meta.url);

const harness = String.raw`
package com.faceclaw.app;

public final class ConnectionHealthTrackerHarness {
    public static void main(String[] args) {
        FakeClock clock = new FakeClock();
        ConnectionHealthTracker tracker = new ConnectionHealthTracker(clock);

        tracker.setG2("connected", ConnectionHealthTracker.Failure.NONE, 0);
        tracker.recordR1Attempt();
        tracker.setR1Backoff(ConnectionHealthTracker.Failure.TIMEOUT, 300_000);
        ConnectionHealthTracker.Snapshot first = tracker.snapshot();
        require("connected".equals(first.g2State), "G2 remains independently connected");
        require("backoff".equals(first.r1State), "R1 enters backoff");
        require(first.r1RetryInMs == 300_000, "full countdown");
        require(first.r1Reconnects == 0, "initial R1 attempt is not mislabeled as a reconnect");
        tracker.recordR1Attempt();
        require(tracker.snapshot().r1Reconnects == 1, "replacement R1 attempt increments reconnects");

        clock.now = 299_250;
        require(tracker.snapshot().r1RetryInMs == 750, "countdown uses monotonic time");
        tracker.requestR1Retry();
        ConnectionHealthTracker.Snapshot retry = tracker.snapshot();
        require("retrying".equals(retry.r1State), "explicit retry is visible");
        require(retry.r1RetryInMs == 0, "explicit retry clears countdown");
        require("connected".equals(retry.g2State), "explicit R1 retry does not mutate G2");

        tracker.setR1Backoff(ConnectionHealthTracker.Failure.TRANSPORT, 5_000);
        tracker.setR1State("idle");
        ConnectionHealthTracker.Snapshot idle = tracker.snapshot();
        require("none".equals(idle.failure) && idle.r1RetryInMs == 0,
            "idle reset clears stale failure and countdown");

        tracker.recordAck();
        tracker.recordAck();
        tracker.recordStaleWork();
        tracker.recordLockLatency(42);
        tracker.recordLockLatency(11);
        ConnectionHealthTracker.Snapshot counters = tracker.snapshot();
        require(counters.acks == 2 && counters.staleWork == 1, "bounded counters");
        require(counters.lockLatencyLatestMs == 11 && counters.lockLatencyMaxMs == 42, "bounded lock latency");

        tracker.recordAck(Long.MAX_VALUE);
        tracker.recordStaleWork(Long.MAX_VALUE);
        ConnectionHealthTracker.Snapshot saturated = tracker.snapshot();
        require(saturated.acks == Integer.MAX_VALUE && saturated.staleWork == Integer.MAX_VALUE, "counters saturate");

        String wire = saturated.toWire();
        require(!wire.contains("AA:BB") && !wire.contains("bae8") && !wire.contains("payload"), "wire snapshot is redacted");
        require(wire.split("\\|", -1).length == 11, "wire schema stays bounded");
    }

    private static final class FakeClock implements ConnectionHealthTracker.Clock {
        long now;
        public long elapsedRealtime() { return now; }
    }

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }
}
`;

test("connection health keeps G2 and R1 independent with safe bounded diagnostics", () => {
  const directory = mkdtempSync(join(tmpdir(), "connection-health-"));
  try {
    const packageDir = join(directory, "com", "faceclaw", "app");
    const mkdir = spawnSync("mkdir", ["-p", packageDir], { encoding: "utf8" });
    assert.equal(mkdir.status, 0, mkdir.stderr);
    writeFileSync(join(packageDir, "ConnectionHealthTrackerHarness.java"), harness);
    const compile = spawnSync("javac", ["-d", directory, source.pathname, join(packageDir, "ConnectionHealthTrackerHarness.java")], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync("java", ["-cp", directory, "com.faceclaw.app.ConnectionHealthTrackerHarness"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
