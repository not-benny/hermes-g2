import { type ToolRegistry, type ToolResult, type ToolSpec } from "./tool-registry";

export type InProcessTools = {
  specs: ToolSpec[];
  invoke: (toolName: string, args: unknown) => Promise<ToolResult> | ToolResult;
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
  const lease = registry.setAppTools({ windowId, appId, specs: tools.specs, invoke: tools.invoke, isForeground });
  return () => registry.removeAppTools(windowId, lease);
}