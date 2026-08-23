import { EventData, Page } from "@nativescript/core";

import { HermesViewModel } from "./hermes-view-model";

type PageState = { timer: ReturnType<typeof setTimeout> | null; layout: () => void };
const stateByPage = new WeakMap<Page, PageState>();

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  if (!page.bindingContext) page.bindingContext = new HermesViewModel();
}

export function loaded(args: EventData): void {
  const page = args.object as Page;
  const model = page.bindingContext as HermesViewModel;
  model.activate();
  const size = page.getActualSize();
  model.refreshLayoutMetrics(size.width, size.height);
  const prior = stateByPage.get(page);
  if (prior) {
    page.off(Page.layoutChangedEvent, prior.layout);
    if (prior.timer) clearTimeout(prior.timer);
  }
  const state: PageState = { timer: null, layout: () => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      const next = page.getActualSize();
      model.refreshLayoutMetrics(next.width, next.height);
    }, 0);
  } };
  page.on(Page.layoutChangedEvent, state.layout);
  stateByPage.set(page, state);
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  const state = stateByPage.get(page);
  if (state) {
    page.off(Page.layoutChangedEvent, state.layout);
    if (state.timer) clearTimeout(state.timer);
    stateByPage.delete(page);
  }
  (page.bindingContext as HermesViewModel | undefined)?.deactivate();
}
