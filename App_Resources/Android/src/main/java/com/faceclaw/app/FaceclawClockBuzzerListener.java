package com.faceclaw.app;

/** Exact delivery receipt for one Clock-owned firmware buzzer phrase. */
public interface FaceclawClockBuzzerListener {
    void onClockBuzzerResult(boolean delivered);
}
