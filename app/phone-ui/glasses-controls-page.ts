import { EventData, Page } from "@nativescript/core";

import { GlassesControlsViewModel } from "./glasses-controls-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new GlassesControlsViewModel();
  }
}

// As a bottom-TabView tab root, this page is unloaded when the user tabs 2+
// tabs away, but navigatingTo does NOT re-fire on return - so disposing here
// would leave a dead, unsubscribed view-model. Keep it alive for the tab's
// life instead (its subscriptions are cheap background updates).
export function unloaded(_args: EventData): void {}
