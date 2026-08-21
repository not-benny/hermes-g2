import { EventData, Page } from "@nativescript/core";

import { WhatsAppViewModel } from "./whatsapp-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) {
    page.bindingContext = new WhatsAppViewModel();
  }
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  const model = page.bindingContext as WhatsAppViewModel | null;
  model?.dispose();
}
