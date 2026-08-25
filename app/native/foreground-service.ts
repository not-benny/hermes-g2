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

/**
 * Release updates are idempotent. Android O+ may reject an ordinary service
 * start while the app is backgrounded when the shared service is already
 * absent; in that case there is no foreground lease left to release.
 */
function startReleaseUpdate(
  context: android.content.Context,
  intent: android.content.Intent,
): void {
  try {
    context.startService(intent);
  } catch (error) {
    const nativeError = (error as { nativeException?: unknown } | null)?.nativeException ?? error;
    if (nativeError instanceof java.lang.IllegalStateException) return;
    throw error;
  }
}

export function setForegroundActivities(activities: ForegroundActivities, text: string): void {
  if (!global.isAndroid) return;
  if (!activities.connectedDevice && !activities.phoneMic && !activities.location) {
    const context = getContext();
    startReleaseUpdate(
      context,
      createIntent(com.faceclaw.app.FaceclawForegroundService.ACTION_STOP),
    );
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
  if (active) {
    // Android requires every startForegroundService() request to reach
    // Service.startForeground(), even if another queued update immediately
    // releases the same activity. Only a positive activity claim may create
    // that contract; a false update can legitimately leave no foreground
    // service type to promote.
    androidx.core.content.ContextCompat.startForegroundService(context, intent);
  } else {
    // This is a partial release rather than ACTION_STOP: Clock recovery or a
    // different activity may still own the shared service. When the service
    // is absent, a background-start rejection is an idempotent no-op.
    startReleaseUpdate(context, intent);
  }
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
