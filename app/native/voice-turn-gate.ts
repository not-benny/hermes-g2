export type VoiceTurnState = "requested" | "active" | "finishing" | "finished" | "cancelled" | "failed";

/**
 * Provider-neutral identity and exactly-once gate for one voice turn at a time.
 * A generation is allocated before permission work begins, so every delayed
 * callback can be rejected after cancellation or replacement.
 */
export class VoiceTurnGate {
  private nextGeneration = 0;
  private currentGeneration = 0;
  private state: VoiceTurnState = "cancelled";
  private submitted = false;

  reserve(): number {
    this.currentGeneration = ++this.nextGeneration;
    this.state = "requested";
    this.submitted = false;
    return this.currentGeneration;
  }

  activate(generation: number): boolean {
    if (!this.isCurrent(generation) || this.state !== "requested") return false;
    this.state = "active";
    return true;
  }

  finish(generation: number): boolean {
    if (!this.isCurrent(generation) || (this.state !== "requested" && this.state !== "active")) return false;
    this.state = "finishing";
    return true;
  }

  cancel(generation: number): boolean {
    if (!this.isCurrent(generation) || this.isTerminal()) return false;
    this.state = "cancelled";
    return true;
  }

  fail(generation: number): boolean {
    if (!this.isCurrent(generation) || this.isTerminal()) return false;
    this.state = "failed";
    return true;
  }

  accepts(generation: number): boolean {
    return this.isCurrent(generation)
      && (this.state === "active" || this.state === "finishing" || this.state === "finished");
  }

  acceptsAudio(generation: number): boolean {
    return this.isCurrent(generation) && (this.state === "active" || this.state === "finishing");
  }

  complete(generation: number): boolean {
    if (!this.isCurrent(generation) || this.state !== "finishing") return false;
    this.state = "finished";
    return true;
  }

  claimSubmit(generation: number): boolean {
    if (!this.isCurrent(generation)
      || (this.state !== "finishing" && this.state !== "finished")
      || this.submitted) return false;
    this.submitted = true;
    return true;
  }

  current(): number | null {
    return this.currentGeneration > 0 && !this.isTerminal() ? this.currentGeneration : null;
  }

  private isCurrent(generation: number): boolean {
    return generation > 0 && generation === this.currentGeneration;
  }

  private isTerminal(): boolean {
    return this.state === "cancelled" || this.state === "failed";
  }
}
