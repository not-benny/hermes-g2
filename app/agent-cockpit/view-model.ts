import type { CockpitInteraction, CockpitSession, CockpitSnapshot } from "./protocol";

export type CockpitScreenMode =
  | "offline"
  | "active"
  | "inbox"
  | "detail"
  | "question"
  | "answer_review"
  | "permission_review"
  | "permission_decision"
  | "steer_review"
  | "submitting";

export type CockpitScreen = {
  mode: CockpitScreenMode;
  title: string;
  body: string[];
  rows: Array<{ label: string; tone?: "normal" | "attention" | "muted" }>;
  selected: number;
  footer: string;
};

export type CockpitActions = {
  answer: (sessionId: string, generation: number, requestId: string, choiceId: string) => boolean;
  decidePermission: (sessionId: string, generation: number, requestId: string, decision: "deny" | "allow_once") => boolean;
  steer: (sessionId: string, generation: number, text: string) => boolean;
  interrupt: (sessionId: string, generation: number) => boolean;
};

type SelectedRun = { sessionId: string; generation: number };
type SelectedRequest = SelectedRun & { requestId: string };

const TERMINAL = new Set(["completed", "failed", "interrupted"]);

/** Pure navigation and review state for the native cockpit. Remote data never defines controls. */
export class CockpitViewModel {
  private state: CockpitSnapshot = { synchronized: false, sequence: 0, sessions: [], lastReceipt: null };
  private mode: CockpitScreenMode = "offline";
  private selected = 0;
  private run: SelectedRun | null = null;
  private request: SelectedRequest | null = null;
  private selectedChoiceId: string | null = null;
  private steerText = "";

  constructor(private readonly actions: CockpitActions) {}

  update(state: CockpitSnapshot): void {
    const priorSequence = this.state.sequence;
    this.state = state;
    if (!state.synchronized) {
      this.mode = "offline";
      this.selected = 0;
      return;
    }
    if (this.mode === "offline") {
      this.mode = "active";
      this.selected = 0;
    } else if (this.mode === "submitting" && state.sequence > priorSequence && state.lastReceipt) {
      // A socket write is not success. Leave the input-locked submitting view
      // only after an authoritative sequenced receipt has been applied.
      this.mode = this.currentRun() ? "detail" : "active";
      this.selected = 0;
    }
  }

  screen(): CockpitScreen {
    if (!this.state.synchronized || this.mode === "offline") {
      return { mode: "offline", title: "HERMES", body: ["Cockpit offline", "Actions are disabled until resynchronized."],
        rows: [], selected: 0, footer: "double-click back" };
    }
    if (this.mode === "active") return this.activeScreen();
    if (this.mode === "inbox") return this.inboxScreen();
    if (this.mode === "detail") return this.detailScreen();
    if (this.mode === "question") return this.questionScreen();
    if (this.mode === "answer_review") return this.answerReviewScreen();
    if (this.mode === "permission_review") return this.permissionReviewScreen();
    if (this.mode === "permission_decision") return this.permissionDecisionScreen();
    if (this.mode === "steer_review") {
      return { mode: this.mode, title: "REVIEW STEERING", body: [this.steerText],
        rows: [{ label: "Send steering" }, { label: "Discard", tone: "muted" }], selected: this.selected,
        footer: "click confirm · double-click discard" };
    }
    return { mode: "submitting", title: "SENDING", body: ["Waiting for authoritative receipt…"],
      rows: [], selected: 0, footer: "No repeated input" };
  }

  scroll(delta: number): void {
    const count = this.screen().rows.length;
    if (count === 0) return;
    this.selected = Math.max(0, Math.min(count - 1, this.selected + Math.sign(delta)));
  }

  click(): void {
    if (!this.state.synchronized || this.mode === "submitting") return;
    if (this.mode === "active") return this.clickActive();
    if (this.mode === "inbox") return this.clickInbox();
    if (this.mode === "question") {
      const interaction = this.currentInteraction();
      if (interaction?.kind !== "question") return;
      this.selectedChoiceId = interaction.choices[this.selected]?.id ?? null;
      if (!this.selectedChoiceId) return;
      this.mode = "answer_review";
      this.selected = 0;
      return;
    }
    if (this.mode === "answer_review") return this.submitAnswer();
    if (this.mode === "permission_review") {
      if (this.currentInteraction()?.kind !== "permission") return;
      this.mode = "permission_decision";
      this.selected = 0;
      return;
    }
    if (this.mode === "permission_decision") return this.submitPermission();
    if (this.mode === "steer_review") {
      if (this.selected === 1) {
        this.steerText = "";
        this.mode = "detail";
        this.selected = 0;
        return;
      }
      const session = this.currentRun();
      if (session && this.actions.steer(session.session_id, this.run!.generation, this.steerText)) {
        this.mode = "submitting";
        this.selected = 0;
      }
    }
  }

  back(): void {
    if (this.mode === "active" || this.mode === "offline") return;
    if (["question", "permission_review"].includes(this.mode)) {
      this.mode = "inbox";
    } else if (["answer_review", "permission_decision"].includes(this.mode)) {
      this.mode = this.currentInteraction()?.kind === "question" ? "question" : "permission_review";
    } else if (this.mode === "inbox") {
      this.mode = "active";
    } else {
      this.mode = "detail";
    }
    this.selected = 0;
  }

  beginSteer(): boolean {
    const session = this.currentRun();
    if (!session || session.state !== "running") return false;
    this.steerText = "";
    return true;
  }

  reviewSteer(text: string): boolean {
    const session = this.currentRun();
    if (!session || session.state !== "running" || !text.trim()) return false;
    this.steerText = text.trim().slice(0, 500);
    this.mode = "steer_review";
    this.selected = 0;
    return true;
  }

  interruptCurrent(): boolean {
    const session = this.currentRun();
    if (!session || !["running", "waiting_human"].includes(session.state)) return false;
    const sent = this.actions.interrupt(session.session_id, this.run!.generation);
    if (sent) {
      this.mode = "submitting";
      this.selected = 0;
    }
    return sent;
  }

  private activeScreen(): CockpitScreen {
    const sorted = this.sortedSessions();
    const pending = sorted.reduce((sum, session) => sum + session.pending.length, 0);
    const rows: CockpitScreen["rows"] = [];
    if (pending) rows.push({ label: `Needs you (${pending})`, tone: "attention" });
    rows.push(...sorted.map((session) => ({ label: session.title, tone: session.pending.length ? "attention" as const : "normal" as const })));
    this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
    return { mode: "active", title: "HERMES", body: [], rows, selected: this.selected,
      footer: "scroll · click open · double-click back" };
  }

  private inboxScreen(): CockpitScreen {
    const pending = this.pendingItems();
    this.selected = Math.min(this.selected, Math.max(0, pending.length - 1));
    return { mode: "inbox", title: `NEEDS YOU ${pending.length}`, body: [],
      rows: pending.map(({ session, request }) => ({
        label: `${request.kind === "permission" ? "!" : "?"} ${request.title} · ${session.title}`,
        tone: "attention",
      })), selected: this.selected, footer: "click review · double-click back" };
  }

  private detailScreen(): CockpitScreen {
    const session = this.currentRun();
    if (!session) return { mode: "detail", title: "RUN RETIRED", body: ["This exact run generation is no longer current."],
      rows: [], selected: 0, footer: "double-click back" };
    const body = session.timeline.slice(-8).map((row) => `${row.kind.toUpperCase()} ${row.status === "running" ? "…" : row.status === "failed" ? "×" : "✓"} ${row.text}`);
    if (session.summary) body.push(`${session.state.toUpperCase()} ${session.summary}`);
    return { mode: "detail", title: `${session.title} · ${session.state.toUpperCase()}`, body,
      rows: session.pending.map((item) => ({ label: `${item.kind === "permission" ? "!" : "?"} ${item.title}`, tone: "attention" })),
      selected: 0, footer: TERMINAL.has(session.state) ? "double-click back" : "voice steer · double-click interrupt" };
  }

  private questionScreen(): CockpitScreen {
    const request = this.currentInteraction();
    if (request?.kind !== "question") return this.retiredRequestScreen("question");
    this.selected = Math.min(this.selected, request.choices.length - 1);
    return { mode: "question", title: "QUESTION", body: [request.title],
      rows: request.choices.map((choice) => ({ label: choice.label })), selected: this.selected,
      footer: "click review · double-click back" };
  }

  private answerReviewScreen(): CockpitScreen {
    const request = this.currentInteraction();
    const choice = request?.kind === "question" ? request.choices.find((item) => item.id === this.selectedChoiceId) : null;
    if (!choice || request?.kind !== "question") return this.retiredRequestScreen("answer_review");
    return { mode: "answer_review", title: "REVIEW ANSWER", body: [request.title, choice.label],
      rows: [{ label: "Send answer" }], selected: 0, footer: "click send · double-click change" };
  }

  private permissionReviewScreen(): CockpitScreen {
    const request = this.currentInteraction();
    if (request?.kind !== "permission") return this.retiredRequestScreen("permission_review");
    return { mode: "permission_review", title: "APPROVAL REVIEW", body: [
      `Action: ${request.action}`, `Target: ${request.target}`, `Effect: ${request.effect}`,
    ], rows: [{ label: "Continue to decision" }], selected: 0, footer: "click continue · double-click back" };
  }

  private permissionDecisionScreen(): CockpitScreen {
    const request = this.currentInteraction();
    if (request?.kind !== "permission") return this.retiredRequestScreen("permission_decision");
    const rows: CockpitScreen["rows"] = [{ label: "Deny", tone: "attention" }];
    if (request.choices.includes("allow_once")) rows.push({ label: "Approve once" });
    this.selected = Math.min(this.selected, rows.length - 1);
    return { mode: "permission_decision", title: "EXACT REQUEST", body: ["Approve this request once only?"],
      rows, selected: this.selected,
      footer: "deny selected by default · click confirm" };
  }

  private retiredRequestScreen(mode: CockpitScreenMode): CockpitScreen {
    return { mode, title: "REQUEST RETIRED", body: ["Answered elsewhere, expired, or replaced."], rows: [], selected: 0,
      footer: "double-click back" };
  }

  private clickActive(): void {
    const sorted = this.sortedSessions();
    const hasInbox = sorted.some((session) => session.pending.length > 0);
    if (hasInbox && this.selected === 0) {
      this.mode = "inbox";
      this.selected = 0;
      return;
    }
    const session = sorted[this.selected - (hasInbox ? 1 : 0)];
    if (!session) return;
    this.run = { sessionId: session.session_id, generation: session.generation };
    this.mode = "detail";
    this.selected = 0;
  }

  private clickInbox(): void {
    const item = this.pendingItems()[this.selected];
    if (!item) return;
    this.run = { sessionId: item.session.session_id, generation: item.session.generation };
    this.request = { ...this.run, requestId: item.request.request_id };
    this.mode = item.request.kind === "question" ? "question" : "permission_review";
    this.selected = 0;
  }

  private submitAnswer(): void {
    const request = this.currentInteraction();
    if (request?.kind !== "question" || !this.selectedChoiceId || !this.request) return;
    if (this.actions.answer(this.request.sessionId, this.request.generation, request.request_id, this.selectedChoiceId)) {
      this.mode = "submitting";
      this.selected = 0;
    }
  }

  private submitPermission(): void {
    const request = this.currentInteraction();
    if (request?.kind !== "permission" || !this.request) return;
    const decision = this.selected === 0 ? "deny" : "allow_once";
    if (this.actions.decidePermission(this.request.sessionId, this.request.generation, request.request_id, decision)) {
      this.mode = "submitting";
      this.selected = 0;
    }
  }

  private sortedSessions(): CockpitSession[] {
    return [...this.state.sessions].sort((left, right) =>
      Number(right.pending.length > 0) - Number(left.pending.length > 0) || right.updated_at_ms - left.updated_at_ms);
  }

  private pendingItems(): Array<{ session: CockpitSession; request: CockpitInteraction }> {
    return this.sortedSessions().flatMap((session) => session.pending.map((request) => ({ session, request })));
  }

  private currentRun(): CockpitSession | null {
    if (!this.state.synchronized || !this.run) return null;
    return this.state.sessions.find((session) => session.session_id === this.run!.sessionId && session.generation === this.run!.generation) ?? null;
  }

  private currentInteraction(): CockpitInteraction | null {
    const session = this.currentRun();
    if (!session || !this.request || this.request.generation !== session.generation) return null;
    return session.pending.find((item) => item.request_id === this.request!.requestId) ?? null;
  }
}
