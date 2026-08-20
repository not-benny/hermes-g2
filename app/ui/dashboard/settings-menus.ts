import { knownFolders } from "@nativescript/core";
import { getDefaultSmallFont } from "../../graphics/bdffont";
import type { GrayImage } from "../../graphics/image";
import { getDashboardLogo } from "../../graphics/logo";
import { wrapText } from "../../graphics/textwrap";
import {
  cancelLocalModelDownload,
  deleteLocalModel,
  LOCAL_MODEL,
  localModelState,
  onLocalModelStateChanged,
  startLocalModelDownload,
} from "../../native/llama";
import { TextViewerLayer } from "../../apps/files/text-viewer";
import type { LayerContext } from "../layers";
import { drawRightValueMenuItem, openModalMenu, type MenuItem } from "../menu";
import { shell } from "../shell/shell";
import {
  anthropicApiKeySetting,
  assistantAllowProactiveSetting,
  assistantBackendSetting,
  assistantBridgeHostSetting,
  assistantBridgePortSetting,
  assistantBridgeTokenSetting,
  assistantModelSetting,
  assistantSkipConfirmationSetting,
  batteryDisplayModeSetting,
  brightnessSetting,
  elevenLabsApiKeySetting,
  mapboxApiKeySetting,
  openAiApiKeySetting,
  ringSensitivitySetting,
  roamApiTokenSetting,
  roamGraphNameSetting,
  sonioxApiKeySetting,
  enumSettingMenuItem,
  firmwareDebugFlagsSetting,
  lockScreenEnabledSetting,
  saveVoiceRecordingsSetting,
  suspendEvenHubWhenScreenOffSetting,
  terminalAutoReconnectSetting,
  terminalLaunchPresetsSetting,
  terminalWakeOnBellSetting,
  textSettingMenuItem,
  timeFormatSetting,
  toggleSettingMenuItem,
  uiFontSetting,
  notificationFontSizeSetting,
  beepsEnabledSetting,
  beepVolumeSetting,
  beepEventSettings,
  verticalPositionSetting,
  voiceProviderSetting,
  screenTimeoutSetting,
  wakeWordActionSetting,
} from "../dashboard-settings";
import { SettingsPanelLayer, type SettingsSection } from "./settings-panel";

/** The Settings app's master-detail panel (sections on the left, contents on the right). */
export function createSettingsPanelLayer(): SettingsPanelLayer {
  return new SettingsPanelLayer(settingsSections());
}

function settingsSections(): SettingsSection[] {
  return [
    {
      label: "Display",
      items: [
        // Auto (ambient sensor) or an exact level; pushed to the glasses by
        // the dashboard controller when changed and on each connect.
        enumSettingMenuItem(brightnessSetting),
        enumSettingMenuItem(screenTimeoutSetting, {
          onChange: () => {
            shell.noteUserActivity();
          },
        }),
        toggleSettingMenuItem(lockScreenEnabledSetting),
        // Where min-height windows (and the sidebar) sit vertically on the
        // screen; the dashboard controller repositions surfaces on change.
        enumSettingMenuItem(verticalPositionSetting),
        // Controls the top-bar battery indicators (icon vs percentage).
        enumSettingMenuItem(batteryDisplayModeSetting),
        // Controls the top-bar clock (24-hour vs 12-hour).
        enumSettingMenuItem(timeFormatSetting),
        // Selects the UI body typeface (Terminus vs proportional TerminusV).
        enumSettingMenuItem(uiFontSetting),
        // Text size for on-glass notifications (list, detail, new-notification popups).
        enumSettingMenuItem(notificationFontSizeSetting),
      ],
    },
    {
      label: "Input",
      items: [
        // Throttles ring/touchpad scrolling; lower levels tame a runaway swipe.
        enumSettingMenuItem(ringSensitivitySetting),
      ],
    },
    {
      label: "Sounds",
      items: [
        toggleSettingMenuItem(beepsEnabledSetting), // master
        enumSettingMenuItem(beepVolumeSetting),
        toggleSettingMenuItem(beepEventSettings.notification),
        toggleSettingMenuItem(beepEventSettings.assistantReply),
        toggleSettingMenuItem(beepEventSettings.assistantError),
        toggleSettingMenuItem(beepEventSettings.assistantTool),
        toggleSettingMenuItem(beepEventSettings.timer),
        toggleSettingMenuItem(beepEventSettings.connect),
        toggleSettingMenuItem(beepEventSettings.disconnect),
      ],
    },
    {
      label: "Voice",
      items: [
        enumSettingMenuItem(wakeWordActionSetting),
        enumSettingMenuItem(voiceProviderSetting),
      ],
    },
    {
      label: "Assistant",
      items: [
        // On-phone LLM loop vs the user's own agent via the bridge plugin.
        enumSettingMenuItem(assistantBackendSetting),
        enumSettingMenuItem(assistantModelSetting),
        localModelMenuItem(),
        // When on, a wakeword utterance goes straight to the assistant with no
        // Send/Type menu step.
        toggleSettingMenuItem(assistantSkipConfirmationSetting),
        textSettingMenuItem(assistantBridgeHostSetting),
        textSettingMenuItem(assistantBridgePortSetting),
        textSettingMenuItem(assistantBridgeTokenSetting),
        toggleSettingMenuItem(assistantAllowProactiveSetting),
      ],
    },
    {
      label: "API Keys",
      items: [
        textSettingMenuItem(elevenLabsApiKeySetting),
        textSettingMenuItem(openAiApiKeySetting),
        textSettingMenuItem(sonioxApiKeySetting),
        textSettingMenuItem(anthropicApiKeySetting),
        textSettingMenuItem(mapboxApiKeySetting),
      ],
    },
    {
      label: "Terminal",
      // Connections (g2mirror:// strings) are managed inside the Terminal
      // app's Manage Connections section, not here.
      items: [
        textSettingMenuItem(terminalLaunchPresetsSetting),
        toggleSettingMenuItem(terminalAutoReconnectSetting),
        toggleSettingMenuItem(terminalWakeOnBellSetting),
      ],
    },
    {
      label: "Roam",
      items: [
        textSettingMenuItem(roamGraphNameSetting),
        textSettingMenuItem(roamApiTokenSetting),
      ],
    },
    {
      label: "Developer",
      items: [
        toggleSettingMenuItem(saveVoiceRecordingsSetting),
        toggleSettingMenuItem(firmwareDebugFlagsSetting),
        toggleSettingMenuItem(suspendEvenHubWhenScreenOffSetting),
      ],
    },
    {
      label: "About",
      // The version/license blurb (renderDetail) draws above the bundled
      // project docs, in both the preview and the focused states.
      items: [
        bundledDocMenuItem("README.md", "README"),
        bundledDocMenuItem("LICENSE", "License"),
        bundledDocMenuItem("PRIVACY", "Privacy policy"),
        bundledDocMenuItem("ACKNOWLEDGEMENTS.md", "Acknowledgements"),
      ],
      renderDetail: renderAbout,
    },
    {
      label: "Quit",
      items: [
        {
          label: "Disconnect from glasses",
          description: "Close the Bluetooth connection to the glasses and return them to standby.",
          onSelect: async (ctx) => {
            ctx.stack.clearToBase();
            await ctx.actions.disconnect();
          },
        },
      ],
    },
  ];
}

const LOCAL_MODEL_GB = `${(LOCAL_MODEL.sizeBytes / 1e9).toFixed(1)}GB`;

// While a download is running, re-render on progress updates so the row's
// percentage stays live; the watch tears itself down when the download ends.
let localModelRenderUnsub: (() => void) | null = null;

function watchLocalModelDownload(ctx: LayerContext): void {
  localModelRenderUnsub?.();
  localModelRenderUnsub = onLocalModelStateChanged((state) => {
    ctx.actions.requestRender();
    if (state.status !== "downloading") {
      localModelRenderUnsub?.();
      localModelRenderUnsub = null;
    }
  });
}

function localModelStatusText(): string {
  const state = localModelState();
  if (state.status === "ready") return "downloaded";
  if (state.status === "downloading") {
    const pct = state.totalBytes > 0 ? Math.floor((state.bytesDownloaded / state.totalBytes) * 100) : 0;
    return `${pct}% of ${LOCAL_MODEL_GB}`;
  }
  return "not downloaded";
}

/** Download/cancel/delete management for the on-phone assistant model. */
function localModelMenuItem(): MenuItem {
  return {
    label: "On-phone model",
    description:
      `${LOCAL_MODEL.label} (${LOCAL_MODEL_GB} download over Wi-Fi recommended). ` +
      "Answers assistant queries on the phone itself, with no API key or cloud service. " +
      "Slower and simpler than the cloud models, but free and private. " +
      "Used automatically when no API key is set. An interrupted download resumes where it left off.",
    onSelect: (ctx) => {
      const state = localModelState();
      const action: MenuItem =
        state.status === "downloading"
          ? {
              label: "Cancel download",
              onSelect: (innerCtx) => {
                cancelLocalModelDownload();
                innerCtx.stack.pop();
              },
            }
          : state.status === "ready"
            ? {
                label: "Delete model",
                onSelect: (innerCtx) => {
                  deleteLocalModel();
                  innerCtx.stack.pop();
                },
              }
            : {
                label: `Download (${LOCAL_MODEL_GB})`,
                onSelect: (innerCtx) => {
                  startLocalModelDownload();
                  watchLocalModelDownload(innerCtx);
                  innerCtx.stack.pop();
                },
              };
      openModalMenu(ctx, "On-phone model", [action], 0);
    },
    render: ({ image, x, y, width }) => {
      drawRightValueMenuItem(image, getDefaultSmallFont(), x, y, width, "On-phone model", localModelStatusText());
    },
  };
}

/** A row that opens one of the project docs (copied into the bundle under
 * about/ by webpack.config.js) in the paged text viewer. */
function bundledDocMenuItem(fileName: string, label: string): MenuItem {
  return {
    label,
    onSelect: (ctx) => {
      ctx.stack.push(new TextViewerLayer(readBundledDoc(fileName), label));
    },
  };
}

function readBundledDoc(fileName: string): string {
  try {
    const text = knownFolders.currentApp().getFile(`about/${fileName}`).readTextSync();
    return text || `(${fileName} is missing from this build)`;
  } catch {
    return `(${fileName} is missing from this build)`;
  }
}

function renderAbout(args: { image: GrayImage; x: number; y: number; width: number }): number {
  const { image, x, y, width } = args;
  const font = getDefaultSmallFont();
  const logo = getDashboardLogo();
  if (logo) {
    image.bitBlt(logo, x, y + 4, { transparentZero: true });
  }
  const textX = logo ? x + logo.width + 12 : x;
  image.drawText(font, textX, y + 8, "Hermes G2", 220);
  image.drawText(font, textX, y + 24, "v1.0.0", 170);
  const blurb = "Based on the work of James Babcock and contributors. GNU General Public License, version 3.";
  const blurbY = y + Math.max(64, logo ? logo.height + 12 : 0);
  const blurbLines = wrapText(font, blurb, width);
  for (let i = 0; i < blurbLines.length; i++) {
    image.drawText(font, x, blurbY + i * font.lineHeight, blurbLines[i]!, 170);
  }
  return blurbY - y + blurbLines.length * font.lineHeight + 10;
}
