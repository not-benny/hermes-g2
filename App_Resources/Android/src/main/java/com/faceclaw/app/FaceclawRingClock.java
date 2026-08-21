package com.faceclaw.app;

/** Android-free codec for the captured R1 systemTime payload. */
final class FaceclawRingClock {
    private static final long MAX_U32 = 0xffff_ffffL;

    private FaceclawRingClock() {
    }

    static byte[] encode(long epochSec, int timezoneOffsetMinutes) {
        if (epochSec < 0 || epochSec > MAX_U32) {
            throw new IllegalArgumentException("epochSec must fit unsigned 32-bit seconds");
        }
        if (timezoneOffsetMinutes < -840 || timezoneOffsetMinutes > 840) {
            throw new IllegalArgumentException("timezoneOffsetMinutes out of range");
        }
        byte[] payload = new byte[6];
        payload[0] = (byte) (timezoneOffsetMinutes & 0xff);
        payload[1] = (byte) ((timezoneOffsetMinutes >>> 8) & 0xff);
        payload[2] = (byte) (epochSec & 0xff);
        payload[3] = (byte) ((epochSec >>> 8) & 0xff);
        payload[4] = (byte) ((epochSec >>> 16) & 0xff);
        payload[5] = (byte) ((epochSec >>> 24) & 0xff);
        return payload;
    }
}
