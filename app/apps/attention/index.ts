import { type AppDefinition } from "../app-definition";
import { ATTENTION_SURFACE_ID, ATTENTION_WINDOW_ID, createAttentionAppWindow } from "./attention-app";

const attentionApp: AppDefinition = {
  appId: "attention",
  title: "Attention",
  icon: "list-checks",
  launch: (ctx) => ctx.launchInProcessApp(ATTENTION_WINDOW_ID, ATTENTION_SURFACE_ID, createAttentionAppWindow),
};

export default attentionApp;
