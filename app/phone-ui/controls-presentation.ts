/**
 * Dependency-free presentation rules for the phone's live glasses controls.
 * Keeping these rules outside NativeScript makes the connection/action states
 * executable in Node tests instead of relying on XML string assertions.
 */
export type ControlsConnectionPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "charging"
  | "disconnecting";

export type ControlsConnectionPresentation = {
  title: string;
  detail: string;
  bannerClass: string;
  controlsEnabled: boolean;
  reconnectEnabled: boolean;
};

function fallbackDetail(phase: ControlsConnectionPhase): string {
  switch (phase) {
    case "connecting":
      return "Preparing the Bluetooth session…";
    case "connected":
      return "Live display and sensor actions are available.";
    case "charging":
      return "Live controls pause while the glasses are charging.";
    case "disconnecting":
      return "Closing the current Bluetooth session…";
    default:
      return "Connect from the Glasses tab to use live actions.";
  }
}

function isFailureStatus(status: string): boolean {
  return /(?:fail|error|could not|unavailable)/i.test(status);
}

export function controlsConnectionPresentation(
  phase: ControlsConnectionPhase,
  status: string,
): ControlsConnectionPresentation {
  const detail = status.trim() || fallbackDetail(phase);
  const failure = isFailureStatus(detail);
  switch (phase) {
    case "connected":
      return {
        title: "Glasses connected",
        detail,
        bannerClass: failure ? "status-banner status-danger" : "status-banner status-success",
        controlsEnabled: true,
        // Reconnect is a recovery action for a live-but-stuck two-arm session.
        // The controller safely tears down the current generation first.
        reconnectEnabled: true,
      };
    case "connecting":
      return {
        title: "Connecting to glasses",
        detail,
        bannerClass: failure ? "status-banner status-danger" : "status-banner status-info",
        controlsEnabled: false,
        reconnectEnabled: false,
      };
    case "disconnecting":
      return {
        title: "Disconnecting glasses",
        detail,
        bannerClass: failure ? "status-banner status-danger" : "status-banner status-info",
        controlsEnabled: false,
        reconnectEnabled: false,
      };
    case "charging":
      return {
        title: "Glasses charging",
        detail,
        bannerClass: failure ? "status-banner status-danger" : "status-banner status-info",
        controlsEnabled: false,
        reconnectEnabled: false,
      };
    default:
      return {
        title: "Glasses disconnected",
        detail,
        bannerClass: failure
          ? "status-banner status-danger"
          : "status-banner status-warning",
        controlsEnabled: false,
        reconnectEnabled: true,
      };
  }
}

export type ScreenActionPresentation = {
  stateLabel: string;
  actionLabel: string;
  actionHint: string;
};

export function screenActionPresentation(
  screenOn: boolean,
  controlsEnabled = true,
): ScreenActionPresentation {
  if (!controlsEnabled) {
    return {
      stateLabel: "Display state unavailable",
      actionLabel: "Screen unavailable",
      actionHint: "Connect the glasses before controlling the display.",
    };
  }
  return screenOn
    ? {
        stateLabel: "Display is awake",
        actionLabel: "Blank screen",
        actionHint: "Turns off the glasses display without disconnecting Bluetooth.",
      }
    : {
        stateLabel: "Display is blank",
        actionLabel: "Wake screen",
        actionHint: "Wakes the glasses display and restores the current window.",
      };
}
