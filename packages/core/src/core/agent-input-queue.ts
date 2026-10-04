import type { AgentInputState, InputStatusMessage } from "@rome-os/app-runtime";
import type { AgentTurnHandle, AgentTurnInput, SendTurnOptions } from "./agent-session.js";

export interface SubmitInputOptions extends SendTurnOptions {
  /** Called for the caller handle. It is not a visible model-turn boundary. */
  onTurn(handle: AgentTurnHandle): void;
  onInputStatus?(status: InputStatusMessage): Promise<void> | void;
}

export interface AgentInputReceipt {
  inputId: string;
  /** Caller handles are private correlation; webchat streams start at the model turn. */
  turnId: string | null;
  disposition: "sent";
}

interface Entry {
  input: AgentTurnInput & { inputId: string };
  options: SubmitInputOptions;
  state: AgentInputState;
  writes: Promise<void>;
}

/**
 * Conversational inputs are send-through. The provider owns folding and model
 * turns; this class only persists the input's sent → read → answered progress.
 */
export class AgentInputQueue {
  private entries = new Map<string, Entry>();
  private closed = false;

  constructor(
    private readonly startTurn: (
      input: AgentTurnInput,
      options: SendTurnOptions,
    ) => AgentTurnHandle,
    private readonly reportError: (error: unknown) => void,
  ) {}

  get busy(): boolean {
    return false;
  }

  submit(
    input: AgentTurnInput & { inputId: string },
    options: SubmitInputOptions,
  ): AgentInputReceipt {
    if (this.closed) throw new Error("Input queue is closed");
    const existing = this.entries.get(input.inputId);
    if (existing) return { inputId: input.inputId, turnId: null, disposition: "sent" };

    const handle = this.startTurn(input, options);
    const entry: Entry = {
      input,
      options,
      state: "sent",
      writes: Promise.resolve(),
    };
    this.entries.set(input.inputId, entry);
    void this.update(entry, "sent").catch(this.reportError);
    options.onTurn(handle);
    return { inputId: input.inputId, turnId: null, disposition: "sent" };
  }

  // These boundaries remain part of AgentSession's internal lifecycle. Inputs
  // no longer queue or steer at them; the SDK decides whether they fold.
  async beforeSend(_turnId: string): Promise<void> {}
  ready(_turnId: string): void {}
  async seal(_turnId: string): Promise<void> {}
  finish(_turnId: string): void {}

  async observe(event: InputStatusMessage, turnId: string): Promise<void> {
    const entry = this.entries.get(event.inputId);
    if (!entry || entry.state === "answered") return;
    await this.update(entry, "read", turnId);
  }

  async answer(inputId: string, turnId: string): Promise<void> {
    const entry = this.entries.get(inputId);
    if (!entry) return;
    await this.update(entry, "answered", turnId);
    // Retain a bounded retry/deduplication window; durable identities live in
    // the repository.
    if (this.entries.size > 256) {
      for (const [id, candidate] of this.entries) {
        if (candidate.state === "answered") this.entries.delete(id);
        if (this.entries.size <= 256) break;
      }
    }
  }

  close(): void {
    this.closed = true;
  }

  private update(entry: Entry, state: AgentInputState, turnId?: string): Promise<void> {
    entry.state = state;
    const event: InputStatusMessage = {
      type: "input_status",
      inputId: entry.input.inputId,
      state,
      ...(turnId ? { turnId } : {}),
    };
    entry.writes = entry.writes.then(() => entry.options.onInputStatus?.(event));
    return entry.writes;
  }
}
