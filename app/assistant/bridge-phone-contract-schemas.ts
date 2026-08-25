/**
 * Phone-owned input schemas pinned by the native Hermes G2 workflow bridge.
 *
 * Keep these as data-only exports: the bridge release check transpiles this
 * module and hashes the same objects that the phone registry advertises. Prose
 * descriptions may change without a protocol break; every structural change
 * requires a matching bridge contract release.
 */

const inertText = "Plain inert text only: no URL, markup, command, credential, tool name, or executable content.";
const operationId = {
  type: "string", minLength: 1, maxLength: 64,
  description: "Opaque idempotency key; reuse only for an identical response-loss retry.",
};

const contextSummarySchema = {
  type: "object",
  description: "Answer-first summary. Use estimated/unknown for model synthesis; exact only for directly supported facts.",
  properties: {
    primary: { type: "string", minLength: 1, maxLength: 64, description: inertText },
    secondary: { type: "string", minLength: 1, maxLength: 96, description: inertText },
    tone: { type: "string", enum: ["neutral", "good", "warning", "critical"] },
    uncertainty: { type: "string", enum: ["exact", "estimated", "unknown"] },
  },
  required: ["primary", "uncertainty"],
  additionalProperties: false,
};

const contextRowSchema = {
  type: "object",
  description: "Type-specific row. status_grid uses id/label/value/tone; departures uses id/destination/times/status/platform. Execution enforces the exact variant.",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    label: { type: "string", minLength: 1, maxLength: 40, description: inertText },
    value: { type: "string", minLength: 1, maxLength: 64, description: inertText },
    tone: { type: "string", enum: ["neutral", "good", "warning", "critical"] },
    destination: { type: "string", minLength: 1, maxLength: 40, description: inertText },
    scheduled_departure_ms: { type: "integer", minimum: 0 },
    expected_departure_ms: { type: "integer", minimum: 0 },
    status: { type: "string", enum: ["on_time", "delayed", "cancelled", "unknown", "departed"] },
    platform: { type: "string", minLength: 1, maxLength: 8, description: inertText },
  },
  required: ["id"],
  additionalProperties: false,
};

const contextBarSchema = {
  type: "object",
  description: "Phone-normalized visual bar. Use finite non-negative value/max with max > 0, value <= max, and at most three decimal places. The phone derives width and printed value; callers cannot supply coordinates or styling.",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    label: { type: "string", minLength: 1, maxLength: 24, description: inertText },
    value: { type: "number", minimum: 0, maximum: 1_000_000_000 },
    max: { type: "number", minimum: 0, maximum: 1_000_000_000 },
    unit: { type: "string", minLength: 1, maxLength: 8, description: inertText },
  },
  required: ["id", "label", "value", "max"],
  additionalProperties: false,
};

const contextSectionSchema = {
  type: "object",
  description: "Generic inert section. In deck mode each semantic section becomes one lens page (long departure sections are phone-chunked); bar_chart uses 1-5 numeric bars, list uses items, status_grid/departures use rows, and message uses body.",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    order: { type: "integer", minimum: 0, maximum: 3 },
    type: { type: "string", enum: ["departures", "status_grid", "bar_chart", "list", "message"] },
    title: { type: "string", minLength: 1, maxLength: 40, description: inertText },
    load_state: { type: "string", enum: ["pending", "ready", "empty", "error"] },
    source_ids: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 1, maxLength: 64 } },
    uncertainty: { type: "string", enum: ["exact", "estimated", "unknown"] },
    note: { type: "string", minLength: 1, maxLength: 64, description: inertText },
    error_code: { type: "string", enum: ["timeout", "offline", "permission", "unavailable", "invalid_data", "unknown"] },
    rows: { type: "array", maxItems: 12, items: contextRowSchema },
    bars: { type: "array", minItems: 1, maxItems: 5, items: contextBarSchema },
    items: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 96, description: inertText } },
    body: { type: "string", minLength: 1, maxLength: 160, description: inertText },
  },
  required: ["id", "order", "type", "load_state", "source_ids", "uncertainty"],
  additionalProperties: false,
};

const contextSourceSchema = {
  type: "object",
  description: "Truthful provenance. A model-known answer uses label 'Hermes reasoning', status unknown, no observed_at_ms, and estimated/unknown uncertainty in its section. attribution_id may select only a listed phone-owned attribution literal; callers never provide URLs.",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    label: { type: "string", minLength: 1, maxLength: 40, description: inertText },
    attribution_id: {
      type: "string", enum: ["open_meteo_ukmo"],
      description: "Adds the fixed phone-owned credit 'Weather data by Open-Meteo.com · CC BY-SA 4.0 · UK Met Office' to every displayed provenance line. No caller-supplied URL is accepted.",
    },
    observed_at_ms: { type: "integer", minimum: 0 },
    stale_after_seconds: { type: "integer", minimum: 30, maximum: 86400 },
    status: { type: "string", enum: ["current", "stale", "unavailable", "unknown"] },
  },
  required: ["id", "label", "stale_after_seconds", "status"],
  additionalProperties: false,
};

const contextLocalActionSchema = {
  type: "object",
  description: "Optional fixed phone-local intent. Omit for ordinary generated answers. Pin/Unpin is injected by the phone and must not be supplied.",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    kind: { type: "string", enum: ["refresh", "section", "follow_up"] },
    label: { type: "string", minLength: 1, maxLength: 24, description: inertText },
    enabled: { type: "boolean" },
  },
  required: ["id", "kind", "label", "enabled"],
  additionalProperties: false,
};

const contextAnnouncementSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    text: { type: "string", minLength: 1, maxLength: 160, description: inertText },
    policy: { type: "string", enum: ["once_when_useful"] },
  },
  required: ["id", "text", "policy"],
  additionalProperties: false,
};

const contextFinalSpecSchema = {
  type: "object",
  description: "One fully gathered terminal answer. Loading, partial data, and pending sections are rejected before any glasses frame is installed.",
  properties: {
    version: { type: "integer", minimum: 2, maximum: 2 },
    presentation_mode: {
      type: "string", enum: ["single", "deck"],
      description: "Omit or use single for legacy flat focus scrolling. Use deck for a cover plus deterministic semantic-section pages (maximum 7); ring scroll changes page and local_actions must be [].",
    },
    dashboard_key: { type: "string", minLength: 1, maxLength: 64 },
    title: { type: "string", minLength: 1, maxLength: 48 },
    state: { type: "string", enum: ["ready", "empty", "error", "offline"] },
    privacy: { type: "string", enum: ["public", "private", "sensitive"] },
    summary: contextSummarySchema,
    sections: { type: "array", minItems: 1, maxItems: 4, items: contextSectionSchema },
    sources: { type: "array", minItems: 1, maxItems: 3, items: contextSourceSchema },
    local_actions: {
      type: "array", maxItems: 3,
      description: "Optional fixed local intents. Must be [] in deck mode. The phone independently injects Pin/Unpin on the deck cover.",
      items: contextLocalActionSchema,
    },
    announcement: contextAnnouncementSchema,
    ttl_seconds: { type: "integer", minimum: 30, maximum: 3600 },
  },
  required: ["version", "dashboard_key", "title", "state", "privacy", "summary", "sections", "sources", "local_actions", "ttl_seconds"],
  additionalProperties: false,
};

export const BRIDGE_PINNED_PHONE_INPUT_SCHEMAS = {
  "glasses.notify_result": {
    type: "object",
    properties: {
      operation_id: {
        ...operationId,
        description: "Stable idempotency key containing only letters, numbers, dot, underscore, or hyphen.",
      },
      text: { type: "string", maxLength: 160, description: "Final inert plain-text result." },
    },
    required: ["operation_id", "text"],
    additionalProperties: false,
  },
  "glasses.work_board.add_task": {
    type: "object",
    properties: {
      operation_id: {
        ...operationId,
        description: "Stable idempotency key; reuse the same value for an identical retry.",
      },
      title: {
        type: "string", minLength: 1, maxLength: 240,
        description: "One-line task title (at most 120 Unicode scalars) for the wearer's Work Tasks board.",
      },
      lane: {
        type: "string", enum: ["inbox", "today", "doing"],
        description: "Initial lane. Omit for Inbox; tasks cannot be created directly in Done.",
      },
    },
    required: ["operation_id", "title"],
    additionalProperties: false,
  },
  "glasses.clock.set_timer": {
    type: "object",
    properties: {
      operation_id: operationId,
      duration_seconds: {
        type: "integer", minimum: 1, maximum: 604800,
        description: "Whole-second countdown duration, up to seven days.",
      },
      label: {
        type: "string", minLength: 1, maxLength: 160,
        description: "Optional inert one-line label (at most 80 Unicode scalars).",
      },
    },
    required: ["operation_id", "duration_seconds"],
    additionalProperties: false,
  },
  "glasses.clock.set_alarm": {
    type: "object",
    properties: {
      operation_id: operationId,
      local_time: {
        type: "string", minLength: 5, maxLength: 5,
        description: "Exact phone-local 24-hour wall time in HH:MM form.",
      },
      date: {
        type: "string", minLength: 10, maxLength: 10,
        description: "Optional real one-shot phone-local date in YYYY-MM-DD form.",
      },
      repeat_days: {
        type: "array", minItems: 1, maxItems: 7,
        items: { type: "string", enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
        description: "Optional unique weekdays for a repeating alarm.",
      },
      label: {
        type: "string", minLength: 1, maxLength: 160,
        description: "Optional inert one-line label (at most 80 Unicode scalars).",
      },
    },
    required: ["operation_id", "local_time"],
    additionalProperties: false,
  },
  "glasses.context_dashboard.present": {
    type: "object",
    properties: {
      operation_id: { type: "string", minLength: 1, maxLength: 64 },
      intent: { type: "string", minLength: 1, maxLength: 240 },
      refresh_policy: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["manual", "on_visible"] },
          min_interval_seconds: { type: "integer", minimum: 30, maximum: 86400 },
        },
        required: ["mode", "min_interval_seconds"],
        additionalProperties: false,
      },
      regeneration: {
        type: "string", enum: ["self_contained_intent", "current_turn_only"],
        description: "Use self_contained_intent only when this bounded intent can independently gather the answer again; otherwise use current_turn_only and local_actions must be empty.",
      },
      spec: contextFinalSpecSchema,
    },
    required: ["operation_id", "intent", "refresh_policy", "regeneration", "spec"],
    additionalProperties: false,
  },
};
