import { EventData, Page } from "@nativescript/core";

import { SettingsViewModel } from "./settings-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new SettingsViewModel();
  }
}

// Settings tab root: keep the VM alive across tab-unload (navigatingTo does not
// re-fire on tab return).
export function unloaded(_args: EventData): void {}
