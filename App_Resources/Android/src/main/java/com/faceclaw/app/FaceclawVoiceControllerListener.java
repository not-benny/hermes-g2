package com.faceclaw.app;

public interface FaceclawVoiceControllerListener {
    void onStatus(long generation, String status);

    void onWakeWord(String keyword);

    /**
     * Best transcript of the current utterance so far. REPLACE semantics: text
     * is the complete transcript, not a delta — display it verbatim, replacing
     * any previous partial. isFinal marks the end of the utterance.
     */
    void onTranscript(long generation, String text, boolean isFinal);

    /**
     * Decoded microphone audio for CLOUD mode: 16 kHz mono signed 16-bit
     * little-endian PCM. Empty/absent in onboard mode.
     */
    void onPcm(long generation, byte[] pcm16le);

    /**
     * The speaker stopped, in a hands-free session that has no button release
     * to end it. Only fires when endpointing was enabled for the session; see
     * FaceclawVoiceController.setEndpointing.
     */
    void onSpeechEnd(long generation);

    /** All native audio and final transcript callbacks for this generation were queued. */
    void onCaptureStopped(long generation);
}
