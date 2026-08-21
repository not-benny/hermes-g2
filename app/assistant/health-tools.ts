import { queryHealthDocument, type HealthQueryArgs } from "../health/health-store";
import { getHermesConsent, loadHealthDocument } from "../native/health-store";
import { toolRegistry, type ToolRegistry } from "./tool-registry";

const registered = new WeakSet<ToolRegistry>();

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    end_date: { type: "string", description: "Inclusive local end date (YYYY-MM-DD); defaults to today." },
    days: { type: "integer", minimum: 1, maximum: 31, description: "Number of local calendar days; defaults to 7." },
    include_hourly: { type: "boolean", description: "Include retained hourly points; defaults to false." },
  },
  additionalProperties: false,
};

/** Register the consent-gated, conversation-only ring-health read tool once. */
export function registerHealthTools(registry: ToolRegistry = toolRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register({
    spec: {
      name: "health.get_ring_data",
      description: "Read a bounded range of locally retained ring-health summaries after the user enables assistant health access.",
      inputSchema: INPUT_SCHEMA,
      availability: "always",
    },
    isAvailable: () => getHermesConsent(),
    handler: (args: HealthQueryArgs) => {
      // Defense in depth against revoke/list/call races. No health payload is
      // loaded or cached before this call-time consent check.
      if (!getHermesConsent()) return { ok: false, error: "Assistant health access is off" };
      const outcome = queryHealthDocument(loadHealthDocument(), args, Date.now());
      return outcome.ok
        ? { ok: true, content: JSON.stringify(outcome.value!) }
        : { ok: false, error: outcome.error ?? "Invalid health query" };
    },
  });
}
