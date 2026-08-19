import { EventData, Page } from "@nativescript/core";

import { ApiKeysViewModel } from "./api-keys-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new ApiKeysViewModel();
  }
}
