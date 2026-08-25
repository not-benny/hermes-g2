import {
  WorkTasksError,
  type WorkTaskAddInput,
  type WorkTaskReceipt,
} from "../work-tasks/store";
import type { ToolHandler, ToolResult } from "./tool-registry";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const LANES = new Set(["inbox", "today", "doing"]);

export type WorkBoardAddDependencies = {
  addTask: (input: WorkTaskAddInput, isAllowed?: () => boolean) => WorkTaskReceipt;
};

function isExactRequest(value: unknown): value is {
  operation_id: string;
  title: string;
  lane?: "inbox" | "today" | "doing";
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.includes("operation_id") || !keys.includes("title")) return false;
  return keys.every((key) => key === "operation_id" || key === "title" || key === "lane");
}

function receiptIsExact(receipt: unknown, operationId: string): receipt is WorkTaskReceipt {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const value = receipt as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "board_revision,lane,operation_id,status,task_id") return false;
  return (
    (value.status === "acknowledged" || value.status === "historical_acknowledgement") &&
    value.operation_id === operationId &&
    typeof value.task_id === "string" && /^wt_[a-f0-9]{32}$/.test(value.task_id) &&
    (value.lane === "inbox" || value.lane === "today" || value.lane === "doing") &&
    typeof value.board_revision === "number" &&
    Number.isSafeInteger(value.board_revision) && value.board_revision >= 1
  );
}

function errorResult(error: unknown): ToolResult {
  const code = error instanceof WorkTasksError
    ? error.code
    : typeof (error as any)?.code === "string"
      ? String((error as any).code)
      : "unavailable";
  switch (code) {
    case "invalid_operation_id":
    case "invalid_title":
    case "invalid_lane":
      return { ok: false, error: "Work Tasks requires a valid operation_id, one-line title, and Inbox, Today, or Doing lane" };
    case "operation_conflict":
      return { ok: false, error: "operation_id was already used for a different Work Tasks change" };
    case "capacity":
      return { ok: false, error: "Work Tasks is full; no task was added" };
    case "superseded":
      return { ok: false, error: "The authorizing glasses turn ended before commit; nothing was changed" };
    case "persistence_failed":
    case "unavailable":
    default:
      return { ok: false, error: "Work Tasks could not save the task; nothing was changed" };
  }
}

/**
 * Active-turn-only boundary for adding a task to the phone-owned Work Tasks
 * board. Hermes receives a durable receipt, never task-store contents.
 */
export function createWorkBoardAddHandler(deps: WorkBoardAddDependencies): ToolHandler {
  return (args, signal, isSideEffectAllowed, context) => {
    const activeAuthenticatedG2Turn =
      context?.caller === "mcp" &&
      context.proactive === false &&
      context.profileId === "even-g2" &&
      typeof context.turnGeneration === "string" &&
      context.turnGeneration.length > 0 &&
      context.connectionGeneration !== undefined &&
      context.connectionGeneration !== null &&
      context.connectionGeneration !== "";
    if (!activeAuthenticatedG2Turn) {
      return { ok: false, error: "Work Tasks accepts only an authenticated active turn from the even-g2 profile" };
    }
    if (!isExactRequest(args) || !OPERATION_ID_PATTERN.test(args.operation_id) ||
        typeof args.title !== "string" ||
        (args.lane !== undefined && (typeof args.lane !== "string" || !LANES.has(args.lane)))) {
      return { ok: false, error: "Work Tasks requires a valid operation_id, one-line title, and optional Inbox, Today, or Doing lane" };
    }

    const isAuthorized = () =>
      !signal?.aborted &&
      (!isSideEffectAllowed || isSideEffectAllowed());
    if (!isAuthorized()) {
      return { ok: false, error: "The authorizing glasses turn ended before commit; nothing was changed" };
    }

    let receipt: WorkTaskReceipt;
    try {
      receipt = deps.addTask({
        operationId: args.operation_id,
        title: args.title,
        lane: args.lane,
      }, isAuthorized);
    } catch (error) {
      return errorResult(error);
    }

    if (!receiptIsExact(receipt, args.operation_id)) {
      return { ok: false, error: "Work Tasks saved an unconfirmed result; check the board before retrying" };
    }
    if (!isAuthorized()) {
      return {
        ok: false,
        error: "The task may have been saved but the turn ended before confirmation; check Work Tasks and retry only with the same operation_id",
      };
    }
    return { ok: true, content: JSON.stringify(receipt) };
  };
}
