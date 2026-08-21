export class InitialCommunicatorStateGate {
  private firstState = true;

  accept(phase: string): boolean {
    if (this.firstState) {
      this.firstState = false;
      return phase !== "disconnected";
    }
    return true;
  }
}
