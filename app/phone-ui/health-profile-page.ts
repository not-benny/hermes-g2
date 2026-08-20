import { EventData, Page } from "@nativescript/core";

import { HealthProfileViewModel } from "./health-profile-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  page.bindingContext = new HealthProfileViewModel();
}
