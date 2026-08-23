import { imageFromAsciiArt } from "../../graphics/image";
import { TranscribeLayer } from "./transcribe";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";

export const TRANSCRIBE_WINDOW_ID = "transcribe";
export const TRANSCRIBE_SURFACE_ID = "window:transcribe";

const TRAY_ICON_ID = "transcribe";

// 16x18 microphone glyph for the top-bar tray.
const MIC_ICON = imageFromAsciiArt(
  [
    "     ####     ",
    "    ######    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "    #    #    ",
    "  # #    # #  ",
    "  # #    # #  ",
    "  #  ####  #  ",
    "   #      #   ",
    "    ######    ",
    "       #      ",
    "       #      ",
    "     ######   ",
  ],
  220,
);

export type TranscribeAppOptions = InProcessAppOptions & {
  /** Begin continuous mic capture (kept on while the window is open). */
  startContinuousVoiceCapture: () => number;
  stopContinuousVoiceCapture: (generation: number) => void;
};

/**
 * The Transcribe app: live speech-to-text in its own window. While open it
 * owns an isolated continuous mic generation and
 * shows a microphone tray icon in the top bar.
 */
export function createTranscribeAppWindow(options: TranscribeAppOptions): InProcessWindow {
  const startCapture = () => {
    const generation = options.startContinuousVoiceCapture();
    if (generation > 0) shell.setTrayIcon(TRAY_ICON_ID, MIC_ICON);
    return generation;
  };
  const stopCapture = (generation: number) => {
    options.stopContinuousVoiceCapture(generation);
    shell.setTrayIcon(TRAY_ICON_ID, null);
  };
  const layer = new TranscribeLayer({ startCapture, stopCapture });
  const app = createInProcessWindow({
    appId: "transcribe",
    windowId: TRANSCRIBE_WINDOW_ID,
    title: "Transcribe",
    iconLetter: "Tr",
    icon: "mic",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(layer),
    menuItems: () => [
      {
        label: layer.isPaused() ? "Resume captions" : "Pause captions",
        onSelect: (ctx) => {
          ctx.stack.pop();
          layer.togglePaused();
        },
      },
      {
        label: "Clear captions",
        onSelect: (ctx) => {
          ctx.stack.pop();
          layer.clear();
        },
      },
    ],
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onForegroundChanged: (foreground) => layer.onForegroundChanged(foreground),
    onScreenChanged: (on) => layer.onScreenChanged(on),
    onVoiceInputChanged: (active) => layer.onVoiceInputChanged(active),
    onClosed: () => {
      layer.onRemoved();
      options.onClosed();
    },
  });
  // Wire async state changes to this window's renderer, rather than the
  // controller action from which the window-specific actions were derived.
  layer.start(app.requestRender);
  layer.onScreenChanged(shell.isScreenOn());
  return app;
}
