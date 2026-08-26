import { EventData, Page } from "@nativescript/core";
import { NotificationRulesViewModel } from "./notification-rules-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) page.bindingContext = new NotificationRulesViewModel();
}

export function unloaded(args: EventData): void {
  (args.object as Page).bindingContext?.dispose?.();
}
