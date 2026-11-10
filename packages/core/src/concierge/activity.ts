// What each Concierge chat is doing right now, for its header: computed here
// from facts Rome holds and pushed to the chat's owner on the
// `concierge.activity` live-events topic. The rules are
// `conciergeActivity` (@rome/api-types/concierge-activity); this file feeds
// them and decides when a change is told. docs/architecture/concierge-activity.md

import {
  type ConciergeActivity,
  type ConciergeActivityEvent,
  conciergeActivity,
  sameActivity,
} from "@rome/api-types/concierge-activity";
import type { LiveEventEmit } from "../lib/live-event.js";
import { createLogger } from "../logger.js";

const log = createLogger("concierge-activity");

/**
 * How long a named tool's activity stays at least, before a lower one (plain
 * work, running tasks, idle) takes its place. A tool such as `chat_start`
 * returns in a few milliseconds, which a header could not show. A card or an
 * approval waiting on the owner never waits for it.
 */
export const TOOL_HOLD_MS = 1_500;

/**
 * How long a chat must stay idle before idle is told. One fact often ends a
 * moment before the next begins, such as a task chat's turn and the result
 * waiting for its report, and the header would flash idle between them.
 */
export const IDLE_GRACE_MS = 1_000;

/**
 * How often every chat that is not idle has its facts read again. Each fact
 * the activity reads tells it when it changes; this catches one that changed
 * by a path that does not, so a stale "working" or "needs you" never stays.
 */
export const RECHECK_MS = 30_000;

/** One of a Concierge chat's task rows, as the activity reads it. */
export interface ActivityTaskRow {
  id: string;
  title: string;
  /** The task chat the row links, or null. */
  chatId: string | null;
  updatedAt: number;
}

/** What the activity reads its facts from. */
export interface ConciergeActivitySources {
  now(): number;
  isRunning(chatId: string): boolean;
  /** Whether the chat runs a turn its owner sees: a quiet turn counts once it has said something. */
  isBusy(chatId: string): boolean;
  openTool(chatId: string): string | null;
  /** Which of the chats wait on their owner: a card or a pending approval. */
  awaitingGuardianOf(chatIds: readonly string[]): Promise<Set<string>>;
  /** The Concierge chat's task rows that are not archived. */
  tasksOf(chatId: string): Promise<ActivityTaskRow[]>;
  /** The task rows whose result the Concierge is about to report. */
  reportPending(): readonly string[];
  /** Whose Concierge chat it is, or null when it is not one, or is gone. */
  ownerOf(chatId: string): Promise<string | null>;
  /** The owner's Concierge chats, main chat first. */
  chatsOf(owner: string): Promise<string[]>;
  /**
   * The Concierge chats whose activity a change in session `sessionId` can
   * move: the chat itself when it is a Concierge chat, the Concierge chat
   * that started it when it is a task chat, else none.
   */
  chatsMovedBy(sessionId: string): Promise<string[]>;
}

interface ChatState {
  owner: string;
  shown: ConciergeActivity;
  shownAt: number;
  /** When the facts first read idle while something else is shown, or null. */
  idleSince: number | null;
  /** Fires when a held activity may give way. */
  timer: ReturnType<typeof setTimeout> | null;
  /** A refresh is running; `again` asks it to run once more. */
  refreshing: boolean;
  again: boolean;
}

type OwnerEmit = { owner: string; emit: LiveEventEmit };

export class ConciergeActivityTracker {
  private chats = new Map<string, ChatState>();
  private subscribers = new Set<OwnerEmit>();
  private stopped = false;
  private recheck: ReturnType<typeof setInterval>;

  constructor(private sources: ConciergeActivitySources) {
    this.recheck = setInterval(() => this.recheckBusy(), RECHECK_MS);
    this.recheck.unref?.();
  }

  /** Reads again every chat whose activity is not idle and is not being read now. */
  private recheckBusy(): void {
    for (const [chatId, state] of this.chats) {
      if (state.shown.kind === "idle" || state.refreshing) continue;
      void this.refresh(chatId);
    }
  }

  /** The facts of `chatId` now, and the activity they make. */
  private async compute(chatId: string): Promise<ConciergeActivity> {
    const rows = await this.sources.tasksOf(chatId);
    const taskChats = rows.flatMap((row) => (row.chatId ? [row.chatId] : []));
    const awaiting = await this.sources.awaitingGuardianOf([chatId, ...taskChats]);
    const pending = new Set(this.sources.reportPending());
    // A running turn has answered whatever waited, as the chat list reads it.
    const waits = (id: string) => awaiting.has(id) && !this.sources.isRunning(id);
    const running = this.sources.isBusy(chatId);
    return conciergeActivity({
      awaitingGuardian: waits(chatId),
      turn: { running, tool: running ? this.sources.openTool(chatId) : null },
      reportPending: rows.some((row) => pending.has(row.id)),
      tasks: rows.flatMap((row) =>
        row.chatId
          ? [
              {
                title: row.title,
                running: this.sources.isRunning(row.chatId),
                awaitingGuardian: waits(row.chatId),
                updatedAt: row.updatedAt,
              },
            ]
          : [],
      ),
    });
  }

  /** What `chatId` is doing now: what was last told, else computed now. Null for no Concierge chat. */
  async current(chatId: string): Promise<ConciergeActivity | null> {
    const held = this.chats.get(chatId);
    if (held) return held.shown;
    const owner = await this.sources.ownerOf(chatId);
    if (!owner) return null;
    const shown = await this.compute(chatId);
    // A refresh may have set it meanwhile; that one is newer.
    const raced = this.chats.get(chatId);
    if (raced) return raced.shown;
    this.chats.set(chatId, {
      owner,
      shown,
      shownAt: this.sources.now(),
      idleSince: null,
      timer: null,
      refreshing: false,
      again: false,
    });
    return shown;
  }

  /** Reads the facts of every Concierge chat a change in session `sessionId` can move. */
  async sessionChanged(sessionId: string): Promise<void> {
    if (this.stopped) return;
    for (const chatId of await this.sources.chatsMovedBy(sessionId)) {
      await this.refresh(chatId);
    }
  }

  /**
   * Reads `chatId`'s facts again and tells its owner when its activity
   * changed. Calls for one chat run one at a time, the last after the rest.
   */
  async refresh(chatId: string): Promise<void> {
    if (this.stopped) return;
    const known = this.chats.get(chatId);
    if (known?.refreshing) {
      known.again = true;
      return;
    }
    // Read every time, so a chat deleted or archived meanwhile is forgotten.
    const owner = await this.sources.ownerOf(chatId);
    if (!owner) {
      this.forget(chatId);
      return;
    }
    const state: ChatState = this.chats.get(chatId) ?? {
      owner,
      shown: { kind: "idle" },
      shownAt: Number.NEGATIVE_INFINITY,
      idleSince: null,
      timer: null,
      refreshing: false,
      again: false,
    };
    this.chats.set(chatId, state);
    if (state.refreshing) {
      state.again = true;
      return;
    }
    state.refreshing = true;
    try {
      do {
        state.again = false;
        const next = await this.compute(chatId);
        if (this.stopped) return;
        this.show(chatId, state, next);
      } while (state.again);
    } catch (error) {
      log.warn("concierge activity refresh failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      state.refreshing = false;
    }
  }

  private show(chatId: string, state: ChatState, next: ConciergeActivity): void {
    if (next.kind !== "idle") state.idleSince = null;
    if (sameActivity(state.shown, next)) {
      this.clearTimer(state);
      return;
    }
    const now = this.sources.now();
    // A named tool stays until its hold ends, unless something waits on the
    // owner or another named tool follows it. Idle waits out its grace.
    let holdsUntil = Number.NEGATIVE_INFINITY;
    if (state.shown.kind === "tool" && next.kind !== "needsYou" && next.kind !== "tool") {
      holdsUntil = state.shownAt + TOOL_HOLD_MS;
    }
    if (next.kind === "idle") {
      state.idleSince ??= now;
      holdsUntil = Math.max(holdsUntil, state.idleSince + IDLE_GRACE_MS);
    }
    if (now < holdsUntil) {
      this.clearTimer(state);
      state.timer = setTimeout(() => {
        state.timer = null;
        void this.refresh(chatId);
      }, holdsUntil - now);
      state.timer.unref?.();
      return;
    }
    this.clearTimer(state);
    state.idleSince = null;
    state.shown = next;
    state.shownAt = now;
    const event: ConciergeActivityEvent = { chatId, activity: next, at: now };
    for (const subscriber of this.subscribers) {
      if (subscriber.owner === state.owner) subscriber.emit("concierge_activity", event);
    }
  }

  private clearTimer(state: ChatState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
  }

  /**
   * Drops a chat that is gone or archived, with its timer. Its owner is told
   * it is idle, so a screen still showing it does not keep its last activity.
   */
  forget(chatId: string): void {
    const state = this.chats.get(chatId);
    if (!state) return;
    this.clearTimer(state);
    this.chats.delete(chatId);
    if (state.shown.kind === "idle") return;
    const event: ConciergeActivityEvent = {
      chatId,
      activity: { kind: "idle" },
      at: this.sources.now(),
    };
    for (const subscriber of this.subscribers) {
      if (subscriber.owner === state.owner) subscriber.emit("concierge_activity", event);
    }
  }

  /**
   * Emits `concierge_activity` for each of `owner`'s Concierge chats now,
   * then for each change of one. Returns the unsubscribe.
   */
  subscribe(owner: string, emit: LiveEventEmit): () => void {
    const subscriber: OwnerEmit = { owner, emit };
    this.subscribers.add(subscriber);
    void (async () => {
      for (const chatId of await this.sources.chatsOf(owner)) {
        const activity = await this.current(chatId);
        if (!activity || !this.subscribers.has(subscriber)) continue;
        const event: ConciergeActivityEvent = {
          chatId,
          activity,
          at: this.chats.get(chatId)?.shownAt ?? this.sources.now(),
        };
        emit("concierge_activity", event);
      }
    })().catch((error: unknown) =>
      log.warn("concierge activity snapshot failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Stops every timer and tells no one any more. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.recheck);
    for (const state of this.chats.values()) this.clearTimer(state);
    this.chats.clear();
    this.subscribers.clear();
  }
}
