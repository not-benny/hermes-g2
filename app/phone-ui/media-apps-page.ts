import { EventData, Page } from "@nativescript/core";

import { MediaAppsViewModel } from "./media-apps-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new MediaAppsViewModel();
  }
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  const model = page.bindingContext as MediaAppsViewModel | null;
  model?.dispose();
}
