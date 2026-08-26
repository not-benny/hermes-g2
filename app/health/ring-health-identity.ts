/**
 * One boundary for configured R1 identity changes.
 *
 * The caller first commits the new address authority, then invokes this scrub
 * and live reset. A relaunch between those steps sees address B versus scope A
 * and repeats the scrub before restoration; late in-process A frames are
 * already rejected by the configured-address gate.
 */
import { transitionHealthRingIdentity, type HealthWriteResult } from "../native/health-store";
import { ringHealthStore } from "./ring-health-store";

let verifiedRingIdentity: string | null = null;
const canonicalIdentity = (ringId: string): string => ringId.trim().toUpperCase();

function transitionSafely(previousRingId: string, nextRingId: string): HealthWriteResult {
  try {
    return transitionHealthRingIdentity(previousRingId, nextRingId);
  } catch (error) {
    return {
      ok: false,
      error: `ring health identity transition failed: ${String(error)}`,
    };
  }
}

/** Live process gate: persistence is allowed only for the last verified scope. */
export function isRingHealthPersistenceIdentityReady(ringId: string): boolean {
  return verifiedRingIdentity !== null && verifiedRingIdentity === canonicalIdentity(ringId);
}

export function bindRingHealthIdentityAtBoot(ringId: string): HealthWriteResult {
  const result = transitionSafely(ringId, ringId);
  verifiedRingIdentity = result.ok ? canonicalIdentity(ringId) : null;
  if (!result.ok) ringHealthStore.resetForIdentityChange();
  return result;
}

export function applyRingHealthIdentityChange(
  previousRingId: string,
  nextRingId: string,
): HealthWriteResult {
  // Close the write gate before touching persistence. A reset emission or a
  // new-ring frame cannot be saved under the old scope if the transition fails.
  verifiedRingIdentity = null;
  const result = transitionSafely(previousRingId, nextRingId);
  // Reset even when persistence is unavailable: once address B is observable,
  // retaining any live A metric would violate the identity boundary.
  ringHealthStore.resetForIdentityChange();
  if (result.ok) verifiedRingIdentity = canonicalIdentity(nextRingId);
  return result;
}
