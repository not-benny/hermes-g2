package com.faceclaw.app;

/** Immutable ownership captured before an asynchronous listener delivery. */
final class ExactGenerationListenerGuard<L> {
    private final long generation;
    private final L listener;

    ExactGenerationListenerGuard(long generation, L listener) {
        if (listener == null) throw new IllegalArgumentException("listener is required");
        this.generation = generation;
        this.listener = listener;
    }

    /** Equality is intentionally referential: an equivalent replacement is not the owner. */
    boolean isCurrent(long currentGeneration, L currentListener) {
        return generation == currentGeneration && listener == currentListener;
    }
}
