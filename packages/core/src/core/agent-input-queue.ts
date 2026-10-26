import type { AgentInputState, InputStatusEvent } from "@rome-os/app-runtime";
import type { AgentTurnHandle, AgentTurnInput, SendTurnOptions } from "./agent-session.js";
import type { ModelSession } from "./agent-runner.js";

/**
 * How an input that arrives during a running turn is handled. `next` steers it
 * into that turn when the provider can, else queues it. `now` ends that turn
 * and starts a new one with it. Either starts a turn when none runs.
 */
export type InputPriority = "now" | "next";

/** The interrupt reason a `now` input ends the running turn with. */
export const SUPERSEDED_INTERRUPT_REASON = "superseded";

export interface SubmitInputOptions extends SendTurnOptions {
  /** Called once per actual run, including a late input's follow-up run. */
  onTurn(handle: AgentTurnHandle): void;
  onInputStatus?(status: InputStatusEvent): Promise<void> | void;
  /** Defaults to `next`. */
  priority?: InputPriority;
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
  /** Inputs folded into `first`'s prompt when the turn started. Their status follows `first`. */
  bound: Entry[];
  /** Inputs steered into the turn, in dispatch order. */
  steered: Entry[];
  ready: boolean;
  pending?: Entry;
  sealed: boolean;
  /** A `now` input ended this turn. */
  superseded: boolean;
  dispatch?: Promise<void>;
}

/** Chat's input lane is separate from the one-result-per-caller task FIFO. */
export class AgentInputQueue {
  private active?: ActiveInputTurn;
  private queued: Entry[] = [];
  /** Inputs of a superseded turn that the provider never consumed, for the next turn. */
  private carried: Entry[] = [];
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
    return !!this.active || this.queued.length > 0 || this.carried.length > 0;
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
    if (options.priority === "now") {
      this.supersede(this.active);
      return { inputId: input.inputId, turnId: entry.turnId, disposition: "queued" };
    }
    const disposition = this.active.ready && !this.active.sealed ? "steering" : "queued";
    this.flush();
    return { inputId: input.inputId, turnId: entry.turnId, disposition };
  }

  /** Whether `turnId` is a turn this queue started. */
  owns(turnId: string): boolean {
    return this.active?.handle.turnId === turnId;
  }

  // Sealing first keeps the new input from steering into the turn it ends.
  private supersede(active: ActiveInputTurn): void {
    if (active.superseded) return;
    active.superseded = true;
    active.sealed = true;
    void active.handle.interrupt?.(SUPERSEDED_INTERRUPT_REASON).catch(this.reportError);
  }

  // A turn that starts after a superseded one also takes that turn's
  // unconsumed inputs (in front, in order) and every other queued `now` input,
  // which would only supersede it again. They ride as one prompt, so the model
  // answers the burst once.
  private start(entry: Entry): void {
    const carried = this.carried;
    this.carried = [];
    const absorbed: Entry[] = [];
    if (entry.options.priority === "now") {
      const rest: Entry[] = [];
      for (const queued of this.queued) {
        if (queued.options.priority === "now") absorbed.push(queued);
        else rest.push(queued);
      }
      this.queued = rest;
    }
    const parts = [...carried, entry, ...absorbed];
    const input =
      parts.length === 1
        ? entry.input
        : {
            ...entry.input,
            prompt: parts.map((part) => part.input.prompt).join("\n\n"),
            images: parts.flatMap((part) => part.input.images ?? []),
          };
    const handle = this.startTurn(input, entry.options);
    const bound = [...carried, ...absorbed];
    this.active = {
      handle,
      first: entry,
      bound,
      steered: [],
      ready: false,
      sealed: false,
      superseded: false,
    };
    for (const part of parts) {
      part.turnId = handle.turnId;
      void this.update(part, "queued").catch(this.reportError);
    }
    entry.options.onTurn(handle);
  }

  async beforeSend(turnId: string): Promise<void> {
    const active = this.active;
    if (active?.handle.turnId !== turnId) return;
    await Promise.all(
      [active.first, ...active.bound].map((entry) => this.update(entry, "submitted")),
    );
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
    // Bound inputs reached the provider inside `first`'s prompt.
    if (entry === active.first && (event.state === "consumed" || event.state === "failed")) {
      await Promise.all(active.bound.map((bound) => this.update(bound, event.state)));
    }
  }

  private flush(): void {
    const active = this.active;
    const provider = this.provider();
    if (!active?.ready || active.pending || active.sealed || !provider.steerUserInput) return;
    const entry = this.queued.shift();
    if (!entry) return;
    active.pending = entry;
    active.steered.push(entry);
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
    if (active.superseded) {
      // The provider never saw these, or saw them only in a turn it dropped
      // (Claude resumes from its transcript, which lacks an input it had not
      // read yet). An input the provider retained is already queued again.
      this.carried = [active.first, ...active.bound, ...active.steered].filter(
        (entry) =>
          entry.state !== "consumed" && entry.state !== "cancelled" && !this.queued.includes(entry),
      );
    } else {
      for (const entry of [active.first, ...active.bound, active.pending]) {
        if (entry && (entry.state === "accepted" || entry.state === "submitted")) {
          void this.update(entry, "unknown").catch(this.reportError);
        }
      }
      for (const entry of [active.first, ...active.bound]) {
        if (entry.state === "queued" && !this.queued.includes(entry)) {
          void this.update(entry, "failed").catch(this.reportError);
        }
      }
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
    const next = this.queued.shift() ?? this.carried.shift();
    if (next) this.start(next);
  }

  cancel(turnId: string): void {
    const active = this.active;
    if (active?.handle.turnId !== turnId) return;
    active.sealed = true;
    for (const entry of [active.pending, ...this.queued, ...this.carried]) {
      if (entry) void this.update(entry, "cancelled").catch(this.reportError);
    }
    this.queued = [];
    this.carried = [];
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
