package com.faceclaw.app;

import java.util.Arrays;

/**
 * Pure sample-clock end-of-utterance detector.
 *
 * <p>The detector intentionally knows nothing about BLE packet arrival times,
 * Android, or a transcription provider. It consumes decoded PCM, analyzes fixed
 * frames, adapts only while speech is inactive, and emits one terminal result
 * until reset.</p>
 */
final class EndOfUtteranceDetector {
    enum Result {
        NONE,
        TRAILING_SILENCE,
        NO_SPEECH,
        MAX_UTTERANCE
    }

    static final class Config {
        final int sampleRateHz;
        final int analysisFrameMs;
        final int calibrationMs;
        final int onsetHoldMs;
        final int minimumSpeechMs;
        final int trailingSilenceMs;
        final int noSpeechTimeoutMs;
        final int maximumUtteranceMs;
        final double minimumNoiseRms;
        final double absoluteOnsetRms;
        final double absoluteReleaseRms;
        final double onsetNoiseFactor;
        final double releaseNoiseFactor;
        final int noiseRiseTimeMs;
        final int noiseFallTimeMs;

        Config(
                int sampleRateHz,
                int analysisFrameMs,
                int calibrationMs,
                int onsetHoldMs,
                int minimumSpeechMs,
                int trailingSilenceMs,
                int noSpeechTimeoutMs,
                int maximumUtteranceMs,
                double minimumNoiseRms,
                double absoluteOnsetRms,
                double absoluteReleaseRms,
                double onsetNoiseFactor,
                double releaseNoiseFactor,
                int noiseRiseTimeMs,
                int noiseFallTimeMs) {
            if (sampleRateHz <= 0 || analysisFrameMs <= 0 || calibrationMs < analysisFrameMs
                    || onsetHoldMs <= 0 || minimumSpeechMs < onsetHoldMs
                    || trailingSilenceMs <= 0 || noSpeechTimeoutMs <= calibrationMs
                    || maximumUtteranceMs < minimumSpeechMs
                    || minimumNoiseRms < 0 || absoluteOnsetRms <= 0 || absoluteReleaseRms <= 0
                    || absoluteOnsetRms <= absoluteReleaseRms
                    || onsetNoiseFactor <= releaseNoiseFactor || releaseNoiseFactor <= 0
                    || noiseRiseTimeMs <= 0 || noiseFallTimeMs <= 0
                    || (long) sampleRateHz * analysisFrameMs % 1000L != 0) {
                throw new IllegalArgumentException("Invalid end-of-utterance configuration");
            }
            this.sampleRateHz = sampleRateHz;
            this.analysisFrameMs = analysisFrameMs;
            this.calibrationMs = calibrationMs;
            this.onsetHoldMs = onsetHoldMs;
            this.minimumSpeechMs = minimumSpeechMs;
            this.trailingSilenceMs = trailingSilenceMs;
            this.noSpeechTimeoutMs = noSpeechTimeoutMs;
            this.maximumUtteranceMs = maximumUtteranceMs;
            this.minimumNoiseRms = minimumNoiseRms;
            this.absoluteOnsetRms = absoluteOnsetRms;
            this.absoluteReleaseRms = absoluteReleaseRms;
            this.onsetNoiseFactor = onsetNoiseFactor;
            this.releaseNoiseFactor = releaseNoiseFactor;
            this.noiseRiseTimeMs = noiseRiseTimeMs;
            this.noiseFallTimeMs = noiseFallTimeMs;
        }

        static Config defaults() {
            return new Config(
                    16000,
                    20,
                    300,
                    60,
                    240,
                    900,
                    6000,
                    30000,
                    60.0,
                    180.0,
                    120.0,
                    2.5,
                    1.5,
                    200,
                    500);
        }
    }

    private final Config config;
    private final int frameSamples;
    private final int calibrationFrames;
    private final short[] frame;
    private final double[] calibrationRms;
    private int frameFill;
    private int calibratedFrames;
    private long totalSamples;
    private long candidateStartSample;
    private long onsetSamples;
    private long activeSpeechSamples;
    private long trailingSamples;
    private double noiseFloor;
    private boolean speaking;
    private boolean terminal;

    EndOfUtteranceDetector(Config config) {
        if (config == null) {
            throw new IllegalArgumentException("End-of-utterance config is required");
        }
        this.config = config;
        this.frameSamples = config.sampleRateHz * config.analysisFrameMs / 1000;
        this.calibrationFrames = config.calibrationMs / config.analysisFrameMs;
        this.frame = new short[frameSamples];
        this.calibrationRms = new double[calibrationFrames];
        reset();
    }

    void reset() {
        frameFill = 0;
        calibratedFrames = 0;
        totalSamples = 0;
        candidateStartSample = -1;
        onsetSamples = 0;
        activeSpeechSamples = 0;
        trailingSamples = 0;
        noiseFloor = config.minimumNoiseRms;
        speaking = false;
        terminal = false;
        Arrays.fill(calibrationRms, 0.0);
    }

    Result accept(short[] pcm, int offset, int count) {
        if (terminal || count <= 0) {
            return Result.NONE;
        }
        if (pcm == null || offset < 0 || count < 0 || offset > pcm.length - count) {
            throw new IllegalArgumentException("Invalid PCM slice");
        }
        int end = offset + count;
        while (offset < end) {
            int copied = Math.min(frameSamples - frameFill, end - offset);
            System.arraycopy(pcm, offset, frame, frameFill, copied);
            frameFill += copied;
            offset += copied;
            if (frameFill == frameSamples) {
                frameFill = 0;
                Result result = acceptFrame(rms(frame));
                if (result != Result.NONE) {
                    terminal = true;
                    return result;
                }
            }
        }
        return Result.NONE;
    }

    private Result acceptFrame(double rms) {
        totalSamples += frameSamples;
        if (calibratedFrames < calibrationFrames) {
            calibrationRms[calibratedFrames++] = rms;
            if (calibratedFrames == calibrationFrames) {
                double[] sorted = Arrays.copyOf(calibrationRms, calibrationRms.length);
                Arrays.sort(sorted);
                int percentileIndex = Math.max(0, (int) Math.floor((sorted.length - 1) * 0.2));
                noiseFloor = Math.max(config.minimumNoiseRms, sorted[percentileIndex]);
            }
            return Result.NONE;
        }

        double onsetThreshold = Math.max(config.absoluteOnsetRms, noiseFloor * config.onsetNoiseFactor);
        double releaseThreshold = Math.max(config.absoluteReleaseRms, noiseFloor * config.releaseNoiseFactor);

        if (!speaking) {
            if (rms >= onsetThreshold) {
                if (onsetSamples == 0) {
                    candidateStartSample = totalSamples - frameSamples;
                }
                onsetSamples += frameSamples;
                activeSpeechSamples += frameSamples;
                if (samplesToMs(onsetSamples) >= config.onsetHoldMs) {
                    speaking = true;
                    trailingSamples = 0;
                }
            } else {
                onsetSamples = 0;
                activeSpeechSamples = 0;
                candidateStartSample = -1;
                adaptNoise(rms);
            }
            return samplesToMs(totalSamples) >= config.noSpeechTimeoutMs ? Result.NO_SPEECH : Result.NONE;
        }

        if (rms >= releaseThreshold) {
            activeSpeechSamples += frameSamples;
            trailingSamples = 0;
        } else {
            trailingSamples += frameSamples;
            if (samplesToMs(trailingSamples) >= config.trailingSilenceMs) {
                if (samplesToMs(activeSpeechSamples) >= config.minimumSpeechMs) {
                    return Result.TRAILING_SILENCE;
                }
                speaking = false;
                onsetSamples = 0;
                activeSpeechSamples = 0;
                trailingSamples = 0;
                candidateStartSample = -1;
                adaptNoise(rms);
            }
        }

        if (candidateStartSample >= 0
                && samplesToMs(totalSamples - candidateStartSample) >= config.maximumUtteranceMs) {
            return Result.MAX_UTTERANCE;
        }
        return !speaking && samplesToMs(totalSamples) >= config.noSpeechTimeoutMs
                ? Result.NO_SPEECH
                : Result.NONE;
    }

    private void adaptNoise(double rms) {
        int timeMs = rms > noiseFloor ? config.noiseRiseTimeMs : config.noiseFallTimeMs;
        double alpha = Math.min(1.0, config.analysisFrameMs / (double) timeMs);
        noiseFloor += alpha * (rms - noiseFloor);
        noiseFloor = Math.max(config.minimumNoiseRms, noiseFloor);
    }

    private long samplesToMs(long samples) {
        return samples * 1000L / config.sampleRateHz;
    }

    private static double rms(short[] samples) {
        double sumSquares = 0.0;
        for (short sample : samples) {
            double value = sample;
            sumSquares += value * value;
        }
        return Math.sqrt(sumSquares / samples.length);
    }
}
