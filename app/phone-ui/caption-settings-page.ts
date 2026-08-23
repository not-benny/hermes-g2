import { EventData, Page } from "@nativescript/core";

import { CaptionSettingsViewModel } from "./caption-settings-view-model";
import { applyInputColors } from "./input-colors";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) page.bindingContext = new CaptionSettingsViewModel();
}

export function loaded(args: EventData): void {
  applyInputColors(args.object as Page);
}
