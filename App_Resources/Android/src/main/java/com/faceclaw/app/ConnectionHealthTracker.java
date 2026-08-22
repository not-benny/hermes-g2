package com.faceclaw.app;

/** Thread-safe, redacted connection-health state with bounded diagnostics. */
final class ConnectionHealthTracker {
    interface Clock { long elapsedRealtime(); }

    enum Failure {
        NONE("none"), TIMEOUT("timeout"), UNAVAILABLE("unavailable"),
        CONTENTION("contention"), TRANSPORT("transport"), PROTOCOL("protocol");
        final String wire;
        Failure(String wire) { this.wire = wire; }
    }

    static final class Snapshot {
        final String g2State;
        final String r1State;
        final String failure;
        final long r1RetryInMs;
        final int g2Reconnects;
        final int r1Reconnects;
        final int acks;
        final int ackTimeouts;
        final int staleWork;
        final int lockLatencyLatestMs;
        final int lockLatencyMaxMs;

        Snapshot(String g2State, String r1State, String failure, long r1RetryInMs,
                 int g2Reconnects, int r1Reconnects, int acks, int ackTimeouts,
                 int staleWork, int lockLatencyLatestMs, int lockLatencyMaxMs) {
            this.g2State = g2State;
            this.r1State = r1State;
            this.failure = failure;
            this.r1RetryInMs = r1RetryInMs;
            this.g2Reconnects = g2Reconnects;
            this.r1Reconnects = r1Reconnects;
            this.acks = acks;
            this.ackTimeouts = ackTimeouts;
            this.staleWork = staleWork;
            this.lockLatencyLatestMs = lockLatencyLatestMs;
            this.lockLatencyMaxMs = lockLatencyMaxMs;
        }

        String toWire() {
            return g2State + "|" + r1State + "|" + failure + "|" + r1RetryInMs
                + "|" + g2Reconnects + "|" + r1Reconnects + "|" + acks
                + "|" + ackTimeouts + "|" + staleWork + "|" + lockLatencyLatestMs
                + "|" + lockLatencyMaxMs;
        }
    }

    private final Clock clock;
    private String g2State = "disconnected";
    private String r1State = "idle";
    private Failure failure = Failure.NONE;
    private long retryAtMs;
    private int g2Reconnects;
    private int r1Reconnects;
    private int acks;
    private int ackTimeouts;
    private int staleWork;
    private int lockLatencyLatestMs;
    private int lockLatencyMaxMs;
    private boolean g2AttemptSeen;
    private boolean r1AttemptSeen;

    ConnectionHealthTracker(Clock clock) { this.clock = clock; }

    synchronized void setG2(String state, Failure ignoredFailure, long ignoredRetryMs) {
        g2State = safeState(state, "disconnected");
    }

    synchronized void setR1State(String state) {
        r1State = safeState(state, "idle");
        if ("ready".equals(r1State)) {
            failure = Failure.NONE;
            retryAtMs = 0;
        }
    }

    synchronized void setR1Backoff(Failure safeFailure, long delayMs) {
        r1State = "backoff";
        failure = safeFailure == null ? Failure.TRANSPORT : safeFailure;
        retryAtMs = saturatingAdd(clock.elapsedRealtime(), Math.max(0, delayMs));
    }

    synchronized void requestR1Retry() {
        r1State = "retrying";
        retryAtMs = 0;
    }

    synchronized void recordG2Attempt() {
        if (g2AttemptSeen) g2Reconnects = increment(g2Reconnects, 1);
        g2AttemptSeen = true;
    }
    synchronized void recordR1Attempt() {
        if (r1AttemptSeen) r1Reconnects = increment(r1Reconnects, 1);
        r1AttemptSeen = true;
    }
    synchronized void recordAck() { recordAck(1); }
    synchronized void recordAck(long count) { acks = increment(acks, count); }
    synchronized void recordAckTimeout() { ackTimeouts = increment(ackTimeouts, 1); }
    synchronized void recordStaleWork() { recordStaleWork(1); }
    synchronized void recordStaleWork(long count) { staleWork = increment(staleWork, count); }

    synchronized void recordLockLatency(long latencyMs) {
        int bounded = (int) Math.min(Integer.MAX_VALUE, Math.max(0, latencyMs));
        lockLatencyLatestMs = bounded;
        lockLatencyMaxMs = Math.max(lockLatencyMaxMs, bounded);
    }

    synchronized Snapshot snapshot() {
        long retryInMs = retryAtMs <= 0 ? 0 : Math.max(0, retryAtMs - clock.elapsedRealtime());
        return new Snapshot(g2State, r1State, failure.wire, retryInMs, g2Reconnects,
            r1Reconnects, acks, ackTimeouts, staleWork, lockLatencyLatestMs, lockLatencyMaxMs);
    }

    private static String safeState(String state, String fallback) {
        if (state == null || !state.matches("[a-z-]{2,16}")) return fallback;
        return state;
    }

    private static int increment(int current, long count) {
        if (count <= 0) return current;
        if (count >= (long) Integer.MAX_VALUE - current) return Integer.MAX_VALUE;
        return current + (int) count;
    }

    private static long saturatingAdd(long left, long right) {
        if (right > 0 && left > Long.MAX_VALUE - right) return Long.MAX_VALUE;
        return left + right;
    }
}
