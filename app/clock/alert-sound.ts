import { buildSoundSequencePayload, phraseDurationMs, type Step } from "../ui/sound-effects";

export type ClockAlertIntensity = "low" | "high";

export const CLOCK_ALERT_PHRASE_MS = 60_000;
export const CLOCK_ALERT_PHRASE_STEPS = 48;

/** CFW mode-5 kind-2. The trailing byte satisfies the guarded Java bridge. */
export const CLOCK_ALERT_STOP_PAYLOAD = new Uint8Array([0x05, 0x02, 0x00]);

/**
 * One firmware-autonomous minute: twelve sparse paired beeps. Keeping the
 * complete minute in one 48-step payload bounds behavior if the phone process
 * stalls, while an urgent stop/phase replacement can still preempt it.
 */
export function clockAlertSteps(intensity: ClockAlertIntensity): Step[] {
  const duty = intensity === "low" ? 25 : 55;
  const frequency = intensity === "low" ? 980 : 1_260;
  const steps: Step[] = [];
  for (let cycle = 0; cycle < 12; cycle++) {
    steps.push(
      { freq: frequency, duty, ms: 160 },
      { freq: 1, duty: 0, ms: 120 },
      { freq: frequency, duty, ms: 160 },
      { freq: 1, duty: 0, ms: 4_560 },
    );
  }
  return steps;
}

export function buildClockAlertPayload(intensity: ClockAlertIntensity): Uint8Array {
  return buildSoundSequencePayload(clockAlertSteps(intensity));
}

export function clockAlertPhraseIsBounded(intensity: ClockAlertIntensity): boolean {
  const steps = clockAlertSteps(intensity);
  return steps.length === CLOCK_ALERT_PHRASE_STEPS && phraseDurationMs(steps) === CLOCK_ALERT_PHRASE_MS;
}
