import { clockStore } from "../clock/store";
import { clockSchedulerBridge } from "../native/clock-scheduler";
import {
  createClockSetAlarmHandler,
  createClockSetTimerHandler,
  type ClockToolDependencies,
} from "./clock-handler";
import { BRIDGE_PINNED_PHONE_INPUT_SCHEMAS } from "./bridge-phone-contract-schemas";
import { toolRegistry, type ToolRegistry } from "./tool-registry";

const registeredRegistries = new WeakSet<ToolRegistry>();

const defaultDependencies: ClockToolDependencies = {
  setTimer: (input, isAllowed) => clockStore.setTimer(input, isAllowed),
  setAlarm: (input, isAllowed) => clockStore.setAlarm(input, isAllowed),
  scheduledItems: () => clockStore.scheduledItems(),
  syncScheduler: (items) => clockSchedulerBridge.sync(items),
};

/**
 * Register the fixed phone-owned Clock boundary. DashboardController should
 * call this once beside the other assistant registrations; no launch callback
 * is accepted because scheduling must not open or focus the Clock window.
 */
export function registerClockTools(
  registry: ToolRegistry = toolRegistry,
  dependencies: ClockToolDependencies = defaultDependencies,
): void {
  if (registeredRegistries.has(registry)) return;
  registeredRegistries.add(registry);

  registry.registerSystemTool(
    {
      name: "glasses.clock.set_timer",
      description:
        "Set one durable countdown in the phone-owned Clock for the exact active even-g2 voice turn. Never opens Clock and never creates a Hermes reminder or cron job.",
      inputSchema: BRIDGE_PINNED_PHONE_INPUT_SCHEMAS["glasses.clock.set_timer"],
      timeoutMs: 10_000,
    },
    createClockSetTimerHandler(dependencies),
  );

  registry.registerSystemTool(
    {
      name: "glasses.clock.set_alarm",
      description:
        "Set one durable phone-local alarm in Clock for the exact active even-g2 voice turn. Supply date or repeat_days, never both; omit both for the next occurrence. Never opens Clock or creates Hermes cron.",
      inputSchema: BRIDGE_PINNED_PHONE_INPUT_SCHEMAS["glasses.clock.set_alarm"],
      timeoutMs: 10_000,
    },
    createClockSetAlarmHandler(dependencies),
  );
}
