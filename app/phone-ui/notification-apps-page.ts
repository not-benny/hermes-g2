import { EventData, Page } from "@nativescript/core";

import { NotificationAppsViewModel } from "./notification-apps-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new NotificationAppsViewModel();
  }
}

export function loaded(args: EventData): void {
  const page = args.object as Page;
  const model = page.bindingContext as NotificationAppsViewModel | null;
  model?.activate();
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  const model = page.bindingContext as NotificationAppsViewModel | null;
  model?.deactivate();
}
