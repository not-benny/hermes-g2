import type { DynamicAppComponent, DynamicAppState } from "../../assistant/dynamic-app";
import type { RenderViewState } from "../../assistant/render-view";
import { BUNDLED_COUNTER_PACKAGE, type EvenHubView } from "./protocol";
import { EvenHubCompatRuntime } from "./runtime";

export type SampleStorage = {
  read: (namespace: string) => string | null;
  write: (namespace: string, document: string) => void;
  remove: (namespace: string) => void;
};

/** Reviewed sample logic exercising the same bounded host boundary as future packages. */
export class EvenHubCounterController {
  private readonly runtime: EvenHubCompatRuntime;
  private readonly generation: number;
  private view: EvenHubView = BUNDLED_COUNTER_PACKAGE.initialView;
  private selectedAction = 0;
  private count = 0;
  private status = "Ready";
  private requestSequence = 0;

  constructor(storage: SampleStorage, private readonly onChanged: () => void, initialScreenOn = true) {
    this.runtime = new EvenHubCompatRuntime({
      render: (view) => {
        this.view = view;
        this.selectedAction = Math.min(this.selectedAction, Math.max(0, view.actions.length - 1));
        this.onChanged();
      },
      readStorage: storage.read,
      writeStorage: storage.write,
      removeStorage: storage.remove,
      onEvent: () => this.processEvents(),
    });
    this.generation = this.runtime.open(
      BUNDLED_COUNTER_PACKAGE,
      new Set(["display", "input", "storage", "timers"]),
      { foreground: true, screenOn: initialScreenOn },
    );
    const stored = this.runtime.dispatch(this.request("storage.get", { key: "count" }));
    if (stored.ok && stored.value !== null && /^\d{1,4}$/.test(stored.value ?? "")) this.count = Number(stored.value);
    this.show();
  }

  state(): RenderViewState {
    return {
      viewId: `evenhub-local-${this.generation}`,
      revision: this.requestSequence,
      ownerKey: `evenhub:${BUNDLED_COUNTER_PACKAGE.manifest.packageId}:${this.generation}`,
      title: this.view.title,
      blocks: this.view.blocks.map((block) => ({ ...block })),
      actions: this.view.actions.map((action) => ({ ...action })),
      selectedAction: this.selectedAction,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    };
  }

  /**
   * Project the reviewed local package onto the same deterministic component
   * compositor used by dynamic dashboards. Ownership and lifecycle stay local:
   * the counter remains available offline, has no assistant turn/TTL, and keeps
   * its namespaced durable state behind the EvenHub compatibility boundary.
   */
  dashboardState(): DynamicAppState {
    const state = this.state();
    const components: DynamicAppComponent[] = state.blocks.map((block, index) => {
      const id = `counter-block-${index}`;
      if (block.type === "text") {
        return block.emphasis === "strong"
          ? { id, type: "heading", text: block.text }
          : { id, type: "text", text: block.text };
      }
      if (block.type === "key_value") {
        return { id, type: "status", label: block.label, value: block.value, tone: "neutral" };
      }
      if (block.type === "progress") {
        return { id, type: "progress", label: block.label, value: block.value };
      }
      return { id, type: "divider" };
    });
    if (state.actions.length) components.push({ id: "counter-actions-divider", type: "divider" });
    for (const action of state.actions) {
      components.push({
        id: `counter-action-${action.id}`,
        type: "button",
        label: action.label,
        action_handle: `local_counter_${action.id}_action`,
      });
    }
    return {
      viewId: state.viewId,
      revision: state.revision,
      ownerKey: state.ownerKey,
      title: state.title,
      state: "ready",
      privacy: "private",
      components,
      selectedAction: state.selectedAction,
      scrollOffset: 0,
      expiresAtMs: state.expiresAtMs,
    };
  }

  handleInput(input: "click" | "scroll-up" | "scroll-down"): boolean {
    if (input === "scroll-up") {
      this.selectedAction = (this.selectedAction + this.view.actions.length - 1) % this.view.actions.length;
    } else if (input === "scroll-down") {
      this.selectedAction = (this.selectedAction + 1) % this.view.actions.length;
    }
    return this.runtime.handleInput(this.generation, input);
  }

  setForeground(foreground: boolean): void {
    if (!this.runtime.setForeground(this.generation, foreground)) return;
    if (!foreground && this.status === "One second timer armed") this.status = "Timer cancelled in background";
    if (foreground) this.show();
  }

  setScreenOn(on: boolean): void {
    if (!this.runtime.setScreenOn(this.generation, on)) return;
    if (!on && this.status === "One second timer armed") this.status = "Timer cancelled while screen was off";
    if (on) this.show();
  }

  clearStorage(): void {
    if (!this.runtime.clearStorage(this.generation)) return;
    this.count = 0;
    this.status = "Local data cleared";
    this.show();
  }

  close(): void {
    this.runtime.close(this.generation);
  }

  private processEvents(): void {
    for (const event of this.runtime.drainEvents(this.generation)) {
      if (event.type === "timer.fired") {
        this.status = "Timer complete";
        this.show();
      } else if (event.input === "click") {
        const action = this.view.actions[this.selectedAction]?.id;
        if (action === "increment") {
          const candidate = Math.min(9999, this.count + 1);
          const result = this.runtime.dispatch(this.request("storage.set", { key: "count", value: String(candidate) }));
          if (result.ok) {
            this.count = candidate;
            this.status = "Count saved locally";
          } else this.status = "Save failed";
          this.show();
        } else if (action === "reset") {
          const result = this.runtime.dispatch(this.request("storage.set", { key: "count", value: "0" }));
          if (result.ok) {
            this.count = 0;
            this.status = "Counter reset";
          } else this.status = "Save failed";
          this.show();
        } else if (action === "timer") {
          const result = this.runtime.dispatch(this.request("timer.set", { timerId: "sample", delayMs: 1000 }));
          this.status = result.ok ? "One second timer armed" : "Timer unavailable";
          this.show();
        }
      }
    }
  }

  private show(): void {
    this.runtime.dispatch(this.request("display.set", {
      view: {
        title: "Local Counter",
        blocks: [
          { type: "text", text: "Bundled compatibility sample", emphasis: "normal" },
          { type: "key_value", label: "Count", value: String(this.count) },
          { type: "key_value", label: "Status", value: this.status },
        ],
        actions: BUNDLED_COUNTER_PACKAGE.initialView.actions,
      },
    }));
  }

  private request(method: string, params: Record<string, unknown>): unknown {
    const sequence = ++this.requestSequence;
    return { version: 1, generation: this.generation, sequence, requestId: `sample-${sequence}`, method, params };
  }
}
