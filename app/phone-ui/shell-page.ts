import { EventData, Page } from "@nativescript/core";

// The shell only hosts one Frame per tab; each embedded page builds its own
// view-model in its navigatingTo, so the shell needs no binding context.
export function navigatingTo(_args: EventData): void {}

void Page;
