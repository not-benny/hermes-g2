/** A strict user-visible operation succeeds only after a physical frame send. */
export function isSuccessfulFrameOutcome(outcome: string | null): boolean {
  return outcome !== null && outcome.startsWith("sent");
}

/**
 * Evidence that the current display lifecycle can present shell pixels.
 *
 * A current-epoch no-change receipt is sufficient for the pre-card readiness
 * fallback: the compositor submitted the exact shell fingerprint already held
 * by the display pipeline. It is deliberately not a strict delivery success;
 * the subsequently installed result card changes the fingerprint and must
 * still receive its own physical `sent*` receipt.
 */
export function isReadinessFrameEvidenceOutcome(outcome: string | null): boolean {
  return isSuccessfulFrameOutcome(outcome) ||
    outcome === "discarded: no change from displayed image";
}
