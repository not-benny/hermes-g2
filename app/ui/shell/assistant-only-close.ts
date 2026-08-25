export type AssistantOnlyCloseLifecycle = Readonly<{
  isIsolated: () => boolean;
  hasReplacement: () => boolean;
  hasAssistantContinuation: () => boolean;
  isScreenOn: () => boolean;
  sleep: () => void;
  releaseIsolation: () => void;
}>;

/**
 * Return a dismissed sleep-origin answer to darkness after the current stack
 * mutation yields. A live follow-up/result owns that same isolated lease, so
 * an old dashboard close must never blank its replacement wake.
 */
export function deferAssistantOnlyAnswerClose(
  lifecycle: AssistantOnlyCloseLifecycle,
): void {
  queueMicrotask(() => {
    if (
      !lifecycle.isIsolated() ||
      lifecycle.hasReplacement() ||
      lifecycle.hasAssistantContinuation()
    ) return;
    if (lifecycle.isScreenOn()) lifecycle.sleep();
    else lifecycle.releaseIsolation();
  });
}
