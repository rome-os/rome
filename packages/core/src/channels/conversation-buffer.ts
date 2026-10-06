/**
 * The events one inbound subscriber has not handled yet, kept as one list per
 * conversation. Rules R3 and R4 of `Inbound` (channel.ts) are what it keeps:
 * a conversation's events reach the handler one at a time in the order they
 * were pushed, and conversations never wait on each other.
 */

import type { Logger } from "../logger.js";

export interface ConversationBufferLimits {
  /** Most events a conversation may hold waiting. Pushing past it drops the
   *  oldest waiting event, which R3 (at most once) allows. */
  capacity: number;
  /** Waiting events at which a conversation is reported as backing up. */
  depthWarning: number;
  /** How long a handler may run before it is reported as still running. It is
   *  not stopped: a timeout that moved on would break the conversation's order. */
  slowHandlerMs: number;
}

/**
 * The defaults. An agent turn legitimately runs for minutes, so the slow-handler
 * report waits ten. A person rarely sends twenty messages while one turn runs,
 * so twenty waiting means the handler is stuck. A hundred bounds what one stuck
 * conversation holds in memory, attachments included.
 */
export const CONVERSATION_BUFFER_DEFAULTS: ConversationBufferLimits = {
  capacity: 100,
  depthWarning: 20,
  slowHandlerMs: 10 * 60_000,
};

interface Conversation<T> {
  waiting: T[];
  /** Whether the depth warning has fired since the conversation last drained. */
  warned: boolean;
}

export class ConversationBuffers<T> {
  private readonly conversations = new Map<string, Conversation<T>>();
  private closed = false;

  constructor(
    private readonly handle: (item: T) => Promise<void>,
    private readonly options: {
      log: Pick<Logger, "warn" | "error">;
      /** Fields that name an item in a log line, e.g. its message id. */
      describe: (item: T) => Record<string, unknown>;
      limits?: Partial<ConversationBufferLimits>;
    },
  ) {}

  /** Add an event to its conversation and start that conversation's loop if it
   *  is not running. */
  push(conversation: string, item: T): void {
    if (this.closed) return;
    const limits = this.limits();
    let entry = this.conversations.get(conversation);
    const idle = !entry;
    if (!entry) {
      entry = { waiting: [], warned: false };
      this.conversations.set(conversation, entry);
    }
    if (entry.waiting.length >= limits.capacity) {
      const dropped = entry.waiting.shift()!;
      this.options.log.warn("inbound event dropped: conversation buffer full", {
        conversation,
        capacity: limits.capacity,
        ...this.options.describe(dropped),
      });
    }
    entry.waiting.push(item);
    if (!entry.warned && entry.waiting.length >= limits.depthWarning) {
      entry.warned = true;
      this.options.log.warn("inbound conversation backing up", {
        conversation,
        waiting: entry.waiting.length,
      });
    }
    if (idle) void this.drain(conversation, entry);
  }

  /** Events waiting in a conversation, not counting one being handled. An
   *  event pushed to an idle conversation still counts until its loop starts,
   *  one microtask after the push. */
  depth(conversation: string): number {
    return this.conversations.get(conversation)?.waiting.length ?? 0;
  }

  /** Conversations with an event waiting or being handled. */
  get size(): number {
    return this.conversations.size;
  }

  /** Drop every waiting event and accept no more. A handler already running
   *  finishes; nothing starts after it. */
  close(): void {
    this.closed = true;
    for (const entry of this.conversations.values()) entry.waiting.length = 0;
  }

  private async drain(conversation: string, entry: Conversation<T>): Promise<void> {
    // Start one microtask after the push, so no handler starts inside the
    // caller's push loop, ahead of the other subscribers' pushes.
    await Promise.resolve();
    let item = entry.waiting.shift();
    while (item !== undefined && !this.closed) {
      await this.handleOne(conversation, item);
      item = entry.waiting.shift();
    }
    this.conversations.delete(conversation);
  }

  private async handleOne(conversation: string, item: T): Promise<void> {
    const { slowHandlerMs } = this.limits();
    const slow = setTimeout(() => {
      this.options.log.warn("inbound handler still running", {
        conversation,
        runningMs: slowHandlerMs,
        ...this.options.describe(item),
      });
    }, slowHandlerMs);
    slow.unref?.();
    try {
      await this.handle(item);
    } catch (err) {
      this.options.log.error("inbound handler threw", {
        conversation,
        ...this.options.describe(item),
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(slow);
    }
  }

  private limits(): ConversationBufferLimits {
    return { ...CONVERSATION_BUFFER_DEFAULTS, ...this.options.limits };
  }
}
