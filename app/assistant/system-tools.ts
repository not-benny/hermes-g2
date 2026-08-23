import { readUpcomingEvents, type CalendarEvent } from "../native/calendar";
import { mediaControllerBridge } from "../native/media-controller";
import { dismissNotification, readActiveNotifications } from "../native/notification-icons";
import { shell } from "../ui/shell/shell";
import { MAX_ALERT_TEXT_LENGTH } from "./display-policy";
import { createShowAlertHandler } from "./display-alert-handler";
import { RenderViewManager } from "./render-view";
import { DYNAMIC_APP_CAPABILITIES, DynamicAppManager } from "./dynamic-app";
import { CONTEXT_DASHBOARD_CAPABILITIES, ContextDashboardManager } from "./context-dashboard";
import { loadContextDashboardPins, saveContextDashboardPins } from "./context-dashboard-persistence";
import { toolRegistry, type ToolRegistry, type ToolResult } from "./tool-registry";

declare const java: any;

/**
 * Registers the always-available system tools into the registry. Called once at
 * startup. These wrap shell state and the existing native bridges (calendar,
 * media, notifications); nothing here needs an app window to be open.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const registeredRegistries = new WeakSet<ToolRegistry>();

export function registerSystemTools(registry: ToolRegistry = toolRegistry): void {
  if (registeredRegistries.has(registry)) return;
  registeredRegistries.add(registry);

  // Keep a media listener warm so "what's playing" works without opening Music.
  void mediaControllerBridge.start();

  registry.registerSystemTool(
    {
      name: "glasses.get_state",
      description:
        "Get the current state of the glasses: display on/off, foreground app, headset battery, and the current local time.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => ok(describeState()),
  );

  registry.registerSystemTool(
    {
      name: "glasses.show_alert",
      description:
        "Show a short text popup on the glasses display. Use for a brief notice the user should see; keep it to a sentence or two.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", maxLength: MAX_ALERT_TEXT_LENGTH, description: "Plain-text message to display." } },
        required: ["text"],
        additionalProperties: false,
      },
      proactive: true,
    },
    createShowAlertHandler({
      isScreenOn: () => shell.isScreenOn(),
      // Preserve the registry-owned cancellation boundary all the way to the
      // shell. Dropping the signal here would let a timed-out MCP call send a
      // queued frame after its tool result had already failed.
      showAlert: (text, signal, isSideEffectAllowed) => shell.showAlert(text, signal, isSideEffectAllowed),
    }),
  );

  let renderViewManager: RenderViewManager;
  renderViewManager = new RenderViewManager({
    isDisplayAvailable: () => shell.isScreenOn(),
    createId: () => String(java.util.UUID.randomUUID()).replace(/-/g, ""),
    render: (state, signal, isAllowed) => shell.showRemoteView(
      state,
      signal,
      isAllowed,
      (gesture, foreground) => renderViewManager.handleGesture(gesture, foreground),
      () => renderViewManager.closeView(state.viewId, state.revision),
    ),
    clear: (identity) => shell.clearRemoteView(identity),
  });
  registry.onExecutionOwnerClosed((owner) => renderViewManager.closeOwner(owner));

  registry.registerSystemTool(
    {
      name: "glasses.render_view",
      description: "Create or revision-replace one bounded, temporary shell-owned glasses view. Never wakes or focuses the display.",
      inputSchema: {
        type: "object",
        properties: {
          operation_id: { type: "string", minLength: 1, maxLength: 64 },
          spec: {
            type: "object",
            properties: {
              version: { type: "integer", minimum: 1, maximum: 1 },
              view_id: { type: "string", minLength: 16, maxLength: 128 },
              expected_revision: { type: "integer", minimum: 1 },
              title: { type: "string", minLength: 1, maxLength: 80 },
              blocks: {
                type: "array", maxItems: 32, items: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["text", "key_value", "progress", "divider"] },
                    text: { type: "string", maxLength: 1024 },
                    emphasis: { type: "string", enum: ["normal", "strong"] },
                    label: { type: "string", maxLength: 80 },
                    value: {},
                  },
                  required: ["type"], additionalProperties: false,
                },
              },
              actions: {
                type: "array", maxItems: 8, items: {
                  type: "object",
                  properties: { id: { type: "string", minLength: 1, maxLength: 64 }, label: { type: "string", minLength: 1, maxLength: 40 } },
                  required: ["id", "label"], additionalProperties: false,
                },
              },
              ttl_seconds: { type: "integer", minimum: 30, maximum: 3600 },
            },
            required: ["version", "title", "blocks", "ttl_seconds"],
            additionalProperties: false,
          },
        },
        required: ["operation_id", "spec"],
        additionalProperties: false,
      },
      timeoutMs: 15_000,
    },
    renderViewManager.handler,
  );

  registry.registerSystemTool(
    {
      name: "glasses.read_view_events",
      description: "Drain bounded user action events from the exact owned render_view revision.",
      inputSchema: {
        type: "object",
        properties: {
          view_id: { type: "string", minLength: 16, maxLength: 128 },
          revision: { type: "integer", minimum: 1 },
        },
        required: ["view_id", "revision"],
        additionalProperties: false,
      },
    },
    (args, _signal, _isAllowed, context) => renderViewManager.readEvents(context, String(args.view_id), Number(args.revision)),
  );

  let dynamicApps: DynamicAppManager;
  dynamicApps = new DynamicAppManager({
    isDisplayAvailable: () => shell.isScreenOn(),
    createId: () => String(java.util.UUID.randomUUID()).replace(/-/g, ""),
    deliver: (state, signal, isAllowed) => shell.showDynamicApp(
      state,
      signal,
      isAllowed,
      (input, foreground) => dynamicApps.handleInput(input, foreground),
      () => dynamicApps.closeView(state.viewId, state.revision),
    ),
    clear: (identity) => shell.clearDynamicApp(identity),
  });
  registry.onExecutionOwnerClosed((owner) => dynamicApps.closeOwner(owner));

  let contextDashboards: ContextDashboardManager;
  contextDashboards = new ContextDashboardManager({
    isDisplayAvailable: () => shell.isScreenOn(),
    createId: () => String(java.util.UUID.randomUUID()).replace(/-/g, ""),
    deliver: (state, signal, isAllowed) => shell.showDynamicApp(
      state,
      signal,
      isAllowed,
      (input, foreground) => contextDashboards.handleInput(input, foreground),
      () => contextDashboards.closeView(state.viewId, state.revision),
    ),
    clear: (identity) => shell.clearDynamicApp(identity),
    loadPins: loadContextDashboardPins,
    savePins: saveContextDashboardPins,
  });
  registry.onExecutionOwnerClosed((owner) => contextDashboards.closeConnection(owner));

  registry.registerSystemTool(
    {
      name: "glasses.context_dashboard.capabilities",
      description: "Query the dedicated even-g2 read-only contextual-dashboard protocol, limits, and local actions.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => ok(JSON.stringify(CONTEXT_DASHBOARD_CAPABILITIES)),
  );

  const contextIdentitySchema = {
    operation_id: { type: "string", minLength: 1, maxLength: 64 },
    dashboard_id: { type: "string", minLength: 16, maxLength: 128 },
    presentation_generation: { type: "integer", minimum: 1 },
    refresh_generation: { type: "integer", minimum: 1 },
    expected_revision: { type: "integer", minimum: 1 },
  };
  const contextSpecSchema = {
    type: "object",
    description: "Versioned read-only dashboard; execution applies independent exact-field, byte, source, section, and record validation.",
    properties: {
      version: { type: "integer", minimum: 2, maximum: 2 },
      dashboard_key: { type: "string", minLength: 1, maxLength: 64 },
      title: { type: "string", minLength: 1, maxLength: 48 },
      state: { type: "string", enum: ["loading", "partial", "ready", "empty", "error", "offline"] },
      privacy: { type: "string", enum: ["public", "private", "sensitive"] },
      summary: { type: "object" },
      sections: { type: "array", minItems: 1, maxItems: 4, items: { type: "object" } },
      sources: { type: "array", minItems: 1, maxItems: 3, items: { type: "object" } },
      local_actions: { type: "array", maxItems: 3, items: { type: "object" } },
      announcement: { type: "object" },
      ttl_seconds: { type: "integer", minimum: 30, maximum: 3600 },
    },
    required: ["version", "dashboard_key", "title", "state", "privacy", "summary", "sections", "sources", "local_actions", "ttl_seconds"],
    additionalProperties: false,
  };

  registry.registerSystemTool(
    {
      name: "glasses.context_dashboard.begin",
      description: "Atomically replace the ephemeral contextual dashboard and acknowledge a loading frame before read-only gathering.",
      inputSchema: { type: "object", properties: {
        operation_id: contextIdentitySchema.operation_id,
        dashboard_key: { type: "string", minLength: 1, maxLength: 64 },
        title: { type: "string", minLength: 1, maxLength: 48 },
        privacy: { type: "string", enum: ["public", "private", "sensitive"] },
        intent: { type: "string", minLength: 1, maxLength: 240 },
        refresh_policy: { type: "object", properties: {
          mode: { type: "string", enum: ["manual", "on_visible"] },
          min_interval_seconds: { type: "integer", minimum: 30, maximum: 86400 },
        }, required: ["mode", "min_interval_seconds"], additionalProperties: false },
        ttl_seconds: { type: "integer", minimum: 30, maximum: 3600 },
      }, required: ["operation_id", "dashboard_key", "title", "privacy", "intent", "refresh_policy", "ttl_seconds"], additionalProperties: false },
      timeoutMs: 15_000,
    },
    (args, signal, isAllowed, context) => contextDashboards.begin(args, signal, isAllowed, context),
  );

  registry.registerSystemTool(
    {
      name: "glasses.context_dashboard.publish",
      description: "CAS-publish one independently validated read-only dashboard revision for the exact presentation and refresh generation.",
      inputSchema: { type: "object", properties: { ...contextIdentitySchema, spec: contextSpecSchema },
        required: ["operation_id", "dashboard_id", "presentation_generation", "refresh_generation", "expected_revision", "spec"], additionalProperties: false },
      timeoutMs: 15_000,
    },
    (args, signal, isAllowed, context) => contextDashboards.publish(args, signal, isAllowed, context),
  );

  registry.registerSystemTool(
    {
      name: "glasses.context_dashboard.start_refresh",
      description: "Start a fresh exact-turn read-only refresh generation while retaining prior data as visibly refreshing.",
      inputSchema: { type: "object", properties: {
        operation_id: contextIdentitySchema.operation_id,
        dashboard_id: contextIdentitySchema.dashboard_id,
        presentation_generation: contextIdentitySchema.presentation_generation,
        expected_revision: contextIdentitySchema.expected_revision,
      }, required: ["operation_id", "dashboard_id", "presentation_generation", "expected_revision"], additionalProperties: false },
      timeoutMs: 15_000,
    },
    (args, signal, isAllowed, context) => contextDashboards.startRefresh(args, signal, isAllowed, context),
  );

  registry.registerSystemTool(
    {
      name: "glasses.context_dashboard.pins",
      description: "List up to five encrypted phone-local dashboard intents and refresh policies; never returns raw tool responses.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => ok(JSON.stringify({ pins: contextDashboards.listPins() })),
  );

  registry.registerSystemTool(
    {
      name: "glasses.context_dashboard.read_events",
      description: "Read the queue head of fixed phone-local refresh, section, or follow-up intents; never returns provider actions.",
      inputSchema: { type: "object", properties: {
        dashboard_id: contextIdentitySchema.dashboard_id,
        presentation_generation: contextIdentitySchema.presentation_generation,
        revision: contextIdentitySchema.expected_revision,
        after_event_id: { type: ["string", "null"], maxLength: 180 },
      }, required: ["dashboard_id", "presentation_generation", "revision"], additionalProperties: false },
    },
    (args, _signal, _isAllowed, context) => contextDashboards.readEvents(context, String(args.dashboard_id),
      Number(args.presentation_generation), Number(args.revision), typeof args.after_event_id === "string" ? args.after_event_id : null),
  );

  registry.registerSystemTool(
    {
      name: "glasses.context_dashboard.ack_events",
      description: "Acknowledge exactly one processed local contextual-dashboard event; duplicate acknowledgement is historical only.",
      inputSchema: { type: "object", properties: { through_event_id: { type: "string", minLength: 1, maxLength: 180 } },
        required: ["through_event_id"], additionalProperties: false },
    },
    (args, _signal, _isAllowed, context) => contextDashboards.ackEvents(context, String(args.through_event_id)),
  );

  registry.registerSystemTool(
    {
      name: "glasses.dynamic_apps.capabilities",
      description: "Query the exact bounded dynamic-app protocol and G2 compositor capabilities.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => ok(JSON.stringify(DYNAMIC_APP_CAPABILITIES)),
  );

  const dynamicSpecSchema = {
    type: "object",
    description: "A versioned inert dynamic-app view model. The runtime applies stricter discriminated validation and byte limits.",
    properties: {
      version: { type: "integer", minimum: 1, maximum: 1 },
      title: { type: "string", minLength: 1, maxLength: 80 },
      state: { type: "string", enum: ["loading", "ready", "empty", "error", "offline"] },
      privacy: { type: "string", enum: ["public", "private", "sensitive"] },
      components: { type: "array", maxItems: 64, items: {
        type: "object",
        description: "One inert discriminated component; the listed fields are type-specific and exact validation is applied at execution.",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 64 },
          type: { type: "string", enum: DYNAMIC_APP_CAPABILITIES.componentTypes },
          text: { type: "string", minLength: 1, maxLength: 1024 },
          label: { type: "string", minLength: 1, maxLength: 80 },
          value: {},
          tone: { type: "string", enum: ["neutral", "good", "warning", "critical"] },
          title: { type: "string", minLength: 1, maxLength: 80 },
          body: { type: "string", minLength: 1, maxLength: 1024 },
          items: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 160 } },
          name: { type: "string", enum: ["info", "check", "warning", "error"] },
          action_handle: { type: "string", minLength: 16, maxLength: 128 },
          confirmation: { type: "string", minLength: 1, maxLength: 160 },
          confirm_handle: { type: "string", minLength: 16, maxLength: 128 },
          cancel_handle: { type: "string", minLength: 16, maxLength: 128 },
        },
        required: ["id", "type"],
        additionalProperties: false,
      } },
      ttl_seconds: { type: "integer", minimum: 30, maximum: 3600 },
    },
    required: ["version", "title", "state", "privacy", "components", "ttl_seconds"],
    additionalProperties: false,
  };
  const operationIdentitySchema = {
    operation_id: { type: "string", minLength: 1, maxLength: 64 },
    view_id: { type: "string", minLength: 16, maxLength: 128 },
    expected_revision: { type: "integer", minimum: 1 },
  };

  registry.registerSystemTool(
    {
      name: "glasses.dynamic_apps.create",
      description: "Create one bounded dynamic glasses app for the exact authenticated socket and turn. Never wakes the display.",
      inputSchema: { type: "object", properties: { operation_id: operationIdentitySchema.operation_id, spec: dynamicSpecSchema },
        required: ["operation_id", "spec"], additionalProperties: false },
      timeoutMs: 15_000,
    },
    (args, signal, isAllowed, context) => dynamicApps.create(args, signal, isAllowed, context),
  );

  registry.registerSystemTool(
    {
      name: "glasses.dynamic_apps.update",
      description: "CAS-replace the exact current dynamic app revision after acknowledged lens transport delivery.",
      inputSchema: { type: "object", properties: { ...operationIdentitySchema, spec: dynamicSpecSchema },
        required: ["operation_id", "view_id", "expected_revision", "spec"], additionalProperties: false },
      timeoutMs: 15_000,
    },
    (args, signal, isAllowed, context) => dynamicApps.update(args, signal, isAllowed, context),
  );

  registry.registerSystemTool(
    {
      name: "glasses.dynamic_apps.patch",
      description: "CAS-patch components by stable component ID; unknown fields and duplicate IDs fail closed.",
      inputSchema: {
        type: "object",
        properties: { ...operationIdentitySchema, patch: { type: "object", properties: {
          upsert: { type: "array", maxItems: 64, items: dynamicSpecSchema.properties.components.items },
          remove: { type: "array", maxItems: 64, items: { type: "string", maxLength: 64 } },
        }, required: ["upsert", "remove"], additionalProperties: false } },
        required: ["operation_id", "view_id", "expected_revision", "patch"], additionalProperties: false,
      },
      timeoutMs: 15_000,
    },
    (args, signal, isAllowed, context) => dynamicApps.patch(args, signal, isAllowed, context),
  );

  registry.registerSystemTool(
    {
      name: "glasses.dynamic_apps.close",
      description: "Close and tombstone the exact owned dynamic app revision.",
      inputSchema: { type: "object", properties: operationIdentitySchema,
        required: ["operation_id", "view_id", "expected_revision"], additionalProperties: false },
    },
    (args, _signal, _isAllowed, context) => dynamicApps.close(args, context),
  );

  registry.registerSystemTool(
    {
      name: "glasses.dynamic_apps.read_events",
      description: "Read bounded inert wearer intents after an optional acknowledged event cursor; events are not provider commands.",
      inputSchema: { type: "object", properties: {
        view_id: operationIdentitySchema.view_id,
        revision: operationIdentitySchema.expected_revision,
        after_event_id: { type: ["string", "null"], maxLength: 160 },
      }, required: ["view_id", "revision"], additionalProperties: false },
    },
    (args, _signal, _isAllowed, context) => dynamicApps.readEvents(
      context, String(args.view_id), Number(args.revision), typeof args.after_event_id === "string" ? args.after_event_id : null,
    ),
  );

  registry.registerSystemTool(
    {
      name: "glasses.dynamic_apps.ack_events",
      description: "Acknowledge wearer intents through one exact event ID so retries never lose an unprocessed action.",
      inputSchema: { type: "object", properties: {
        view_id: operationIdentitySchema.view_id,
        revision: operationIdentitySchema.expected_revision,
        through_event_id: { type: "string", minLength: 1, maxLength: 160 },
      }, required: ["view_id", "revision", "through_event_id"], additionalProperties: false },
    },
    (args, _signal, _isAllowed, context) => dynamicApps.ackEvents(
      context, String(args.view_id), Number(args.revision), String(args.through_event_id),
    ),
  );

  registry.registerSystemTool(
    {
      name: "calendar.list_events",
      description:
        "List the user's upcoming calendar events. Returns events from now forward, ordered by start time.",
      inputSchema: {
        type: "object",
        properties: {
          within_hours: {
            type: "number",
            description: "Only include events starting within this many hours (default 168 = one week).",
          },
          max_events: { type: "number", description: "Maximum number of events to return (default 10)." },
        },
        additionalProperties: false,
      },
    },
    (args) => {
      const withinHours = clampNumber(args?.within_hours, 1, 24 * 60, 168);
      const maxEvents = clampNumber(args?.max_events, 1, 50, 10);
      const result = readUpcomingEvents(maxEvents, withinHours * 60 * 60 * 1000);
      if (result.status === "permission_denied") return err("Calendar permission is not granted.");
      if (result.status === "provider_unavailable") return err("Calendar provider is unavailable.");
      if (result.status === "query_failed") return err("Calendar query failed.");
      const events = result.events;
      if (!events.length) return ok("No upcoming events in that window.");
      return ok(events.map(formatEvent).join("\n"));
    },
  );

  registry.registerSystemTool(
    {
      name: "media.now_playing",
      description: "What is currently playing (or paused) in the user's media app, if anything.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      proactive: true,
    },
    () => ok(describeNowPlaying()),
  );

  registry.registerSystemTool(
    {
      name: "media.play_pause",
      description: "Toggle play/pause for the user's current media session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      const state = mediaControllerBridge.snapshot();
      if (!state.canPlayPause) return err("No media session can be controlled right now.");
      await mediaControllerBridge.playPause();
      return ok("Toggled play/pause.");
    },
  );

  registry.registerSystemTool(
    {
      name: "media.next",
      description: "Skip to the next track in the user's current media session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async () => {
      const state = mediaControllerBridge.snapshot();
      if (!state.canSkipNext) return err("The current media session can't skip to the next track.");
      await mediaControllerBridge.skipNext();
      return ok("Skipped to the next track.");
    },
  );

  registry.registerSystemTool(
    {
      name: "notifications.list",
      description: "List the user's current Android notifications mirrored to the glasses.",
      inputSchema: {
        type: "object",
        properties: { max: { type: "number", description: "Maximum notifications to return (default 10)." } },
        additionalProperties: false,
      },
    },
    (args) => {
      const max = clampNumber(args?.max, 1, 50, 10);
      const notifications = readActiveNotifications(max);
      if (!notifications.length) return ok("No current notifications.");
      return ok(notifications.map(formatNotification).join("\n"));
    },
  );

  registry.registerSystemTool(
    {
      name: "notifications.dismiss",
      description:
        "Dismiss a notification by its key (as returned by notifications.list). Returns whether it was dismissed.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string", description: "The notification key from notifications.list." } },
        required: ["key"],
        additionalProperties: false,
      },
    },
    (args) => {
      const key = String(args?.key ?? "").trim();
      if (!key) return err("notifications.dismiss requires a key");
      return dismissNotification(key) ? ok("Dismissed.") : err("No notification with that key.");
    },
  );
}

function describeState(): string {
  const parts: string[] = [];
  parts.push(`Display: ${shell.isScreenOn() ? "on" : "off"}.`);
  const fg = shell.getForegroundApp();
  parts.push(fg ? `Foreground app: ${fg.appId} ("${fg.title}").` : "Foreground: launcher (no app open).");
  const battery = shell.getBatteryLevels();
  if (battery.headset !== null) {
    const charging = battery.headsetCharging ? ", charging" : "";
    parts.push(`Headset battery: ${battery.headset}%${charging}.`);
  }
  parts.push(`Local time: ${formatDateTime(new Date())}.`);
  return parts.join(" ");
}

function describeNowPlaying(): string {
  const state = mediaControllerBridge.snapshot();
  if (!state.accessEnabled) return "Notification access isn't granted, so media state is unavailable.";
  if (state.playbackState === "playing" || state.playbackState === "paused") {
    const verb = state.playbackState === "playing" ? "Playing" : "Paused";
    const title = state.title || "(unknown title)";
    const artist = state.artist ? ` by ${state.artist}` : "";
    const app = state.appName ? ` in ${state.appName}` : "";
    return `${verb}: ${title}${artist}${app}.`;
  }
  return "Nothing is currently playing.";
}

function formatEvent(event: CalendarEvent): string {
  const when = event.allDay ? `${formatDate(new Date(event.startMs))} (all day)` : formatDateTime(new Date(event.startMs));
  const location = event.location ? ` @ ${event.location}` : "";
  return `- ${event.title || "(untitled)"} — ${when}${location}`;
}

function formatNotification(notification: { key: string; appName: string; title: string; text: string }): string {
  const title = notification.title || "(no title)";
  const body = notification.text ? `: ${notification.text}` : "";
  return `- [${notification.appName}] ${title}${body} (key: ${notification.key})`;
}

function formatDateTime(date: Date): string {
  return `${formatDate(date)}, ${formatTime(date)}`;
}

function formatDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function formatTime(date: Date): string {
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const meridiem = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${meridiem}`;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function ok(content: string): ToolResult {
  return { ok: true, content };
}

function err(error: string): ToolResult {
  return { ok: false, error };
}
