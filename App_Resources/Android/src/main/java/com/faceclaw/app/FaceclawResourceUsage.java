package com.faceclaw.app;

import android.os.Debug;
import android.os.Process;
import android.os.SystemClock;

import java.io.BufferedReader;
import java.io.FileReader;
import java.io.IOException;

/** Lightweight process counters for the on-glasses resource-usage monitor. */
public final class FaceclawResourceUsage {
    private FaceclawResourceUsage() {}

    /**
     * Returns elapsedMs, processCpuMs, rssKb, nativeHeapKb, javaHeapKb,
     * javaHeapCommittedKb, and threadCount. Reading /proc/self/status avoids
     * the considerably heavier full Debug.MemoryInfo/PSS collection once per
     * second while still reporting the RSS that Android records at exit.
     */
    public static long[] sample() {
        long[] status = readProcessStatus();
        Runtime runtime = Runtime.getRuntime();
        long javaUsedBytes = runtime.totalMemory() - runtime.freeMemory();
        return new long[] {
                SystemClock.elapsedRealtime(),
                Process.getElapsedCpuTime(),
                status[0],
                Debug.getNativeHeapAllocatedSize() / 1024L,
                javaUsedBytes / 1024L,
                runtime.totalMemory() / 1024L,
                status[1],
        };
    }

    /** Returns {VmRSS in KiB, thread count}; unavailable values are zero. */
    private static long[] readProcessStatus() {
        long rssKb = 0;
        long threadCount = 0;
        try (BufferedReader reader = new BufferedReader(new FileReader("/proc/self/status"))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("VmRSS:")) {
                    rssKb = firstNumber(line);
                } else if (line.startsWith("Threads:")) {
                    threadCount = firstNumber(line);
                }
                if (rssKb > 0 && threadCount > 0) break;
            }
        } catch (IOException ignored) {
            // The graph remains useful with the runtime heap counters alone.
        }
        return new long[] { rssKb, threadCount };
    }

    private static long firstNumber(String line) {
        int start = 0;
        while (start < line.length() && !Character.isDigit(line.charAt(start))) start++;
        int end = start;
        while (end < line.length() && Character.isDigit(line.charAt(end))) end++;
        if (start == end) return 0;
        try {
            return Long.parseLong(line.substring(start, end));
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }
}
