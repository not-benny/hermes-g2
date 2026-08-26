import { EventData, Page } from "@nativescript/core";

import { EvenHealthViewModel } from "./even-health-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new EvenHealthViewModel();
  }
}

export function loaded(args: EventData): void {
  const page = args.object as Page;
  (page.bindingContext as EvenHealthViewModel | undefined)?.activate(page);
}

// NativeScript retains the tab root VM while unloading distant tabs. Release
// its listeners/timer while hidden; loaded() reactivates and refreshes it from
// the process-wide store because navigatingTo does not re-fire on tab return.
export function unloaded(args: EventData): void {
  (args.object as Page).bindingContext?.deactivate?.();
}
