/** Safety policy for text that may reach the glasses display. */

export const MAX_ALERT_TEXT_LENGTH = 160;

/**
 * Normalize and validate inert plain text before it is retained by a shell
 * surface. Model output is data, not markup or a command language.
 */
export function validateDisplayText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_ALERT_TEXT_LENGTH) return null;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) return null;
  if (/[<>`]/u.test(text) || /(?:https?:\/\/|www\.)/iu.test(text)) return null;
  return text;
}