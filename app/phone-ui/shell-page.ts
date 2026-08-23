import { EventData, Page, TabView, Utils } from "@nativescript/core";

const MIN_TAB_BAR_HEIGHT = 56;

// The shell only hosts one Frame per tab; each embedded page builds its own
// view-model in its navigatingTo, so the shell needs no binding context.
export function navigatingTo(_args: EventData): void {}

export function loaded(args: EventData): void {
  if (!global.isAndroid) return;
  const page = args.object as Page;
  const tabs = page.getViewById<TabView>("shellTabs");
  const tabLayout = (tabs as any)?.nativeViewProtected?.tabLayout as
    | { setMinimumHeight(value: number): void }
    | undefined;
  const density = Utils.layout.getDisplayDensity();
  if (!tabLayout || !Number.isFinite(density) || density <= 0) return;
  // NativeScript's Android TabView grid normalizes the native minimum by
  // density once more. Compensate here so the measured row remains 56 DIP.
  tabLayout.setMinimumHeight(Math.round(MIN_TAB_BAR_HEIGHT * density * density));
}

void Page;
