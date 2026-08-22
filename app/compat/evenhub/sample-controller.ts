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

  constructor(storage: SampleStorage, private readonly onChanged: () => void) {
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
    if (foreground) this.show();
  }

  setScreenOn(on: boolean): void {
    if (!this.runtime.setScreenOn(this.generation, on)) return;
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
          this.count = Math.min(9999, this.count + 1);
          this.runtime.dispatch(this.request("storage.set", { key: "count", value: String(this.count) }));
          this.status = "Count saved locally";
          this.show();
        } else if (action === "reset") {
          this.count = 0;
          this.runtime.dispatch(this.request("storage.set", { key: "count", value: "0" }));
          this.status = "Counter reset";
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
    return { version: 1, generation: this.generation, requestId: `sample-${++this.requestSequence}`, method, params };
  }
}
