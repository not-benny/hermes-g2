import { type AppDefinition } from "../app-definition";
import { CAPTURES_SURFACE_ID, CAPTURES_WINDOW_ID, createCapturesWindow } from "./captures-app";
import { captureStore } from "../../captures/store";

const capturesApp: AppDefinition = {
  appId: "captures",
  title: "Capture Inbox",
  icon: "file-text",
  launch: (ctx) => ctx.launchInProcessApp(CAPTURES_WINDOW_ID, CAPTURES_SURFACE_ID, createCapturesWindow),
  openSharedText: (ctx, title, text) => {
    try {
      captureStore.create([title.trim(), text.trim()].filter(Boolean).join("\n"));
      void ctx.launchApp("captures");
    } catch {
      ctx.appendLog("shared text could not be saved to Captures");
    }
  },
};

export default capturesApp;
