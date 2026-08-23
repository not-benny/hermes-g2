export type TranscriptAccumulatorState = {
  finalizedText: string;
  liveText: string;
};

export type TranscriptAccumulatorEvent = {
  text: string;
  isFinal: boolean;
  sourceFinalDelta?: string;
  sourceRevisionPresent?: boolean;
};

function append(left: string, right: string): string {
  return [left.trim(), right.trim()].filter(Boolean).join(" ");
}

/**
 * Provider-neutral voice-input accumulator. Incremental provider final tokens
 * append exactly once while partial text remains replace-semantics.
 */
export function applyTranscriptText(
  state: TranscriptAccumulatorState,
  event: TranscriptAccumulatorEvent,
): TranscriptAccumulatorState {
  let finalizedText = append(state.finalizedText, event.sourceFinalDelta ?? "");
  let liveText = state.liveText;
  const sourceRevisionPresent = event.sourceRevisionPresent ?? true;

  if (event.isFinal) {
    const eventFinal = event.text.trim();
    const fallback = event.sourceFinalDelta ? "" : liveText.trim();
    finalizedText = append(finalizedText, eventFinal || fallback);
    liveText = "";
  } else if (sourceRevisionPresent) {
    liveText = event.text.trim();
  }

  return { finalizedText, liveText };
}
