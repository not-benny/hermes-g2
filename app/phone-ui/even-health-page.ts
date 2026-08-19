import { EventData, Page } from "@nativescript/core";

import { EvenHealthViewModel } from "./even-health-view-model";
import { applyInputColors } from "./input-colors";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new EvenHealthViewModel();
  }
}

export function loaded(args: EventData): void {
  applyInputColors(args.object as Page);
}
