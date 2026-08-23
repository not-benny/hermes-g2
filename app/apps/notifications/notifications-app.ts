import { NotificationsListLayer } from "../../ui/notifications";
import { dismissAllNotifications, onAndroidNotificationEvent } from "../../native/notification-icons";
import { notificationTriageController } from "../../notifications/triage-controller";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";

export const NOTIFICATIONS_WINDOW_ID = "notifications";
export const NOTIFICATIONS_SURFACE_ID = "window:notifications";

/**
 * The Notifications app: the Android-notification list (previously a
 * dashboard page) in its own in-process window; selecting a notification
 * opens the detail view with its quick actions.
 */
export function createNotificationsAppWindow(options: InProcessAppOptions): InProcessWindow {
  // Newly posted notifications repaint the list while the window is open.
  let offNotificationPosted: (() => void) | null = null;
  let created: InProcessWindow | null = null;
  created = createInProcessWindow({
    appId: "notifications",
    windowId: NOTIFICATIONS_WINDOW_ID,
    title: "Notifications",
    iconLetter: "N",
    icon: "bell",
    closeable: true,
    menuItems: () => [{
      label: "Dismiss all",
      onSelect: (ctx) => {
        notificationTriageController.clearAll(`glasses-${Date.now()}`);
        dismissAllNotifications();
        ctx.stack.pop();
        // cancelNotification is asynchronous in Android's status bar service;
        // repaint again after it has delivered the removal callbacks.
        setTimeout(() => created?.requestRender(), 100);
      },
    }],
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new NotificationsListLayer()),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: () => {
      offNotificationPosted?.();
      options.onClosed();
    },
  });
  offNotificationPosted = onAndroidNotificationEvent(() => created.requestRender());
  return created;
}
