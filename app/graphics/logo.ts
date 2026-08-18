import { GrayImage } from "./image";
import { loadPngAsGrayImage } from "./imagefile";

let cachedDashboardLogo: GrayImage | null | undefined;

export function getDashboardLogo(): GrayImage | null {
  if (cachedDashboardLogo !== undefined) {
    return cachedDashboardLogo;
  }
  try {
    cachedDashboardLogo = loadPngAsGrayImage("images/hermes-g2-logo-dashboard.png");
  } catch {
    cachedDashboardLogo = null;
  }
  return cachedDashboardLogo;
}
