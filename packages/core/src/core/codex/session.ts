// Codex turn dispatcher and event sink. Agent model: docs/concepts/agents.md.
//
// The sink is the push-side of the events `AsyncIterable` exposed on
// `ModelSession`. The run-stream translator pushes into it; the consumer
// reads the iterator handed to AgentSession.
//
// The dispatcher serializes one input producer: at most one in-flight `runOne`
// at a time, with sendUserInput appending to a buffer that the dispatcher drains
// when the previous run idles. SerialTurnCoordinator adds a shared exclusive
// lane when another producer temporarily borrows the same thread. This mirrors
// `AsyncMessageQueue` on the Anthropic side.

import { Mutex } from "async-mutex";
import type { AgentEvent } from "../../types.js";

export class AgentMessageSink {
  private buffer: AgentEvent[] = [];
  private resolvers: Array<(item: IteratorResult<AgentEvent>) => void> = [];
  private done = false;

  push(msg: AgentEvent): void {
    if (this.done) return;
    if (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value: undefined as never, done: true });
    }
  }

  iter(): AsyncIterable<AgentEvent> {
    const next = async (): Promise<IteratorResult<AgentEvent>> => {
      if (this.buffer.length > 0) {
        return { value: this.buffer.shift()!, done: false };
      }
      if (this.done) return { value: undefined as never, done: true };
      return await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        this.resolvers.push(resolve);
      });
    };
    return {
      [Symbol.asyncIterator]() {
        return { next };
      },
    };
  }
}

/**
 * One exclusive lane shared by ordinary source turns and any provider-level
 * work that must temporarily borrow the same thread. Unlike TurnDispatcher,
 * this does not batch inputs or own a queue API; it only prevents independent
 * producers from overlapping and gives session shutdown one drain point.
 */
export class SerialTurnCoordinator {
  private readonly mutex = new Mutex();

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(work);
  }

  async waitForIdle(): Promise<void> {
    await this.mutex.waitForUnlock();
  }
}

export interface TurnDispatcherDeps<T> {
  /** Drain the buffer in one turn. The dispatcher only invokes this when
   * there's no run in flight and the buffer is non-empty. */
  runOne(items: T[]): Promise<void>;
}

export class TurnDispatcher<T> {
  private pending: T[] = [];
  private inflight = false;
  private closed = false;
  private idleResolvers: Array<() => void> = [];

  constructor(private deps: TurnDispatcherDeps<T>) {}

  enqueue(items: T | T[]): void {
    if (this.closed) {
      throw new Error("TurnDispatcher is closed");
    }
    if (Array.isArray(items)) {
      this.pending.push(...items);
    } else {
      this.pending.push(items);
    }
    if (this.pending.length === 0) return;
    void this.tryRun();
  }

  close(): void {
    this.closed = true;
    this.pending = [];
    this.resolveIdleIfReady();
  }

  async waitForIdle(): Promise<void> {
    if (!this.inflight && this.pending.length === 0) return;
    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private async tryRun(): Promise<void> {
    if (this.inflight || this.closed) return;
    if (this.pending.length === 0) return;
    this.inflight = true;
    try {
      while (!this.closed && this.pending.length > 0) {
        const items = this.pending.splice(0, this.pending.length);
        try {
          await this.deps.runOne(items);
        } catch {
          // The provider's runOne is already responsible for translating
          // errors onto the events sink. Swallow here to keep the
          // dispatcher loop healthy.
        }
      }
    } finally {
      this.inflight = false;
      this.resolveIdleIfReady();
    }
  }

  private resolveIdleIfReady(): void {
    if (this.inflight || this.pending.length > 0) return;
    while (this.idleResolvers.length > 0) {
      const resolve = this.idleResolvers.shift()!;
      resolve();
    }
  }
}
