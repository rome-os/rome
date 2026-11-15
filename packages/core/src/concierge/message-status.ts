// When a guardian message of a Concierge chat starts to show its turn working
// (docs/domains/chats.md#status): the turn's first working tool, or 5 seconds
// without an answer. A turn that only answers, with `react` or a short `say`,
// and calls no working tool, never shows it. The stored facts and the status
// derived from them live in ConciergeTasksRepository and ConciergeTasks; this
// keeps only the timers and which chats run a turn that took a message.

import { bareTool } from "../lib/tool-name.js";
import type { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-message-status");

/** How long a turn runs without answering a message before it shows working. */
export const WORKING_AFTER_MS = 5_000;

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

/**
 * The running turns' working triggers, one tracker per process. A message
 * handed on while it shows working keeps showing it, and then carries the
 * turn's work: a newer message beside it, such as a "thanks", shows working
 * only by a task made for it.
 */
export class MessageStatusTracker {
  /** A 5-second timer per open message, by chat and key. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The chats with a message a running turn took. */
  private readonly open = new Set<string>();

  /** `repoOf` is read at each use, as the service's task list may be wired after it. */
  constructor(
    private readonly repoOf: () => StatusRepo,
    private readonly workingAfterMs = WORKING_AFTER_MS,
  ) {}

  private get repo(): StatusRepo {
    return this.repoOf();
  }

  /** A turn of Concierge chat `chatId` took guardian message `messageKey`. */
  taken(chatId: string, messageKey: string): void {
    this.open.add(chatId);
    const key = timerKey(chatId, messageKey);
    const before = this.timers.get(key);
    if (before) clearTimeout(before);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.guard(this.ranLong(chatId));
    }, this.workingAfterMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** The running turn of chat `chatId` called `tool`. */
  async toolCalled(chatId: string, tool: string): Promise<void> {
    if (!this.open.has(chatId) || !isWorkingTool(tool)) return;
    await this.guard(
      (async () => {
        if (await this.repo.anyInheritedWorking(chatId)) return;
        await this.repo.markWorking(chatId);
      })(),
    );
  }

  /**
   * The running turn of chat `chatId` reacted to guardian message
   * `messageKey`: that is how it handles it, so its turn shows it working no
   * more. A task made for it still does.
   */
  async reactedTo(chatId: string, messageKey: string): Promise<void> {
    const timer = this.timers.get(timerKey(chatId, messageKey));
    if (timer) clearTimeout(timer);
    this.timers.delete(timerKey(chatId, messageKey));
    await this.guard(this.repo.markReacted(chatId, messageKey));
  }

  /** The running turn of chat `chatId` took its reaction to `messageKey` back. */
  async reactionCleared(chatId: string, messageKey: string): Promise<void> {
    await this.guard(this.repo.markReacted(chatId, messageKey, false));
  }

  /** Chat `chatId` runs no turn that carries its messages on: its turn's end settled them. */
  turnSettled(chatId: string): void {
    this.open.delete(chatId);
    const prefix = timerKey(chatId, "");
    for (const [key, timer] of this.timers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  /** Stops every timer, as when the process shuts down. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async ranLong(chatId: string): Promise<void> {
    // Every message the turn took is treated alike, whichever trigger fires first.
    if (await this.repo.anyInheritedWorking(chatId)) return;
    await this.repo.markWorking(chatId);
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

function timerKey(chatId: string, messageKey: string): string {
  return `${chatId}\u0000${messageKey}`;
}
