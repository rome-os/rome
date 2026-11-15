// When a guardian message of a Concierge chat starts to show its turn working
// (docs/domains/chats.md#status): once a working tool call of the turn ran 2
// seconds. A turn that only answers, or whose work answers or reacts within
// that grace, never shows it. A message that joined the turn after it began
// working shows it only by a task made for it. The stored facts and the
// status derived from them live in ConciergeTasksRepository and
// ConciergeTasks; this keeps only the running calls' timers and which
// messages joined a running turn.

import { bareTool } from "../lib/tool-name.js";
import type { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-message-status");

/** How long a working tool call runs before its turn's messages show working. */
export const WORKING_GRACE_MS = 2_000;

/**
 * The tools that are no work on a message: reacting to it, sending a message
 * or a card, and loading a tool's schema. Any other tool is work, such as an
 * action, a data read or starting a task chat.
 */
const ANSWER_TOOLS = new Set([
  "react",
  "say",
  "chat_forward",
  "chat_card",
  "connect_card",
  "toolsearch",
]);

/** Whether a call of `tool` shows the turn working on its message. */
export function isWorkingTool(tool: string): boolean {
  return !ANSWER_TOOLS.has(bareTool(tool));
}

type StatusRepo = Pick<
  ConciergeTasksRepository,
  "markWorking" | "markReacted" | "anyInheritedWorking"
>;

/** A working tool call that runs, with its grace timer. */
interface RunningCall {
  timer: ReturnType<typeof setTimeout>;
  done: () => void;
}

/**
 * The running turns' working triggers, one tracker per process. A message
 * handed on while it shows working keeps showing it, and then carries the
 * turn's work: a newer message beside it, such as a "thanks", shows working
 * only by a task made for it.
 */
export class MessageStatusTracker {
  /** The chats with a message a running turn took. */
  private readonly open = new Set<string>();
  /** Per chat, the messages that joined its turn after it called a tool. */
  private readonly joined = new Map<string, Set<string>>();
  /** Per chat, its turn's working tool calls that run, by call id. */
  private readonly calls = new Map<string, Map<string, RunningCall>>();

  /** `repoOf` is read at each use, as the service's task list may be wired after it. */
  constructor(
    private readonly repoOf: () => StatusRepo,
    private readonly graceMs = WORKING_GRACE_MS,
  ) {}

  private get repo(): StatusRepo {
    return this.repoOf();
  }

  /**
   * A turn of Concierge chat `chatId` took guardian message `messageKey`.
   * `joined` when the turn had called a tool before: the message joined it
   * while it ran.
   */
  taken(chatId: string, messageKey: string, { joined = false }: { joined?: boolean } = {}): void {
    this.open.add(chatId);
    if (!joined) return;
    const keys = this.joined.get(chatId) ?? new Set<string>();
    keys.add(messageKey);
    this.joined.set(chatId, keys);
  }

  /**
   * The running turn of chat `chatId` called `tool` as call `callId`. A
   * working one that still runs after the grace shows the messages the turn
   * started with working. Resolves once that is written, or the call ended
   * first.
   */
  toolCalled(chatId: string, tool: string, callId: string): Promise<void> {
    if (!this.open.has(chatId) || !isWorkingTool(tool)) return Promise.resolve();
    const calls = this.calls.get(chatId) ?? new Map<string, RunningCall>();
    this.calls.set(chatId, calls);
    calls.get(callId)?.done();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        calls.delete(callId);
        void this.guard(this.ranLong(chatId)).then(() => resolve());
      }, this.graceMs);
      timer.unref?.();
      calls.set(callId, {
        timer,
        done: () => {
          clearTimeout(timer);
          calls.delete(callId);
          resolve();
        },
      });
    });
  }

  /** Call `callId` of chat `chatId`'s running turn came back: its grace ends. */
  toolEnded(chatId: string, callId: string): void {
    this.calls.get(chatId)?.get(callId)?.done();
  }

  /**
   * The running turn of chat `chatId` reacted to guardian message
   * `messageKey`: that is how it handles it, so its turn shows it working
   * never, nor does a task made for it later.
   */
  async reactedTo(chatId: string, messageKey: string): Promise<void> {
    await this.guard(this.repo.markReacted(chatId, messageKey));
  }

  /** The running turn of chat `chatId` took its reaction to `messageKey` back. */
  async reactionCleared(chatId: string, messageKey: string): Promise<void> {
    await this.guard(this.repo.markReacted(chatId, messageKey, false));
  }

  /** Chat `chatId` runs no turn that carries its messages on: its turn's end settled them. */
  turnSettled(chatId: string): void {
    this.open.delete(chatId);
    this.joined.delete(chatId);
    for (const call of this.calls.get(chatId)?.values() ?? []) call.done();
    this.calls.delete(chatId);
  }

  /** Stops every timer, as when the process shuts down. */
  stop(): void {
    for (const calls of this.calls.values()) for (const call of calls.values()) call.done();
    this.calls.clear();
  }

  // Work handed on from an earlier turn is the work: the messages beside it
  // show none of their own.
  private async ranLong(chatId: string): Promise<void> {
    if (await this.repo.anyInheritedWorking(chatId)) return;
    await this.repo.markWorking(chatId, { except: [...(this.joined.get(chatId) ?? [])] });
  }

  // The status only shows how the work stands, so failing to write it never
  // fails the turn or the tool.
  private async guard(work: Promise<unknown>): Promise<void> {
    try {
      await work;
    } catch (error) {
      log.warn("failed to mark a message working", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
