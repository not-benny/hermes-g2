import { type ToolRegistry, type ToolResult, type ToolSpec } from "./tool-registry";

export type InProcessTools = {
  specs: ToolSpec[];
  invoke: (toolName: string, args: unknown, signal: AbortSignal, isSideEffectAllowed: () => boolean) => Promise<ToolResult> | ToolResult;
};

/** Register the tools owned by one main-thread window and return its teardown. */
export function registerInProcessTools(
  registry: ToolRegistry,
  windowId: string,
  appId: string,
  tools: InProcessTools | undefined,
  isForeground: () => boolean,
): () => void {
  if (!tools) return () => {};
  const generation = new AbortController();
  let active = true;
  const lease = registry.setAppTools({
    windowId,
    appId,
    specs: tools.specs,
    invoke: (toolName, args, signal, isSideEffectAllowed) =>
      tools.invoke(toolName, args, mergeAbortSignals(signal, generation.signal), isSideEffectAllowed),
    isForeground,
    isGenerationActive: () => active,
  });
  return () => {
    if (!active) return;
    active = false;
    generation.abort();
    registry.removeAppTools(windowId, lease);
  };
}

function mergeAbortSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) controller.abort();
  else {
    first.addEventListener("abort", abort, { once: true });
    second.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}