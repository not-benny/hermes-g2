package com.faceclaw.app;

/**
 * Callbacks for one on-phone LLM generation. Like the other bridge listeners,
 * implementations are typically created on the NativeScript JS thread and
 * FaceclawLlamaRunner posts these callbacks back to that thread's Looper.
 */
public interface FaceclawLlamaListener {
    /** A piece of generated text (may be a partial word). */
    void onToken(String piece);

    /** Generation finished: "stop" (EOG), "length", or "cancelled". */
    void onDone(String stopReason);

    void onError(String message);
}
