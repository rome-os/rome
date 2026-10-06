import type { AgentInputState, InputStatusEvent } from "@rome-os/app-runtime";
import type { AgentTurnHandle, AgentTurnInput, SendTurnOptions } from "./agent-session.js";
import type { ModelSession } from "./agent-runner.js";

export interface SubmitInputOptions extends SendTurnOptions {
  /** Called once per actual run, including a late input's follow-up run. */
  onTurn(handle: AgentTurnHandle): void;
  onInputStatus?(status: InputStatusEvent): Promise<void> | void;
}

export interface AgentInputReceipt {
  inputId: string;
  turnId: string;
  disposition: "started" | "queued" | "steering";
}

interface Entry {
  input: AgentTurnInput & { inputId: string };
  options: SubmitInputOptions;
  state: AgentInputState;
  turnId: string;
  writes: Promise<void>;
}

interface ActiveInputTurn {
  handle: AgentTurnHandle;
  first: Entry;
  ready: boolean;
  pending?: Entry;
  sealed: boolean;
  dispatch?: Promise<void>;
}

/** Chat's input lane is separate from the one-result-per-caller task FIFO. */
export class AgentInputQueue {
  private active?: ActiveInputTurn;
  private queued: Entry[] = [];
  private entries = new Map<string, Entry>();
  private closed = false;

  constructor(
    private readonly startTurn: (
      input: AgentTurnInput,
      options: SendTurnOptions,
    ) => AgentTurnHandle,
    private readonly provider: () => Pick<ModelSession, "steerUserInput">,
    private readonly reportError: (error: unknown) => void,
  ) {}

  get busy(): boolean {
    return !!this.active || this.queued.length > 0;
  }

  submit(
    input: AgentTurnInput & { inputId: string },
    options: SubmitInputOptions,
  ): AgentInputReceipt {
    if (this.closed) throw new Error("Input queue is closed");
    const existing = this.entries.get(input.inputId);
    if (existing) return { inputId: input.inputId, turnId: existing.turnId, disposition: "queued" };
    const entry: Entry = { input, options, state: "queued", turnId: "", writes: Promise.resolve() };
    this.entries.set(input.inputId, entry);
    if (!this.active) {
      this.start(entry);
      return { inputId: input.inputId, turnId: entry.turnId, disposition: "started" };
    }
    entry.turnId = this.active.handle.turnId;
    this.queued.push(entry);
    void this.update(entry, "queued").catch(this.reportError);
    const disposition = this.active.ready && !this.active.sealed ? "steering" : "queued";
    this.flush();
    return { inputId: input.inputId, turnId: entry.turnId, disposition };
  }

  private start(entry: Entry): void {
    const handle = this.startTurn(entry.input, entry.options);
    entry.turnId = handle.turnId;
    this.active = { handle, first: entry, ready: false, sealed: false };
    void this.update(entry, "queued").catch(this.reportError);
    entry.options.onTurn(handle);
  }

  async beforeSend(turnId: string): Promise<void> {
    const active = this.active;
    if (active?.handle.turnId === turnId) await this.update(active.first, "submitted");
  }

  ready(turnId: string): void {
    if (this.active?.handle.turnId !== turnId) return;
    this.active.ready = true;
    this.flush();
  }

  async observe(event: InputStatusEvent, turnId: string): Promise<void> {
    const entry = this.entries.get(event.inputId);
    if (!entry) return;
    entry.turnId = turnId;
    await this.update(entry, event.state);
    const active = this.active;
    if (active?.handle.turnId !== turnId) return;
    if (event.state === "queued") {
      // The provider retained this input across its native turn boundary.
      // sendUserInput(inputId) will adopt it, never enqueue a second copy.
      active.sealed = true;
      if (!this.queued.includes(entry)) this.queued.unshift(entry);
      if (active.pending === entry) active.pending = undefined;
    } else if (event.state === "consumed" && active.pending === entry) {
      active.pending = undefined;
      this.flush();
    }
  }

  private flush(): void {
    const active = this.active;
    const provider = this.provider();
    if (!active?.ready || active.pending || active.sealed || !provider.steerUserInput) return;
    const entry = this.queued.shift();
    if (!entry) return;
    active.pending = entry;
    entry.turnId = active.handle.turnId;
    active.dispatch = (async () => {
      try {
        // Persist the dispatch boundary before a provider can observe input.
        await this.update(entry, "submitted");
        if (this.active !== active || active.sealed) {
          if (entry.state !== "cancelled") {
            this.queued.unshift(entry);
            await this.update(entry, "queued");
            this.startNext();
          }
          return;
        }
        const result = await provider.steerUserInput!({
          inputId: entry.input.inputId,
          text: entry.input.prompt,
          images: entry.input.images,
          reasoningEffort: entry.input.reasoningEffort,
        });
        if (entry.state === "consumed" || entry.state === "cancelled" || entry.state === "queued")
          return;
        if (result === "deferred") {
          active.sealed = true;
          active.pending = undefined;
          this.queued.unshift(entry);
          await this.update(entry, "queued");
          if (this.active !== active && !this.active && !this.closed) this.startNext();
        } else {
          await this.update(entry, "accepted");
        }
      } catch (error) {
        // A timeout may have happened after acceptance. Never auto-replay it.
        if (entry.state !== "consumed" && entry.state !== "cancelled")
          await this.update(entry, "unknown");
        this.reportError(error);
      }
    })().catch(this.reportError);
  }

  async seal(turnId: string): Promise<void> {
    const active = this.active;
    if (active?.handle.turnId !== turnId) return;
    active.sealed = true;
    await active.dispatch;
  }

  finish(turnId: string): void {
    const active = this.active;
    if (active?.handle.turnId !== turnId) return;
    active.sealed = true;
    this.active = undefined;
    for (const entry of [active.first, active.pending]) {
      if (entry && (entry.state === "accepted" || entry.state === "submitted")) {
        void this.update(entry, "unknown").catch(this.reportError);
      }
    }
    if (active.first.state === "queued" && !this.queued.includes(active.first)) {
      void this.update(active.first, "failed").catch(this.reportError);
    }
    this.startNext();
    // Retain a bounded deduplication window; durable identities live in the repository.
    if (this.entries.size > 256) {
      for (const [id, entry] of this.entries) {
        if (["consumed", "unknown", "failed", "cancelled"].includes(entry.state))
          this.entries.delete(id);
        if (this.entries.size <= 256) break;
      }
    }
  }

  private startNext(): void {
    if (this.active || this.closed) return;
    const next = this.queued.shift();
    if (next) this.start(next);
  }

  cancel(turnId: string): void {
    const active = this.active;
    if (active?.handle.turnId !== turnId) return;
    active.sealed = true;
    for (const entry of [active.pending, ...this.queued]) {
      if (entry) void this.update(entry, "cancelled").catch(this.reportError);
    }
    this.queued = [];
  }

  close(): void {
    this.closed = true;
    if (this.active) this.cancel(this.active.handle.turnId);
  }

  private update(entry: Entry, state: AgentInputState): Promise<void> {
    entry.state = state;
    const event: InputStatusEvent = {
      type: "input_status",
      inputId: entry.input.inputId,
      turnId: entry.turnId,
      state,
    };
    entry.writes = entry.writes.then(() => entry.options.onInputStatus?.(event));
    return entry.writes;
  }
}
