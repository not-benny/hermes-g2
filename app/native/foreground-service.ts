import { Utils } from "@nativescript/core";

declare const com: any;

function getContext(): android.content.Context {
  const context = Utils.android.getApplicationContext();
  if (!context) throw new Error("Android application context unavailable");
  return context;
}

export type ForegroundActivities = {
  connectedDevice: boolean;
  phoneMic: boolean;
  location: boolean;
};

function createIntent(
  action: string,
  text?: string,
  activities?: ForegroundActivities,
): android.content.Intent {
  const context = getContext();
  const intent = new android.content.Intent(context, com.faceclaw.app.FaceclawForegroundService.class);
  intent.setAction(action);
  if (text) {
    intent.putExtra(com.faceclaw.app.FaceclawForegroundService.EXTRA_TEXT, text);
  }
  if (activities) {
    intent.putExtra(com.faceclaw.app.FaceclawForegroundService.EXTRA_CONNECTED_DEVICE_ACTIVE, activities.connectedDevice);
    intent.putExtra(com.faceclaw.app.FaceclawForegroundService.EXTRA_PHONE_MIC_ACTIVE, activities.phoneMic);
    intent.putExtra(com.faceclaw.app.FaceclawForegroundService.EXTRA_LOCATION_ACTIVE, activities.location);
  }
  return intent;
}

export function setForegroundActivities(activities: ForegroundActivities, text: string): void {
  if (!global.isAndroid) return;
  if (!activities.connectedDevice && !activities.phoneMic && !activities.location) {
    stopForegroundNotification();
    return;
  }
  const context = getContext();
  const intent = createIntent(com.faceclaw.app.FaceclawForegroundService.ACTION_START, text, activities);
  androidx.core.content.ContextCompat.startForegroundService(context, intent);
}

export function startForegroundNotification(text: string): void {
  setForegroundActivities({ connectedDevice: true, phoneMic: false, location: false }, text);
}

export function updateForegroundNotification(text: string): void {
  setForegroundActivities({ connectedDevice: true, phoneMic: false, location: false }, text);
}

export function stopForegroundNotification(): void {
  if (!global.isAndroid) return;
  const context = getContext();
  context.startService(createIntent(com.faceclaw.app.FaceclawForegroundService.ACTION_STOP));
}
