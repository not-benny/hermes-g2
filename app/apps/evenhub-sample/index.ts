import type { AppDefinition } from "../app-definition";
import { createEvenHubSampleAppWindow, EVENHUB_SAMPLE_SURFACE_ID, EVENHUB_SAMPLE_WINDOW_ID } from "./evenhub-sample-app";

const evenHubSampleApp: AppDefinition = {
  appId: "evenhub-local-counter",
  title: "Local Counter",
  icon: "plus-one",
  launch: (ctx) => ctx.launchInProcessApp(
    EVENHUB_SAMPLE_WINDOW_ID,
    EVENHUB_SAMPLE_SURFACE_ID,
    createEvenHubSampleAppWindow,
  ),
};

export default evenHubSampleApp;
