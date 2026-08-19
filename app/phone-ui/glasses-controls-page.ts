import { EventData, Page } from "@nativescript/core";

import { GlassesControlsViewModel } from "./glasses-controls-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new GlassesControlsViewModel();
  }
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  const model = page.bindingContext as GlassesControlsViewModel | null;
  model?.dispose();
}
