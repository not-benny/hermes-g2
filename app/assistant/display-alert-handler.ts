import { validateDisplayText } from "./display-policy";
import type { ToolHandler } from "./tool-registry";

export type DisplayAlertDependencies = {
  isScreenOn: () => boolean;
  showAlert: (text: string) => Promise<void>;
};

/** The behavioral boundary for the glasses.show_alert tool. */
export function createShowAlertHandler(deps: DisplayAlertDependencies): ToolHandler {
  return async (args) => {
    const text = validateDisplayText(args?.text);
    if (!text) return { ok: false, error: "show_alert requires bounded plain text (no markup, URLs, or control characters)" };
    if (!deps.isScreenOn()) return { ok: false, error: "The glasses display is off; no alert was sent." };
    try {
      await deps.showAlert(text);
      return { ok: true, content: "Displayed." };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The glasses could not display the alert; no success was reported." };
    }
  };
}
