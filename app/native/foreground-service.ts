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
  activities?: Partial<ForegroundActivities>,
): android.content.Intent {
  const context = getContext();
  const intent = new android.content.Intent(context, com.faceclaw.app.FaceclawForegroundService.class);
  intent.setAction(action);
  if (text) {
    intent.putExtra(com.faceclaw.app.FaceclawForegroundService.EXTRA_TEXT, text);
  }
  if (activities) {
    if (activities.connectedDevice !== undefined) intent.putExtra(com.faceclaw.app.FaceclawForegroundService.EXTRA_CONNECTED_DEVICE_ACTIVE, activities.connectedDevice);
    if (activities.phoneMic !== undefined) intent.putExtra(com.faceclaw.app.FaceclawForegroundService.EXTRA_PHONE_MIC_ACTIVE, activities.phoneMic);
    if (activities.location !== undefined) intent.putExtra(com.faceclaw.app.FaceclawForegroundService.EXTRA_LOCATION_ACTIVE, activities.location);
  }
  return intent;
}

export function setForegroundActivities(activities: ForegroundActivities, text: string): void {
  if (!global.isAndroid) return;
  if (!activities.connectedDevice && !activities.phoneMic && !activities.location) {
    const context = getContext();
    context.startService(createIntent(com.faceclaw.app.FaceclawForegroundService.ACTION_STOP));
    return;
  }
  const context = getContext();
  const intent = createIntent(com.faceclaw.app.FaceclawForegroundService.ACTION_START, text, activities);
  androidx.core.content.ContextCompat.startForegroundService(context, intent);
}

export function setForegroundActivity(
  activity: keyof ForegroundActivities,
  active: boolean,
  text: string,
): void {
  if (!global.isAndroid) return;
  const context = getContext();
  const activities: Partial<ForegroundActivities> = { [activity]: active };
  const intent = createIntent(com.faceclaw.app.FaceclawForegroundService.ACTION_UPDATE, text, activities);
  androidx.core.content.ContextCompat.startForegroundService(context, intent);
}

export function startForegroundNotification(text: string): void {
  setForegroundActivity("connectedDevice", true, text);
}

export function updateForegroundNotification(text: string): void {
  setForegroundActivity("connectedDevice", true, text);
}

export function stopForegroundNotification(): void {
  setForegroundActivity("connectedDevice", false, "Glasses disconnected");
}
