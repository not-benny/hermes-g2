/** True only when no synchronous callback has already retired the provisional turn. */
export function shouldInstallReturnedTurnHandle<T>(current: T | null, provisional: T): boolean {
  return current === provisional;
}
