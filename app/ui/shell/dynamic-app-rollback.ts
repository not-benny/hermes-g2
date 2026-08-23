export type DisplacedAssistantRollbackState = {
  ownsLayer: boolean;
  screenOn: boolean;
  displayAvailable: boolean;
  operationCurrent: boolean;
  assistantSlotEmpty: boolean;
  assistantRetained: boolean;
};

/** A failed dashboard delivery may restore voice only while its exact live surface still owns rollback. */
export function shouldRestoreDisplacedAssistant(state: DisplacedAssistantRollbackState): boolean {
  return state.ownsLayer
    && state.screenOn
    && state.displayAvailable
    && state.operationCurrent
    && state.assistantSlotEmpty
    && state.assistantRetained;
}
