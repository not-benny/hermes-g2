/**
 * Event-driven glasses buzzer feedback: a distinct beep pattern per event, a
 * master on/off, a coarse volume, and per-event toggles. Deliberately lean so
 * it is safe to import from a worker isolate (the timer app) - it pulls only
 * sound-effects.ts and the native settings store, not dashboard-settings.ts
 * (which drags in fonts/llama). dashboard-settings.ts reuses BEEP_EVENTS below
 * as the single source of truth for the per-event toggle keys and defaults.
 */

import {
  buildSoundSequencePayload,
  effectPhrases,
  findSoundEffect,
  phraseDurationMs,
  CFW_SEQ_MAX,
  type Step,
} from "./sound-effects";
import { getBooleanSetting, getStringSetting } from "~/native/settings-store";

export type BeepEvent =
  | "notification"
  | "assistantReply"
  | "assistantError"
  | "timer"
  | "connect"
  | "disconnect";

type BeepDef = {
  /** SOUND_EFFECTS entry name (the distinct pattern for this event). */
  effect: string;
  storageKey: string;
  defaultOn: boolean;
  label: string;
  description: string;
};

/** event -> pattern + setting metadata. Each event uses a DISTINCT effect. */
export const BEEP_EVENTS: Record<BeepEvent, BeepDef> = {
  notification: {
    effect: "notify",
    storageKey: "beeps.event.notification",
    defaultOn: true,
    label: "Notifications",
    description: "Two-tone chime when a notification is mirrored to the glasses.",
  },
  assistantReply: {
    effect: "success",
    storageKey: "beeps.event.assistantReply",
    defaultOn: true,
    label: "Assistant reply",
    description: "Rising arpeggio when Hermes finishes a turn with a reply.",
  },
  assistantError: {
    effect: "error",
    storageKey: "beeps.event.assistantError",
    defaultOn: true,
    label: "Assistant error",
    description: "Low descending two-tone when a Hermes turn fails.",
  },
  timer: {
    effect: "alarm",
    storageKey: "beeps.event.timer",
    defaultOn: true,
    label: "Timers & alarms",
    description: "Repeating beeps when a countdown timer finishes.",
  },
  connect: {
    effect: "coin",
    storageKey: "beeps.event.connect",
    defaultOn: true,
    label: "Connected",
    description: "Short bright blip when the glasses session comes up.",
  },
  disconnect: {
    effect: "deny",
    storageKey: "beeps.event.disconnect",
    defaultOn: true,
    label: "Disconnected",
    description: "Double low buzz when the glasses session drops.",
  },
};

/** Volume -> PWM duty multiplier (the only loudness lever the piezo exposes). */
const VOLUME_DUTY_SCALE: Record<string, number> = { low: 0.45, medium: 0.7, high: 1 };

function scaleVolume(steps: Step[], scale: number): Step[] {
  if (scale >= 1) return steps;
  // Preserve rests (duty 0 = silence); never let a real tone collapse to a rest.
  return steps.map((s) =>
    s.duty && s.duty > 0 ? { ...s, duty: Math.max(1, Math.round(s.duty * scale)) } : s,
  );
}

/** Master gate AND the per-event toggle, read live from the settings store. */
export function beepEnabled(event: BeepEvent): boolean {
  if (!getBooleanSetting("beeps.enabled", true)) return false;
  const def = BEEP_EVENTS[event];
  return getBooleanSetting(def.storageKey, def.defaultOn);
}

/**
 * Play an event's pattern via `play`, pacing phrase-by-phrase (mirrors
 * playSoundEffect). No-op when the master switch or this event's toggle is off.
 */
export async function playEventBeep(
  event: BeepEvent,
  play: (payload: Uint8Array) => Promise<void> | void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  if (!beepEnabled(event)) return;
  const effect = findSoundEffect(BEEP_EVENTS[event].effect);
  if (!effect) return;
  const scale = VOLUME_DUTY_SCALE[getStringSetting("beeps.volume", "medium")] ?? 0.7;
  for (const phrase of effectPhrases(effect.make())) {
    const scaled = scaleVolume(phrase, scale);
    for (let i = 0; i < scaled.length; i += CFW_SEQ_MAX) {
      const chunk = scaled.slice(i, i + CFW_SEQ_MAX);
      await play(buildSoundSequencePayload(chunk));
      await sleep(phraseDurationMs(chunk));
    }
  }
}
