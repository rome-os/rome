import type { AgentInputState, InputStatusEvent } from "@rome-os/app-runtime";
import type { AgentTurnHandle, AgentTurnInput, SendTurnOptions } from "./agent-session.js";
import type { ModelSession } from "../domain/model-port.js";
import {
  arrive,
  boundFollow,
  canSteer,
  carryOver,
  defer,
  endTurn,
  failedSteerState,
  isSettled,
  joinPrompts,
  markReady,
  nextInput,
  release,
  retain,
  seal as sealTurn,
  steer,
  steerOutcome,
  startTurn as startInputTurn,
  supersede,
  SUPERSEDED_INTERRUPT_REASON,
  type InputPriority,
  type InputTurn,
} from "../domain/input-queue.js";

export { SUPERSEDED_INTERRUPT_REASON, type InputPriority } from "../domain/input-queue.js";

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
  priority: InputPriority;
  state: AgentInputState;
  turnId: string;
  writes: Promise<void>;
}

/** The running turn: its handle, its inputs under the domain rules, and its steer in flight. */
interface ActiveInputTurn {
  handle: AgentTurnHandle;
  turn: InputTurn<Entry>;
  dispatch?: Promise<void>;
}

/**
 * Chat's input lane is separate from the one-result-per-caller task FIFO. It
 * holds the input queue's state over time and drives its rules
 * (`domain/input-queue.ts`): it starts turns, steers through the model
 * session, and writes each input's status in order.
 */
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
    const entry: Entry = {
      input,
      options,
      priority: options.priority ?? "next",
      state: "queued",
      turnId: "",
      writes: Promise.resolve(),
    };
    this.entries.set(input.inputId, entry);
    const active = this.active;
    const arrival = arrive(active?.turn, entry.priority);
    if (!active) {
      this.start(entry);
      return { inputId: input.inputId, turnId: entry.turnId, disposition: arrival.disposition };
    }
    entry.turnId = active.handle.id;
    this.queued.push(entry);
    void this.update(entry, "queued").catch(this.reportError);
    if (entry.priority === "now") {
      if (arrival.supersede) {
        active.turn = supersede(active.turn);
        void active.handle.stop(SUPERSEDED_INTERRUPT_REASON).catch(this.reportError);
      }
    } else {
      this.flush();
    }
    return { inputId: input.inputId, turnId: entry.turnId, disposition: arrival.disposition };
  }

  /** Whether `turnId` is a turn this queue started. */
  owns(turnId: string): boolean {
    return this.active?.handle.id === turnId;
  }

  private start(first: Entry): void {
    const { turn, queued } = startInputTurn(first, this.queued, this.carried);
    this.queued = queued;
    this.carried = [];
    const handle = this.startTurn(
      joinPrompts(
        first.input,
        turn.prompted.map((part) => part.input),
      ),
      first.options,
    );
    this.active = { handle, turn };
    for (const part of turn.prompted) {
      part.turnId = handle.id;
      void this.update(part, "queued").catch(this.reportError);
    }
    first.options.onTurn(handle);
  }

  async beforeSend(turnId: string): Promise<void> {
    const active = this.active;
    if (active?.handle.id !== turnId) return;
    await Promise.all(
      [active.turn.first, ...active.turn.bound].map((entry) => this.update(entry, "submitted")),
    );
  }

  ready(turnId: string): void {
    const active = this.active;
    if (active?.handle.id !== turnId) return;
    active.turn = markReady(active.turn);
    this.flush();
  }

  async observe(event: InputStatusEvent, turnId: string): Promise<void> {
    const entry = this.entries.get(event.inputId);
    if (!entry) return;
    entry.turnId = turnId;
    await this.update(entry, event.state);
    const active = this.active;
    if (active?.handle.id !== turnId) return;
    if (event.state === "queued") {
      // sendUserInput(inputId) will adopt the retained input, never enqueue a second copy.
      const retained = retain(active.turn, entry, this.queued);
      active.turn = retained.turn;
      this.queued = retained.queued;
    } else if (event.state === "consumed" && active.turn.pending === entry) {
      active.turn = release(active.turn, entry);
      this.flush();
    }
    const bound = boundFollow(active.turn, entry, event.state);
    if (bound) await Promise.all(bound.map((input) => this.update(input, event.state)));
  }

  private flush(): void {
    const active = this.active;
    const provider = this.provider();
    if (!active || !canSteer(active.turn) || !provider.steerUserInput) return;
    const entry = this.queued.shift();
    if (!entry) return;
    active.turn = steer(active.turn, entry);
    entry.turnId = active.handle.id;
    active.dispatch = (async () => {
      try {
        // Persist the dispatch boundary before a provider can observe input.
        await this.update(entry, "submitted");
        if (this.active !== active || active.turn.sealed) {
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
        const outcome = steerOutcome(entry.state, result);
        if (outcome === "settled") return;
        if (outcome === "deferred") {
          active.turn = defer(active.turn);
          this.queued.unshift(entry);
          await this.update(entry, "queued");
          if (this.active !== active && !this.active && !this.closed) this.startNext();
        } else {
          await this.update(entry, "accepted");
        }
      } catch (error) {
        const state = failedSteerState(entry.state);
        if (state) await this.update(entry, state);
        this.reportError(error);
      }
    })().catch(this.reportError);
  }

  async seal(turnId: string): Promise<void> {
    const active = this.active;
    if (active?.handle.id !== turnId) return;
    active.turn = sealTurn(active.turn);
    await active.dispatch;
  }

  finish(turnId: string): void {
    const active = this.active;
    if (active?.handle.id !== turnId) return;
    active.turn = sealTurn(active.turn);
    this.active = undefined;
    if (active.turn.superseded) {
      this.carried = carryOver(active.turn, this.queued);
    } else {
      for (const [entry, state] of endTurn(active.turn, this.queued)) {
        void this.update(entry, state).catch(this.reportError);
      }
    }
    this.startNext();
    // Retain a bounded deduplication window; durable identities live in the repository.
    if (this.entries.size > 256) {
      for (const [id, entry] of this.entries) {
        if (isSettled(entry.state)) this.entries.delete(id);
        if (this.entries.size <= 256) break;
      }
    }
  }

  private startNext(): void {
    if (this.active || this.closed) return;
    const { next, queued, carried } = nextInput(this.queued, this.carried);
    if (!next) return;
    this.queued = queued;
    this.carried = carried;
    this.start(next);
  }

  cancel(turnId: string): void {
    const active = this.active;
    if (active?.handle.id !== turnId) return;
    active.turn = sealTurn(active.turn);
    for (const entry of [active.turn.pending, ...this.queued, ...this.carried]) {
      if (entry) void this.update(entry, "cancelled").catch(this.reportError);
    }
    this.queued = [];
    this.carried = [];
  }

  close(): void {
    this.closed = true;
    if (this.active) this.cancel(this.active.handle.id);
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
