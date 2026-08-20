import { EventData, Page } from "@nativescript/core";

import { SettingsViewModel } from "./settings-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new SettingsViewModel();
  }
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  (page.bindingContext as SettingsViewModel | null)?.dispose();
}
