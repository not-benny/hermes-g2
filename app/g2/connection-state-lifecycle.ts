export type DashboardConnectionPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "charging"
  | "disconnecting";

/**
 * A communicator owns BLE resources until its explicit teardown finishes.
 * The native bridge posts its constructor-time `disconnected` snapshot
 * asynchronously; it can arrive after a new connect attempt has started and
 * must not be mistaken for teardown completion.
 */
export function shouldFinalizeCommunicatorClose(
  currentPhase: DashboardConnectionPhase,
  incomingPhase: DashboardConnectionPhase | "retrying",
  ownsCommunicator: boolean,
): boolean {
  return ownsCommunicator && currentPhase === "disconnecting" && incomingPhase === "disconnected";
}
