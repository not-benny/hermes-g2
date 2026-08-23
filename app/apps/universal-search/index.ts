import { type AppDefinition } from "../app-definition";
import {
  createUniversalSearchWindow,
  UNIVERSAL_SEARCH_SURFACE_ID,
  UNIVERSAL_SEARCH_WINDOW_ID,
} from "./universal-search-app";

const universalSearchApp: AppDefinition = {
  appId: "universal-search",
  title: "Search",
  icon: "search",
  launch: (ctx) => ctx.launchInProcessApp(
    UNIVERSAL_SEARCH_WINDOW_ID,
    UNIVERSAL_SEARCH_SURFACE_ID,
    (options) => createUniversalSearchWindow(ctx, options),
  ),
};

export default universalSearchApp;
