/**
 * Decide whether a completed background tool turn needs the full assistant UI.
 * Short declarative confirmations stay as brief alerts; questions, explicit
 * choices and long explanations reopen the conversational overlay.
 */
export function assistantReplyNeedsOverlay(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > 160 || trimmed.includes("?")) return true;
  const asksForChoice = /\b(?:say|reply|answer|pick|select|respond|provide)\b[^.!?]{0,80}\b(?:or|and)\b/i.test(trimmed);
  return asksForChoice || /(?:please choose|choose one|which one|which .* did you mean|^(?:please\s+)?tell me\b|^(?:please\s+)?confirm\b)/i.test(trimmed);
}
