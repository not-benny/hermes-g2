/** Exact ownership predicate for a layer whose own frame must be acknowledged. */
export function isStrictLayerOwner<T>(
  expectedRevision: number,
  currentRevision: number,
  expectedLayer: T,
  currentLayer: T | null,
  isTop: boolean,
): boolean {
  return (
    expectedRevision === currentRevision &&
    expectedLayer === currentLayer &&
    isTop
  );
}

/**
 * Await one phase of a strict shell transaction without letting an unresolved
 * transport/render promise retain its caller after cancellation. The losing
 * operation remains observed so a later rejection cannot become unhandled.
 */
export function awaitWithAbortSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  message = "The shell operation was cancelled.",
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error(message));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error(message)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Start cleanup that must never retain ownership of the failed strict operation. */
export function startDetachedCleanup(task: () => void | Promise<unknown>): void {
  try {
    void Promise.resolve(task()).catch(() => {});
  } catch {
    // Cleanup is best-effort; the original strict-delivery failure stays authoritative.
  }
}
