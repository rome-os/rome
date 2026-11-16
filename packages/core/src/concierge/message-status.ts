// When a guardian message of a Concierge chat starts to show its turn working
// (docs/domains/chats.md#status): once a working tool call of the turn ran
// half a second, or at the turn's second working tool call. A turn that only
// answers, or whose one quick call it follows with an answer or a reaction,
// never shows it. A message that joined the turn after it began
// working shows it only by a task made for it. The stored facts and the
// status derived from them live in ConciergeTasksRepository and
// ConciergeTasks; this keeps only the running calls' timers and which
// messages joined a running turn.

import { bareTool } from "../lib/tool-name.js";
import type { ConciergeTasksRepository } from "../db/repositories/concierge-tasks.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-message-status");

/** How long a working tool call runs before its turn's messages show working. */
export const WORKING_GRACE_MS = 500;

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

/** A sign of work the owner sees on a message of chat `chatId`: 👀 working, or a reaction. */
export type MessageSign = (chatId: string, sign: "working" | "reacted") => void;

type StatusRepo = Pick<
  ConciergeTasksRepository,
  "markWorking" | "markReacted" | "anyInheritedWorking"
>;

/** A working tool call that runs, with its grace timer. */
interface RunningCall {
  timer: ReturnType<typeof setTimeout>;
  done: () => void;
}

/** The working tool calls of one turn: how many it made, and those that run. */
interface TurnCalls {
  turnId: string;
  count: number;
  running: Map<string, RunningCall>;
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
  /** Per chat, the messages that joined a turn after it called a tool. */
  private readonly joined = new Map<string, Set<string>>();
  /**
   * Per chat, the working tool calls of its latest turn. A turn's calls never
   * count toward another's: a newer turn drops them, timers included.
   */
  private readonly calls = new Map<string, TurnCalls>();
  private readonly signListeners = new Set<MessageSign>();

  /** `repoOf` is read at each use, as the service's task list may be wired after it. */
  constructor(
    private readonly repoOf: () => StatusRepo,
    private readonly graceMs = WORKING_GRACE_MS,
  ) {}

  /** Tells `listener` each sign of work a chat's messages show; answers its removal. */
  onSign(listener: MessageSign): () => void {
    this.signListeners.add(listener);
    return () => this.signListeners.delete(listener);
  }

  private tellSign(chatId: string, sign: "working" | "reacted"): void {
    for (const listener of this.signListeners) {
      try {
        listener(chatId, sign);
      } catch (error) {
        log.warn("a message sign listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private get repo(): StatusRepo {
    return this.repoOf();
  }

  /**
   * Turn `turnId` of Concierge chat `chatId` took guardian message
   * `messageKey`. `joined` when the turn had called a tool before: the
   * message joined it while it ran.
   */
  taken(
    chatId: string,
    messageKey: string,
    turnId: string,
    { joined = false }: { joined?: boolean } = {},
  ): void {
    this.open.add(chatId);
    this.callsOf(chatId, turnId);
    if (!joined) return;
    const keys = this.joined.get(chatId) ?? new Set<string>();
    keys.add(messageKey);
    this.joined.set(chatId, keys);
  }

  /**
   * Turn `turnId` of chat `chatId` called `tool` as call `callId`. A working
   * one that still runs after the grace, or the turn's second working one,
   * shows the messages the turn started with working. Resolves once that is
   * written, or the call ended first.
   */
  toolCalled(chatId: string, turnId: string, tool: string, callId: string): Promise<void> {
    if (!this.open.has(chatId) || !isWorkingTool(tool)) return Promise.resolve();
    const turn = this.callsOf(chatId, turnId);
    turn.count += 1;
    // Work made of short calls is work too: the second one shows it.
    if (turn.count === 2) return this.guard(this.ranLong(chatId));
    turn.running.get(callId)?.done();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        turn.running.delete(callId);
        void this.guard(this.ranLong(chatId)).then(() => resolve());
      }, this.graceMs);
      timer.unref?.();
      turn.running.set(callId, {
        timer,
        done: () => {
          clearTimeout(timer);
          turn.running.delete(callId);
          resolve();
        },
      });
    });
  }

  /** The messages that joined chat `chatId`'s running turn after it called a tool. */
  joinedIn(chatId: string): readonly string[] {
    return [...(this.joined.get(chatId) ?? [])];
  }

  /** Call `callId` of turn `turnId` of chat `chatId` came back: its grace ends. */
  toolEnded(chatId: string, turnId: string, callId: string): void {
    const turn = this.calls.get(chatId);
    if (turn?.turnId === turnId) turn.running.get(callId)?.done();
  }

  /**
   * The running turn of chat `chatId` reacted to guardian message
   * `messageKey`: that is how it handles it, so its turn shows it working
   * never, nor does a task made for it later.
   */
  async reactedTo(chatId: string, messageKey: string): Promise<void> {
    await this.guard(this.repo.markReacted(chatId, messageKey));
    this.tellSign(chatId, "reacted");
  }

  /** The running turn of chat `chatId` took its reaction to `messageKey` back. */
  async reactionCleared(chatId: string, messageKey: string): Promise<void> {
    await this.guard(this.repo.markReacted(chatId, messageKey, false));
  }

  /** Turn `turnId` of chat `chatId` ended: its calls count no more, and their timers stop. */
  turnEnded(chatId: string, turnId: string): void {
    const turn = this.calls.get(chatId);
    if (turn?.turnId !== turnId) return;
    this.dropCalls(turn);
    this.calls.delete(chatId);
  }

  /** Chat `chatId` runs no turn that carries its messages on: its turn's end settled them. */
  turnSettled(chatId: string): void {
    this.open.delete(chatId);
    this.joined.delete(chatId);
    const turn = this.calls.get(chatId);
    if (turn) this.dropCalls(turn);
    this.calls.delete(chatId);
  }

  /** Stops every timer, as when the process shuts down. */
  stop(): void {
    for (const turn of this.calls.values()) this.dropCalls(turn);
    this.calls.clear();
  }

  // A chat runs one turn at a time, so a call of another turn starts afresh.
  private callsOf(chatId: string, turnId: string): TurnCalls {
    const current = this.calls.get(chatId);
    if (current?.turnId === turnId) return current;
    if (current) this.dropCalls(current);
    const turn: TurnCalls = { turnId, count: 0, running: new Map() };
    this.calls.set(chatId, turn);
    return turn;
  }

  private dropCalls(turn: TurnCalls): void {
    for (const call of [...turn.running.values()]) call.done();
  }

  // Work handed on from an earlier turn is the work: the messages beside it
  // show none of their own.
  private async ranLong(chatId: string): Promise<void> {
    if (await this.repo.anyInheritedWorking(chatId)) return;
    await this.repo.markWorking(chatId, { except: [...(this.joined.get(chatId) ?? [])] });
    this.tellSign(chatId, "working");
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
