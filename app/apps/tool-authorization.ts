/** Fail-closed leases carried across the worker tool protocol. */
const active = new Set<string>();

export function beginToolAuthorization(id: string): void {
  active.add(id);
}

export function cancelToolAuthorization(id: string): void {
  active.delete(id);
}

export function isToolAuthorizationActive(id: string): boolean {
  return active.has(id);
}
