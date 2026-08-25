import type { DynamicAppComponent } from "./dynamic-app";

/** The dynamic-app renderer always uses the bundled 12px small face. */
export const DYNAMIC_APP_SMALL_LINE_HEIGHT = 12;

/**
 * Vertical space available to components inside a 232px app viewport:
 * 232px host - 8px panel margins - 38px header - 17px footer.
 *
 * Keep this shared with the renderer so deck derivation can prove that every
 * generated component is reachable without adding a second scroll axis.
 */
export const DYNAMIC_APP_DECK_COMPONENT_BUDGET = 169;

export function dynamicAppComponentHeight(component: DynamicAppComponent, lineHeight: number): number {
  switch (component.type) {
    case "divider": return 10;
    case "progress": return lineHeight + 13;
    case "card": return lineHeight * 3 + 7;
    case "list": return Math.min(component.items.length, 4) * lineHeight + 5;
    case "confirmation": return lineHeight * 3 + 8;
    default: return lineHeight + 6;
  }
}
