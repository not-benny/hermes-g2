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
  const minimumHeightPixels = Utils.layout.toDevicePixels(MIN_TAB_BAR_HEIGHT);
  if (!tabLayout || !Number.isFinite(minimumHeightPixels) || minimumHeightPixels <= 0) return;
  // Android View.setMinimumHeight accepts raw pixels. Convert the 56-DIP touch
  // target exactly once; the native TabView grid measures that pixel value as-is.
  tabLayout.setMinimumHeight(Math.round(minimumHeightPixels));
}

void Page;
