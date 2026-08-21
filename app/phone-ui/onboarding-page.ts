import { Application, EventData, Page } from "@nativescript/core";

import { OnboardingViewModel } from "./onboarding-view-model";

let activeModel: OnboardingViewModel | undefined;

// Returning from a system settings screen (notification access, battery dialog)
// resumes the app Activity (no re-navigation), so re-read the permission
// statuses on the Application resume event to update the ticks.
function onResume(): void {
  activeModel?.refreshPermissions();
}

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  // Preserve the step when returning from the flashing page (back navigation
  // re-fires navigatingTo); only build a fresh model on first entry.
  if (!page.bindingContext) {
    page.bindingContext = new OnboardingViewModel();
  }
  activeModel = page.bindingContext as OnboardingViewModel;
}

export function navigatedTo(): void {
  Application.on(Application.resumeEvent, onResume);
}

export function navigatedFrom(): void {
  Application.off(Application.resumeEvent, onResume);
}
