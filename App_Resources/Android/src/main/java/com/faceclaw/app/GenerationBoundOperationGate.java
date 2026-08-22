package com.faceclaw.app;

/**
 * Generation ownership for blocking work. The monitor is held only to issue or
 * validate a token; the BLE operation itself runs outside it.
 */
final class GenerationBoundOperationGate {
    static final class Token {
        private final long generation;
        private Token(long generation) { this.generation = generation; }
    }

    static final class Snapshot {
        final long generation;
        final boolean ready;
        Snapshot(long generation, boolean ready) {
            this.generation = generation;
            this.ready = ready;
        }
    }

    private long generation;
    private boolean ready;

    synchronized long publishReady() {
        ready = true;
        return generation;
    }

    synchronized Token begin(long expectedGeneration) {
        return ready && expectedGeneration == generation ? new Token(generation) : null;
    }

    synchronized boolean finish(Token token) {
        return token != null && ready && token.generation == generation;
    }

    synchronized long retire() {
        if (generation < Long.MAX_VALUE) generation++;
        ready = false;
        return generation;
    }

    synchronized Snapshot snapshot() { return new Snapshot(generation, ready); }
}
