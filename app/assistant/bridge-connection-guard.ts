/** Pure connection/auth generation guard for the assistant bridge. */
export class BridgeConnectionGuard {
  private generation = 0;
  private authenticated = false;

  beginConnection(): number { this.generation += 1; this.authenticated = false; return this.generation; }
  authenticate(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.authenticated = true;
    return true;
  }
  canHandlePrivileged(generation: number): boolean { return generation === this.generation && this.authenticated; }
  isCurrent(generation: number): boolean { return generation === this.generation; }
  currentGeneration(): number { return this.generation; }
  invalidate(generation: number): boolean {
    if (generation !== this.generation) return false;
    this.generation += 1; this.authenticated = false; return true;
  }
  invalidateCurrent(): void { this.generation += 1; this.authenticated = false; }
}
