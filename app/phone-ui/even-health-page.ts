import { EventData, Page } from "@nativescript/core";

import { EvenHealthViewModel } from "./even-health-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new EvenHealthViewModel();
  }
}
