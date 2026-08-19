/**
 * Shell-side timer.* assistant tools. The Timer app's own tools are
 * window-scoped ("open" tier), but "start a 5 minute timer" must work with no
 * Timer window open — so these always-available wrappers launch the app,
 * wait for its tools to register, and forward the call. Timer state lives in
 * the app's worker, which outlives its window, so list/cancel also route
 * through the app rather than answering "no timers" from the shell.
 */
import { toolRegistry, type ToolRegistry } from "./tool-registry";
import { callAppToolWithLaunch } from "./launch-on-call";

let registered = false;

// Wrapper timeout: covers a first-launch worker spawn (up to the 5 s
// tool-appear wait in callAppToolWithLaunch) plus the forwarded call's own
// 10 s default budget.
const TIMER_WRAPPER_TIMEOUT_MS = 20_000;

export function registerTimerTools(
  launchApp: (appId: string) => Promise<void>,
  registry: ToolRegistry = toolRegistry,
): void {
  if (registered) return;
  registered = true;

  registry.registerSystemTool(
    {
      name: "timer.set",
      description:
        "Start a countdown timer on the glasses. Give the duration as hours/minutes/seconds; at least one must be nonzero. Opens the Timer app if it isn't already open. Returns the timer's number and when it will finish.",
      inputSchema: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Hours component of the duration (default 0)." },
          minutes: { type: "number", description: "Minutes component of the duration (default 0)." },
          seconds: { type: "number", description: "Seconds component of the duration (default 0)." },
        },
        additionalProperties: false,
      },
      timeoutMs: TIMER_WRAPPER_TIMEOUT_MS,
      proactive: true,
    },
    (args) => callAppToolWithLaunch(registry, launchApp, "timer", "set_timer", args ?? {}),
  );

  registry.registerSystemTool(
    {
      name: "timer.list",
      description:
        "List the countdown timers on the glasses: each timer's number, its original duration, and the time remaining (or that it has finished). Opens the Timer app if it isn't already open — timers keep running while its window is closed.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: TIMER_WRAPPER_TIMEOUT_MS,
      proactive: true,
    },
    () => callAppToolWithLaunch(registry, launchApp, "timer", "list_timers", {}),
  );

  registry.registerSystemTool(
    {
      name: "timer.cancel",
      description:
        "Cancel a running countdown timer on the glasses, or dismiss a finished one. Give the timer number from timer.list; it may be omitted when only one timer exists. Pass all=true to clear every timer. Opens the Timer app if it isn't already open.",
      inputSchema: {
        type: "object",
        properties: {
          timer: { type: "number", description: "1-based timer number, as shown by timer.list." },
          all: { type: "boolean", description: "Clear all timers instead of a single one." },
        },
        additionalProperties: false,
      },
      timeoutMs: TIMER_WRAPPER_TIMEOUT_MS,
      proactive: true,
    },
    (args) => callAppToolWithLaunch(registry, launchApp, "timer", "cancel_timer", args ?? {}),
  );
}
