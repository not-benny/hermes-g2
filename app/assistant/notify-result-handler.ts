import {
  DirectNotificationStoreError,
  normalizeDirectNotificationText,
  type DirectNotificationAcceptance,
} from "./direct-notification-store";
import type { ToolHandler, ToolResult } from "./tool-registry";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type NotifyResultDependencies = {
  enqueueResult: (
    operationId: string,
    text: string,
    isSideEffectAllowed?: () => boolean,
  ) => DirectNotificationAcceptance;
};

function response(
  status: "queued" | "historical_acknowledgement",
  operationId: string,
): ToolResult {
  return { ok: true, content: JSON.stringify({ status, operation_id: operationId }) };
}

function isExactRequest(value: unknown): value is { operation_id: string; text: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("operation_id") && keys.includes("text");
}

function storeFailure(error: unknown): ToolResult {
  if (error instanceof DirectNotificationStoreError) {
    switch (error.code) {
      case "operation_conflict":
        return { ok: false, error: "operation_id was reused with different notification text" };
      case "capacity":
        return { ok: false, error: "The retained direct-notification inbox is full; no notification was added" };
      case "superseded":
        return { ok: false, error: "The direct notification is no longer authorized; no notification was added" };
      case "invalid_operation_id":
      case "invalid_text":
        return { ok: false, error: "notify_result requires a valid bounded operation_id and final plain text" };
      case "persistence_failed":
      case "stale":
      case "unavailable":
        return { ok: false, error: "The encrypted direct-notification inbox is unavailable; no notification was added" };
    }
  }
  return { ok: false, error: "The direct notification could not be retained safely" };
}

/**
 * Authenticated acceptance boundary for completed Hermes results. The remote
 * side effect is the synchronous encrypted queue commit. Presentation is later
 * phone-owned, so it does not retain the MCP call's abort/connection authority.
 */
export function createNotifyResultHandler(deps: NotifyResultDependencies): ToolHandler {
  return async (args, signal, isSideEffectAllowed, context) => {
    const authenticatedProactiveG2 =
      context?.caller === "mcp" &&
      context.proactive === true &&
      context.profileId === "even-g2" &&
      context.turnGeneration === null &&
      context.connectionGeneration !== undefined &&
      context.connectionGeneration !== null &&
      context.connectionGeneration !== "";
    if (!authenticatedProactiveG2) {
      return { ok: false, error: "notify_result accepts only authenticated proactive calls from the even-g2 profile" };
    }
    if (!isExactRequest(args) || typeof args.operation_id !== "string" || !OPERATION_ID_PATTERN.test(args.operation_id)) {
      return { ok: false, error: "notify_result requires a valid bounded operation_id and final text" };
    }
    const text = normalizeDirectNotificationText(args.text);
    if (!text) {
      return { ok: false, error: "notify_result requires bounded final plain text (no markup, URLs, or control characters)" };
    }

    const isAuthorized = () =>
      !signal?.aborted &&
      (!isSideEffectAllowed || isSideEffectAllowed());
    if (!isAuthorized()) {
      return { ok: false, error: "The direct notification is no longer authorized; no notification was added" };
    }

    try {
      const receipt = deps.enqueueResult(args.operation_id, text, isAuthorized);
      return response(receipt.status, args.operation_id);
    } catch (error) {
      return storeFailure(error);
    }
  };
}
