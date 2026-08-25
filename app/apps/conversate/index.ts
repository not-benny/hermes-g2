import { type AppDefinition } from "../app-definition";
import {
  CONVERSATE_SURFACE_ID,
  CONVERSATE_WINDOW_ID,
  createConversateAppWindow,
} from "./conversate-app";

const conversateApp: AppDefinition = {
  appId: "conversate",
  title: "Conversate",
  icon: "message-square",
  launch: (ctx) =>
    ctx.launchInProcessApp(CONVERSATE_WINDOW_ID, CONVERSATE_SURFACE_ID, (options) =>
      createConversateAppWindow({
        ...options,
        startContinuousVoiceCapture: (provider) => options.actions.startContinuousVoiceCapture(provider),
        finishContinuousVoiceCapture: (generation) => options.actions.finishContinuousVoiceCapture(generation),
        stopContinuousVoiceCapture: (generation) => void options.actions.stopContinuousVoiceCapture(generation),
      }),
    ),
};

export default conversateApp;
