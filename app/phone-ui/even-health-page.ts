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
  // Build the readiness ring gauge once the AbsoluteLayout mount exists.
  (page.bindingContext as EvenHealthViewModel | undefined)?.buildRing(page);
}

// Health tab root: keep the VM (and its ring-store subscription) alive across
// tab-unload, since navigatingTo does not re-fire on tab return.
export function unloaded(_args: EventData): void {}
