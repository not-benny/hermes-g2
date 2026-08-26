import { EventData, Page, TabView, Utils } from "@nativescript/core";

const MIN_TAB_BAR_HEIGHT = 56;
const TAB_LABEL_HORIZONTAL_PADDING = 4;

type AndroidTabLayout = {
  setMinimumHeight(value: number): void;
  getItemCount(): number;
  getTextViewForItemAt(index: number): android.widget.TextView | null;
  getViewForItemAt(index: number): android.widget.LinearLayout | null;
};

function configureAndroidTabBar(tabs: TabView, tabLayout: AndroidTabLayout): void {
  const minimumHeightPixels = Utils.layout.toDevicePixels(MIN_TAB_BAR_HEIGHT);
  const labelPaddingPixels = Math.round(Utils.layout.toDevicePixels(TAB_LABEL_HORIZONTAL_PADDING));
  if (Number.isFinite(minimumHeightPixels) && minimumHeightPixels > 0) {
    // Android View.setMinimumHeight accepts raw pixels. Convert the 56-DIP
    // touch target exactly once; the native TabView grid measures it as-is.
    tabLayout.setMinimumHeight(Math.round(minimumHeightPixels));
  }

  // NativeScript's Android TabLayout gives every label 16 DIP of padding on
  // both sides. Five evenly distributed text-only tabs leave 72 DIP per item
  // on a 360-DIP cover display, so labels such as "Glasses" become wider than
  // their cell and the first glyph is visibly clipped. Keep a small breathing
  // space, constrain paint to one line, and leave the complete label available
  // to TalkBack through the tab view's content description.
  for (let index = 0; index < tabLayout.getItemCount(); index += 1) {
    const label = tabLayout.getTextViewForItemAt(index);
    const itemView = tabLayout.getViewForItemAt(index);
    if (!label || !itemView) continue;
    label.setPadding(
      labelPaddingPixels,
      label.getPaddingTop(),
      labelPaddingPixels,
      label.getPaddingBottom(),
    );
    label.setSingleLine(true);
    label.setEllipsize(android.text.TextUtils.TruncateAt.END);
    const title = tabs.items?.[index]?.title;
    if (title) {
      // The whole clickable tab is the accessibility node; suppress the child
      // label as a second focus stop so TalkBack announces each tab only once.
      label.setImportantForAccessibility(android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO);
      itemView.setImportantForAccessibility(android.view.View.IMPORTANT_FOR_ACCESSIBILITY_YES);
      itemView.setContentDescription(`${title} tab`);
    }
  }
}

// The shell only hosts one Frame per tab; each embedded page builds its own
// view-model in its navigatingTo, so the shell needs no binding context.
export function navigatingTo(_args: EventData): void {}

export function loaded(args: EventData): void {
  if (!global.isAndroid) return;
  const page = args.object as Page;
  const tabs = page.getViewById<TabView>("shellTabs");
  const tabLayout = (tabs as any)?.nativeViewProtected?.tabLayout as
    | AndroidTabLayout
    | undefined;
  if (!tabs || !tabLayout) return;
  configureAndroidTabBar(tabs, tabLayout);
}

void Page;
