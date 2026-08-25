import { type AppDefinition } from "../app-definition";
import { CLOCK_SURFACE_ID, CLOCK_WINDOW_ID, createClockWindow } from "./clock-app";

const clockApp: AppDefinition = {
  appId: "clock",
  title: "Clock",
  icon: "clock",
  launch: (ctx) => ctx.launchInProcessApp(
    CLOCK_WINDOW_ID,
    CLOCK_SURFACE_ID,
    createClockWindow,
  ),
};

export default clockApp;
