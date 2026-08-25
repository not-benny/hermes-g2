/** Persisted ring/touchpad sensitivity levels, from most filtered to raw. */
export const RING_SENSITIVITY_VALUES = ["1", "2", "3", "4", "5"] as const;
export type RingSensitivity = (typeof RING_SENSITIVITY_VALUES)[number];

/**
 * The original five-level curve was deliberately conservative because one
 * physical swipe emits a burst of discrete scroll events. Increase the
 * eligible repeat rate uniformly without duplicating events or bypassing the
 * user's selected level. Level 5 remains the raw, unthrottled hardware stream.
 */
export const RING_SENSITIVITY_RESPONSE_GAIN = 1.25;

const BASE_SCROLL_MIN_INTERVAL_MS: Readonly<Record<RingSensitivity, number>> = {
  "1": 320,
  "2": 220,
  "3": 150,
  "4": 80,
  "5": 0,
};

/** Minimum milliseconds between honored scrolls for the selected level. */
export function ringScrollMinIntervalMs(value: RingSensitivity): number {
  const baseline = BASE_SCROLL_MIN_INTERVAL_MS[value];
  return baseline === 0
    ? 0
    : Math.round(baseline / RING_SENSITIVITY_RESPONSE_GAIN);
}
