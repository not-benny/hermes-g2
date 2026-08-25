/** Bounded selection math shared by Window Management and its regression tests. */
export function nextWindowManagementIndex(currentIndex: number, delta: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(currentIndex + delta, count - 1));
}

/** Keep the closed card's visual slot; use the preceding card only at the end. */
export function selectionIndexAfterManagementRemoval(removedIndex: number, remainingCount: number): number {
  if (remainingCount <= 0) return 0;
  return Math.min(Math.max(0, removedIndex), remainingCount - 1);
}
