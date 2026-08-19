import { EventData, Page } from "@nativescript/core";

import { ApiKeysViewModel } from "./api-keys-view-model";
import { applyInputColors } from "./input-colors";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new ApiKeysViewModel();
  }
}

export function loaded(args: EventData): void {
  applyInputColors(args.object as Page);
}
