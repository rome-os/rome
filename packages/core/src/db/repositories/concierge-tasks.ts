import { randomUUID } from "node:crypto";
import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DrizzleDb, DrizzleTx } from "../index.js";
import type { ChatRef } from "../../chats/storage/place.js";
import { MessageRepository } from "../../chats/storage/message-repository.js";
import { MAIN_CHAT_NAME, mainChatIdOf } from "../../concierge/main-chat.js";
import { GUARDIAN_OWNER, ownerOf } from "../../webchat/owner.js";
import type { ConciergeStatusReaction } from "@rome/api-types/concierge";
import { createLogger } from "../../logger.js";
import {
  conciergeMessageTasks,
  conciergeMessageTurns,
  conciergeTasks,
  romeSessions,
} from "../schema.js";

const log = createLogger("concierge-tasks");

export type ConciergeTaskRow = typeof conciergeTasks.$inferSelect;
type ConciergeTaskState = ConciergeTaskRow["state"];

/**
 * A row with the name of the task chat it links, which is the chat's own, the
 * Concierge chat it came from, and the id of its source message when that
 * message still exists in that Concierge chat.
 */
export interface ConciergeTaskWithChat {
  row: ConciergeTaskRow;
  chat: { id: string; name: string } | null;
  /** The Concierge chat the row came from: its owner's main chat when the row names none or its chat is gone. */
  conciergeChat: { id: string; name: string; main: boolean };
  /** Whose Concierge the row is, as the row records it. Never sent to a client. */
  owner: string;
  sourceMessageId: string | null;
}

/** One write of a batch. An entry without `id` creates a row, one with `id`
 *  updates it. A field left out is left as it is; `null` clears a nullable one. */
export interface ConciergeTaskWrite {
  id?: string;
  title?: string;
  state?: ConciergeTaskState;
  summary?: string | null;
  note?: string | null;
  waitingOn?: string | null;
  dueAt?: Date | null;
  rank?: number | null;
  sessionId?: string | null;
  /** The Concierge chat the row came from. Null is the main chat. */
  chatId?: string | null;
  /** A message of the row's Concierge chat, by its key there; the caller has
   *  checked it. */
  sourceMessageId?: string | null;
  /** The key of the message that names the row's chat thread. Written only
   *  while the row has none; a move to another Concierge chat clears it. */
  threadRoot?: string | null;
  archived?: boolean;
}

/** `write`: settles the task events owed for the row. `refresh`: tells readers
 *  without settling those events. */
type ChangeKind = "write" | "refresh";
type ChangeListener = (task: ConciergeTaskWithChat, change: ChangeKind) => void;

const isFinished = (state: ConciergeTaskState) => state === "done" || state === "dropped";

/** A guardian message in a Concierge chat, by its key there. */
export interface ReactionTarget {
  chatId: string;
  messageKey: string;
}

/** A task's chat thread in Concierge chat `chatId`, rooted at `root`, ended: its task left the chat. */
export interface ChatThreadRetired {
  chatId: string;
  root: string;
}

/** What a guardian message's status reaction is derived from, as stored. */
export interface MessageMarkRow {
  /** Whether the turn that took it answered it; null when no turn took it. */
  answered: boolean | null;
  /** The tasks made for it. */
  taskIds: string[];
}

/**
 * The Concierge's todo list. Only the Concierge's tools write it; every write
 * tells the change listeners, which push the row to the panel and settle the
 * task events the Concierge owed for it.
 */
export class ConciergeTasksRepository {
  private listeners = new Set<ChangeListener>();
  private messageListeners = new Set<(target: ReactionTarget) => void>();
  private threadListeners = new Set<(retired: ChatThreadRetired) => void>();

  /** Where a task's source message is looked up: its Concierge chat's
   *  lines in Chats. */
  private readonly sources: TaskSources;

  constructor(
    private db: DrizzleDb,
    sources?: TaskSources,
  ) {
    this.sources = sources ?? conciergeChatSources(db);
  }

  /**
   * Concierge chat `chatId` is archived or deleted. Its rows stay its own,
   * and read as its owner's main chat's from now on, so none is moved. Its
   * rows that `isOpen` keeps let go of their chat thread there, so their next
   * report starts one in the main chat; an ended row keeps its thread.
   * Answers how many rows are open.
   */
  async leaveChat(
    chatId: string,
    isOpen: (rows: ConciergeTaskRow[]) => Promise<Set<string>>,
    now = new Date(),
  ): Promise<number> {
    const rows = await this.db
      .select()
      .from(conciergeTasks)
      .where(and(eq(conciergeTasks.chatId, chatId), isNull(conciergeTasks.archivedAt)));
    const openIds = await isOpen(rows);
    const open = rows.filter((row) => openIds.has(row.id));
    const rooted = open.filter((row) => row.threadRoot);
    if (rooted.length > 0) {
      await this.db
        .update(conciergeTasks)
        .set({ threadRoot: null, updatedAt: now })
        .where(
          inArray(
            conciergeTasks.id,
            rooted.map((row) => row.id),
          ),
        );
    }
    for (const { id } of open) await this.announce(id, "refresh");
    for (const root of new Set(rooted.map((row) => row.threadRoot))) {
      if (root) this.retireThread({ chatId }, root);
    }
    return open.length;
  }

  /**
   * Task chat `chatId` is archived or deleted, so its task is stopped: the
   * row of `owner` that links the chat is stopped for that reason and
   * archived, in the one transaction that `alsoIn` archives or deletes the
   * chat in. Answers the row, or null when the chat links no row of `owner`;
   * the chat is archived or deleted either way.
   */
  async endWithChat(
    chatId: string,
    owner: string,
    end: "archived" | "deleted",
    alsoIn: (tx: DrizzleTx) => void,
    now = new Date(),
  ): Promise<ConciergeTaskRow | null> {
    const ended = this.db.transaction((tx) => {
      const row = tx
        .select()
        .from(conciergeTasks)
        .where(eq(conciergeTasks.sessionId, chatId))
        .get();
      const own = row && ownerOf(row) === owner ? row : null;
      const [written] = own
        ? tx
            .update(conciergeTasks)
            .set({
              stoppedAt: own.stoppedAt ?? now,
              stopReason: own.stopReason ?? end,
              // Only a row archiving the chat archived comes back with it.
              archivedAt: own.archivedAt ?? now,
              archivedWithChat: own.archivedAt ? own.archivedWithChat : true,
              updatedAt: now,
            })
            .where(eq(conciergeTasks.id, own.id))
            .returning()
            .all()
        : [];
      alsoIn(tx);
      return written ?? null;
    });
    if (ended) await this.announce(ended.id, "refresh");
    return ended;
  }

  /**
   * Archived task chat `chatId` is back, and so is the row of `owner` that
   * archiving it archived. It stays stopped. A row archived before its chat
   * stays archived.
   */
  async restoreWithChat(chatId: string, owner: string, now = new Date()): Promise<void> {
    const row = await this.findBySession(chatId);
    if (!row || ownerOf(row) !== owner || !row.archivedWithChat) return;
    await this.db
      .update(conciergeTasks)
      .set({ archivedAt: null, archivedWithChat: false, updatedAt: now })
      .where(eq(conciergeTasks.id, row.id));
    await this.announce(row.id, "refresh");
  }

  /** How task `id`'s task chat's latest work ended. Rome writes it; the Concierge never does. */
  async setLastOutcome(
    id: string,
    outcome: "succeeded" | "failed" | "stopped",
    now = new Date(),
  ): Promise<void> {
    await this.db
      .update(conciergeTasks)
      // A result waits for the Concierge's report; a stop has none to give.
      .set({ lastOutcome: outcome, outcomeUnsaid: outcome !== "stopped", updatedAt: now })
      .where(eq(conciergeTasks.id, id));
    await this.announce(id, "refresh");
  }

  /** Task `id` was stopped by `by`. A stop is kept: a later one changes nothing. */
  async stop(id: string, by: "concierge" | "guardian", now = new Date()): Promise<void> {
    const stopped = await this.db
      .update(conciergeTasks)
      .set({ stoppedAt: now, stopReason: by, updatedAt: now })
      .where(and(eq(conciergeTasks.id, id), isNull(conciergeTasks.stoppedAt)))
      .returning({ id: conciergeTasks.id });
    if (stopped.length > 0) await this.announce(id, "refresh");
  }

  /**
   * Task `id`, stopped by the Concierge or its owner, takes new work: it is
   * stopped no more. A task stopped by archiving or deleting its chat stays
   * stopped. Answers whether it was resumed.
   */
  async resume(id: string, now = new Date()): Promise<boolean> {
    const resumed = await this.db
      .update(conciergeTasks)
      .set({ stoppedAt: null, stopReason: null, updatedAt: now })
      .where(
        and(
          eq(conciergeTasks.id, id),
          inArray(conciergeTasks.stopReason, ["concierge", "guardian"]),
        ),
      )
      .returning({ id: conciergeTasks.id });
    if (resumed.length > 0) await this.announce(id, "refresh");
    return resumed.length > 0;
  }

  /**
   * Task `id` never started: its first message did not reach its task chat,
   * and that chat is gone. The row stays, failed, so the task does not start
   * again unseen.
   */
  async markStartFailed(id: string, now = new Date()): Promise<void> {
    await this.db
      .update(conciergeTasks)
      .set({ lastOutcome: "failed", state: "dropped", completedAt: now, updatedAt: now })
      .where(eq(conciergeTasks.id, id));
    await this.announce(id, "refresh");
  }

  /**
   * Tells the listeners that task chat thread `root` ended in the chat `row`
   * was in: its own, or with none, its owner's main chat.
   */
  private retireThread(
    row: { chatId: string | null; ownerKey?: string | null },
    root: string,
  ): void {
    const chatId = row.chatId ?? mainChatIdOf(ownerOf(row));
    for (const listener of this.threadListeners) listener({ chatId, root });
  }

  /** Listens for task chat threads that end, as when their task moves to another chat. */
  onThreadRetired(listener: (retired: ChatThreadRetired) => void): () => void {
    this.threadListeners.add(listener);
    return () => {
      this.threadListeners.delete(listener);
    };
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async get(id: string): Promise<ConciergeTaskRow | null> {
    const [row] = await this.db.select().from(conciergeTasks).where(eq(conciergeTasks.id, id));
    return row ?? null;
  }

  async getWithChat(id: string): Promise<ConciergeTaskWithChat | null> {
    const found = await this.withChat(eq(conciergeTasks.id, id));
    return found[0] ?? null;
  }

  async findBySession(sessionId: string): Promise<ConciergeTaskRow | null> {
    const [row] = await this.db
      .select()
      .from(conciergeTasks)
      .where(eq(conciergeTasks.sessionId, sessionId));
    return row ?? null;
  }

  /**
   * Moves the source message and its Concierge chat without settling task events.
   * The caller has checked that the message belongs to `chatId`.
   */
  async setSourceMessage(id: string, chatId: string, messageId: string): Promise<void> {
    const stored = chatId === CONCIERGE_CHAT_ID ? null : chatId;
    const existing = await this.get(id);
    await this.db
      .update(conciergeTasks)
      .set({
        chatId: stored,
        sourceMessageId: this.sources.idOf(chatId, messageId),
        // A chat thread stays in its chat: a row moved to another has none.
        ...(existing && existing.chatId !== stored ? { threadRoot: null } : {}),
      })
      .where(eq(conciergeTasks.id, id));
    await this.announce(id, "refresh");
    if (existing?.threadRoot && existing.chatId !== stored) {
      this.retireThread(existing, existing.threadRoot);
    }
  }

  /**
   * The title of the task whose chat thread each of `roots` names in
   * Concierge chat `chatId`, for the roots a task's thread has. A task has
   * its own thread; rows from before that share a root keep the name of the
   * oldest.
   */
  async threadTitles(chatId: string, roots: readonly string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    if (roots.length === 0) return titles;
    for (const { row, conciergeChat } of await this.withChat(
      inArray(conciergeTasks.threadRoot, [...new Set(roots)]),
    )) {
      // Oldest first, so the first title kept is the thread's own.
      if (row.threadRoot && conciergeChat.id === chatId && !titles.has(row.threadRoot)) {
        titles.set(row.threadRoot, row.title);
      }
    }
    return titles;
  }

  /**
   * The task whose chat thread starts with message `root` in Concierge chat
   * `chatId`, or null: a thread no task has is no task's
   * (docs/domains/chats.md#chat-thread).
   */
  async taskOfThread(chatId: string, root: string): Promise<{ id: string; title: string } | null> {
    for (const { row, conciergeChat } of await this.withChat(eq(conciergeTasks.threadRoot, root))) {
      if (conciergeChat.id === chatId) return { id: row.id, title: row.title };
    }
    return null;
  }

  /** The key of the message that names the row's chat thread, or null. */
  async threadRoot(id: string): Promise<string | null> {
    return (await this.get(id))?.threadRoot ?? null;
  }

  /**
   * Names the row's chat thread by message `root`, unless it already has
   * one or another row holds that root: a root is written once, and a thread
   * is one task's. One statement claims it, so of two tasks started at once
   * for one message, one gets it and the other stays without. Answers the
   * row's root after.
   */
  async setThreadRoot(id: string, root: string): Promise<string | null> {
    await this.db
      .update(conciergeTasks)
      .set({ threadRoot: root })
      .where(
        and(
          eq(conciergeTasks.id, id),
          isNull(conciergeTasks.threadRoot),
          sql`not exists (select 1 from ${conciergeTasks} as other where other.thread_root = ${root} and other.id <> ${id})`,
        ),
      );
    return this.threadRoot(id);
  }

  /**
   * The rows the panel shows: not archived, every state but the finished ones
   * whatever their age, and the finished ones completed at or after `doneSince`.
   */
  async listForPanel(doneSince: Date): Promise<ConciergeTaskWithChat[]> {
    return this.withChat(
      and(
        isNull(conciergeTasks.archivedAt),
        or(
          and(ne(conciergeTasks.state, "done"), ne(conciergeTasks.state, "dropped")),
          gte(
            sql`coalesce(${conciergeTasks.completedAt}, ${conciergeTasks.updatedAt})`,
            doneSince.getTime(),
          ),
        ),
      ),
    );
  }

  /**
   * One Concierge chat's rows that can still be doing something: not
   * archived, and either still open or finished with a task chat that was
   * active at or after `activeSince`. A finished row's chat that is resumed
   * counts, however long ago the row finished, while a finished row whose
   * chat went quiet does not, so the read stays bounded. A chat is narrowed
   * to in the query: a topic chat by the rows that name it, the main chat by
   * its owner's rows. Which chat a row belongs to is then read as the panel
   * reads it, so a row whose topic chat is archived or gone is its main chat's.
   */
  async listForConciergeChat(
    conciergeChatId: string,
    owner: string,
    activeSince: Date,
  ): Promise<ConciergeTaskWithChat[]> {
    const ofChat =
      conciergeChatId === mainChatIdOf(owner)
        ? eq(conciergeTasks.ownerKey, owner)
        : eq(conciergeTasks.chatId, conciergeChatId);
    const rows = await this.withChat(
      and(
        ofChat,
        isNull(conciergeTasks.archivedAt),
        or(
          and(ne(conciergeTasks.state, "done"), ne(conciergeTasks.state, "dropped")),
          gte(romeSessions.activityAt, activeSince),
        ),
      ),
    );
    return rows.filter((task) => task.conciergeChat.id === conciergeChatId);
  }

  /** The Concierge's own view: not archived, finished rows only on request. */
  async listForAgent(includeDone: boolean): Promise<ConciergeTaskWithChat[]> {
    const open = and(ne(conciergeTasks.state, "done"), ne(conciergeTasks.state, "dropped"));
    return this.withChat(and(isNull(conciergeTasks.archivedAt), includeDone ? undefined : open));
  }

  /**
   * Rows whose task chat was active after the row was last written: the
   * changes a restart may have dropped from memory.
   */
  async listBehindTheirChat(): Promise<ConciergeTaskRow[]> {
    const rows = await this.db
      .select({ task: conciergeTasks })
      .from(conciergeTasks)
      .innerJoin(romeSessions, eq(romeSessions.id, conciergeTasks.sessionId))
      .where(
        and(
          isNull(conciergeTasks.archivedAt),
          sql`cast(${romeSessions.activityAt} as integer) * 1000 > cast(${conciergeTasks.updatedAt} as integer)`,
        ),
      );
    return rows.map((row) => row.task);
  }

  /**
   * Writes a batch in one transaction: all of it or none. Answers the written
   * rows in the order given and tells the change listeners once it is stored.
   */
  async upsertMany(writes: ConciergeTaskWrite[], now = new Date()): Promise<ConciergeTaskRow[]> {
    // `transaction` is synchronous on better-sqlite3, so the body uses `.run()`
    // and `.all()` and never awaits.
    const retired: { row: ConciergeTaskRow; root: string }[] = [];
    const written = await this.db.transaction((tx) => {
      const out: ConciergeTaskRow[] = [];
      for (const write of writes) {
        const existing = write.id
          ? (tx.select().from(conciergeTasks).where(eq(conciergeTasks.id, write.id)).get() ?? null)
          : null;
        if (write.id && !existing) throw new Error(`No task ${write.id}`);
        // A row links one task chat in its life: the chat it ran in is its
        // history, so another chat is another task.
        if (existing?.linkedAt && write.sessionId && write.sessionId !== existing.sessionId) {
          throw new Error(`Task ${existing.id} already had a task chat. Start a new task instead.`);
        }
        if (write.sessionId) {
          const taken = tx
            .select({ id: conciergeTasks.id })
            .from(conciergeTasks)
            .where(
              and(
                eq(conciergeTasks.sessionId, write.sessionId),
                existing ? ne(conciergeTasks.id, existing.id) : undefined,
              ),
            )
            .get();
          if (taken)
            throw new Error(`Chat ${write.sessionId} is already linked to task ${taken.id}`);
        }
        const state = write.state ?? existing?.state ?? "next";
        const archivedAt =
          write.archived === undefined
            ? (existing?.archivedAt ?? null)
            : write.archived
              ? (existing?.archivedAt ?? now)
              : null;
        const completedAt = isFinished(state) ? (existing?.completedAt ?? now) : null;
        const chatId = write.chatId !== undefined ? write.chatId : (existing?.chatId ?? null);
        if (
          existing?.threadRoot &&
          (existing.chatId ?? null) !== (chatId === CONCIERGE_CHAT_ID ? null : chatId)
        ) {
          retired.push({ row: existing, root: existing.threadRoot });
        }
        const fields = {
          title: write.title ?? existing?.title ?? "",
          state,
          summary: write.summary !== undefined ? write.summary : (existing?.summary ?? null),
          note: write.note !== undefined ? write.note : (existing?.note ?? null),
          waitingOn:
            write.waitingOn !== undefined ? write.waitingOn : (existing?.waitingOn ?? null),
          dueAt: write.dueAt !== undefined ? write.dueAt : (existing?.dueAt ?? null),
          rank: write.rank !== undefined ? write.rank : (existing?.rank ?? null),
          sessionId:
            write.sessionId !== undefined ? write.sessionId : (existing?.sessionId ?? null),
          chatId: chatId === CONCIERGE_CHAT_ID ? null : chatId,
          // Written once; a row moved to another Concierge chat has none.
          threadRoot:
            existing && (existing.chatId ?? null) !== (chatId === CONCIERGE_CHAT_ID ? null : chatId)
              ? null
              : (existing?.threadRoot ?? write.threadRoot ?? null),
          sourceMessageId:
            write.sourceMessageId !== undefined
              ? write.sourceMessageId === null
                ? null
                : this.sources.idOf(chatId ?? CONCIERGE_CHAT_ID, write.sourceMessageId)
              : (existing?.sourceMessageId ?? null),
          updatedAt: now,
          completedAt,
          archivedAt,
          linkedAt: existing?.linkedAt ?? (write.sessionId ? now : null),
        };
        if (existing) {
          const [row] = tx
            .update(conciergeTasks)
            .set(fields)
            .where(eq(conciergeTasks.id, existing.id))
            .returning()
            .all();
          out.push(row);
        } else {
          if (!fields.title) throw new Error("A new task needs a title");
          // A row is the owner's of the chat it is made in, for good: it stays
          // theirs after that chat is archived or deleted. A chat that cannot
          // be found names no owner, so the row is not made: it never
          // defaults to the guardian's list.
          let ownerKey = GUARDIAN_OWNER;
          if (fields.chatId) {
            const origin = tx
              .select({ ownerKey: romeSessions.ownerKey })
              .from(romeSessions)
              .where(eq(romeSessions.id, fields.chatId))
              .get();
            if (!origin) throw new Error(`No Concierge chat ${fields.chatId}`);
            ownerKey = ownerOf(origin);
          }
          const [row] = tx
            .insert(conciergeTasks)
            .values({ id: randomUUID(), createdAt: now, ownerKey, ...fields })
            .returning()
            .all();
          out.push(row);
        }
      }
      return out;
    });
    for (const row of written) await this.announce(row.id, "write");
    for (const { row, root } of retired) this.retireThread(row, root);
    return written;
  }

  /** Listens for a change of the facts a guardian message's status reaction reads. */
  onMessageChange(listener: (target: ReactionTarget) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  private messageChanged(targets: Iterable<ReactionTarget>): void {
    const seen = new Set<string>();
    for (const target of targets) {
      const key = `${target.chatId}\u0000${target.messageKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const listener of this.messageListeners) listener(target);
    }
  }

  /** Concierge turn `turnId` took guardian message `target`: it works on it until it answers. */
  async takeMessage(turnId: string, target: ReactionTarget, now = new Date()): Promise<void> {
    await this.db
      .insert(conciergeMessageTurns)
      .values({ ...target, turnId, takenAt: now, answeredAt: null })
      .onConflictDoUpdate({
        target: [conciergeMessageTurns.chatId, conciergeMessageTurns.messageKey],
        set: { turnId, takenAt: now, answeredAt: null },
      });
    this.messageChanged([target]);
  }

  /**
   * A turn of Concierge chat `chatId` ended: every message a turn no longer
   * running took is answered. A message handed on to a turn in `running`
   * stays open until that one ends. Answers how many changed.
   */
  async answerTurns(chatId: string, running: readonly string[], now = new Date()): Promise<number> {
    const changed = await this.db
      .update(conciergeMessageTurns)
      .set({ answeredAt: now })
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          isNull(conciergeMessageTurns.answeredAt),
          running.length > 0 ? notInArray(conciergeMessageTurns.turnId, [...running]) : undefined,
        ),
      )
      .returning({
        chatId: conciergeMessageTurns.chatId,
        messageKey: conciergeMessageTurns.messageKey,
      });
    this.messageChanged(changed);
    return changed.length;
  }

  /** The Concierge answered guardian message `messageKey` of chat `chatId`, as with `say`. */
  async answerMessage(chatId: string, messageKey: string, now = new Date()): Promise<number> {
    const changed = await this.db
      .update(conciergeMessageTurns)
      .set({ answeredAt: now })
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          eq(conciergeMessageTurns.messageKey, messageKey),
          isNull(conciergeMessageTurns.answeredAt),
        ),
      )
      .returning({
        chatId: conciergeMessageTurns.chatId,
        messageKey: conciergeMessageTurns.messageKey,
      });
    this.messageChanged(changed);
    return changed.length;
  }

  /**
   * Turn `turnId` of Concierge chat `chatId` runs again, as when a usage limit
   * cleared: every message it holds, its own and the ones handed on to it,
   * is open again until it ends.
   */
  async reopenTurn(chatId: string, turnId: string): Promise<number> {
    const changed = await this.db
      .update(conciergeMessageTurns)
      .set({ answeredAt: null })
      .where(
        and(eq(conciergeMessageTurns.chatId, chatId), eq(conciergeMessageTurns.turnId, turnId)),
      )
      .returning({
        chatId: conciergeMessageTurns.chatId,
        messageKey: conciergeMessageTurns.messageKey,
      });
    this.messageChanged(changed);
    return changed.length;
  }

  /**
   * After a restart, before any turn runs: a stopped process ends no turn, so
   * every message still open is answered, except in `continuing`, the chats
   * whose interrupted turn startup continues, whose turn answers them when it
   * ends. No mark outlives the process that set it. Answers how many changed.
   */
  async answerInterrupted(continuing: ReadonlySet<string>, now = new Date()): Promise<number> {
    const open = await this.db
      .select({
        chatId: conciergeMessageTurns.chatId,
        messageKey: conciergeMessageTurns.messageKey,
      })
      .from(conciergeMessageTurns)
      .where(isNull(conciergeMessageTurns.answeredAt));
    const ending = open.filter((row) => !continuing.has(row.chatId));
    for (const row of ending) {
      await this.db
        .update(conciergeMessageTurns)
        .set({ answeredAt: now })
        .where(
          and(
            eq(conciergeMessageTurns.chatId, row.chatId),
            eq(conciergeMessageTurns.messageKey, row.messageKey),
          ),
        );
    }
    this.messageChanged(ending);
    return ending.length;
  }

  /** Task `taskId` was made for guardian message `target`: started for it, or given its words. */
  async linkMessage(taskId: string, target: ReactionTarget): Promise<void> {
    await this.db
      .insert(conciergeMessageTasks)
      .values({ taskId, ...target })
      .onConflictDoNothing();
    this.messageChanged([target]);
  }

  /** Takes back {@link linkMessage}, as when the task never heard the message. */
  async unlinkMessage(taskId: string, target: ReactionTarget): Promise<void> {
    await this.db
      .delete(conciergeMessageTasks)
      .where(
        and(
          eq(conciergeMessageTasks.taskId, taskId),
          eq(conciergeMessageTasks.chatId, target.chatId),
          eq(conciergeMessageTasks.messageKey, target.messageKey),
        ),
      );
    this.messageChanged([target]);
  }

  /** The guardian messages task `taskId` was made for. */
  async messagesOfTask(taskId: string): Promise<ReactionTarget[]> {
    return this.db
      .select({
        chatId: conciergeMessageTasks.chatId,
        messageKey: conciergeMessageTasks.messageKey,
      })
      .from(conciergeMessageTasks)
      .where(eq(conciergeMessageTasks.taskId, taskId));
  }

  /** Forgets every mark fact of Concierge chat `chatId`, once the chat is deleted. */
  async forgetMessages(chatId: string): Promise<void> {
    await this.db.delete(conciergeMessageTurns).where(eq(conciergeMessageTurns.chatId, chatId));
    await this.db.delete(conciergeMessageTasks).where(eq(conciergeMessageTasks.chatId, chatId));
  }

  /** The stored mark facts of each of `messageKeys` in Concierge chat `chatId` that has any. */
  async messageMarks(
    chatId: string,
    messageKeys: readonly string[],
  ): Promise<Map<string, MessageMarkRow>> {
    const out = new Map<string, MessageMarkRow>();
    if (messageKeys.length === 0) return out;
    const keys = [...new Set(messageKeys)];
    const of = (key: string) => {
      const found = out.get(key) ?? { answered: null, taskIds: [] };
      out.set(key, found);
      return found;
    };
    for (const row of await this.db
      .select({
        messageKey: conciergeMessageTurns.messageKey,
        answeredAt: conciergeMessageTurns.answeredAt,
      })
      .from(conciergeMessageTurns)
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          inArray(conciergeMessageTurns.messageKey, keys),
        ),
      )) {
      of(row.messageKey).answered = row.answeredAt !== null;
    }
    for (const row of await this.db
      .select({
        messageKey: conciergeMessageTasks.messageKey,
        taskId: conciergeMessageTasks.taskId,
      })
      .from(conciergeMessageTasks)
      .where(
        and(
          eq(conciergeMessageTasks.chatId, chatId),
          inArray(conciergeMessageTasks.messageKey, keys),
        ),
      )) {
      of(row.messageKey).taskIds.push(row.taskId);
    }
    return out;
  }

  /** The tasks whose task chat's result the Concierge has not reported yet. */
  async tasksWithUnsaidOutcome(): Promise<string[]> {
    const rows = await this.db
      .select({ id: conciergeTasks.id })
      .from(conciergeTasks)
      .where(eq(conciergeTasks.outcomeUnsaid, true));
    return rows.map((row) => row.id);
  }

  /** The Concierge reported the results of `taskIds`, or Rome gave up telling it. */
  async markReported(taskIds: readonly string[]): Promise<void> {
    if (taskIds.length === 0) return;
    const reported = await this.db
      .update(conciergeTasks)
      .set({ outcomeUnsaid: false })
      .where(and(inArray(conciergeTasks.id, [...taskIds]), eq(conciergeTasks.outcomeUnsaid, true)))
      .returning({ id: conciergeTasks.id });
    for (const { id } of reported) await this.announce(id, "refresh");
  }

  private async announce(id: string, change: ChangeKind): Promise<void> {
    const task = await this.getWithChat(id);
    if (!task) return;
    for (const listener of this.listeners) listener(task, change);
  }

  /** Tells the change listeners about a row again, for state kept outside it. */
  async reannounce(id: string): Promise<void> {
    await this.announce(id, "refresh");
  }

  private async withChat(where: SQL | undefined): Promise<ConciergeTaskWithChat[]> {
    const origin = alias(romeSessions, "origin");
    const rows = await this.db
      .select({
        task: conciergeTasks,
        chatName: romeSessions.name,
        originName: origin.name,
        originArchivedAt: origin.archivedAt,
      })
      .from(conciergeTasks)
      .leftJoin(romeSessions, eq(romeSessions.id, conciergeTasks.sessionId))
      .leftJoin(origin, eq(origin.id, conciergeTasks.chatId))
      .where(where)
      .orderBy(asc(conciergeTasks.createdAt), desc(conciergeTasks.id));
    // A row whose chat is archived or gone belongs to its owner's main chat,
    // so its buttons and results reach a chat that owner can write in. The
    // owner is the row's own, never read from a chat that may be gone.
    type Origin = {
      originName: string | null;
      originArchivedAt: Date | null;
    };
    const ownerOfRow = (task: ConciergeTaskRow) => ownerOf(task);
    const mainIds = [...new Set(rows.map((row) => mainChatIdOf(ownerOfRow(row.task))))];
    const mainNames = new Map(
      mainIds.length > 0
        ? (
            await this.db
              .select({ id: romeSessions.id, name: romeSessions.name })
              .from(romeSessions)
              .where(inArray(romeSessions.id, mainIds))
          ).map((row) => [row.id, row.name] as const)
        : [],
    );
    const conciergeChatOf = (task: ConciergeTaskRow, origin: Origin) => {
      const owner = ownerOfRow(task);
      const main = mainChatIdOf(owner);
      return task.chatId && origin.originName !== null && origin.originArchivedAt === null
        ? { id: task.chatId, name: origin.originName, main: task.chatId === main }
        : { id: main, name: mainNames.get(main) ?? MAIN_CHAT_NAME, main: true };
    };
    // Only a message the row's Concierge chat still holds counts as a source.
    const sources = this.sources.keysOf(
      rows.flatMap((row) =>
        row.task.sourceMessageId
          ? [{ id: row.task.sourceMessageId, chatId: conciergeChatOf(row.task, row).id }]
          : [],
      ),
    );
    return rows.map((origin) => ({
      row: origin.task,
      chat:
        origin.task.sessionId && origin.chatName !== null
          ? { id: origin.task.sessionId, name: origin.chatName }
          : null,
      conciergeChat: conciergeChatOf(origin.task, origin),
      owner: ownerOfRow(origin.task),
      sourceMessageId:
        (origin.task.sourceMessageId && sources.get(origin.task.sourceMessageId)) || null,
    }));
  }
}

/** A Concierge chat's messages by their key there, and back. */
export interface TaskSources {
  /** The id of the message keyed `key` in Concierge chat `chatId`, or null when it holds none. */
  idOf(chatId: string, key: string): number | null;
  /** The key of each message that its Concierge chat still holds. */
  keysOf(refs: readonly { id: number; chatId: string }[]): Map<number, string>;
}

/** The Concierge chats' messages as Chats holds them. */
function conciergeChatSources(db: DrizzleDb): TaskSources {
  const messages = new MessageRepository(db);
  const chatsOf = (ids: readonly string[]): Map<string, ChatRef> => {
    if (ids.length === 0) return new Map();
    const rows = db
      .select({
        id: romeSessions.id,
        chatId: romeSessions.chatId,
        platform: romeSessions.chatPlatform,
      })
      .from(romeSessions)
      .where(inArray(romeSessions.id, [...new Set(ids)]))
      .all();
    return new Map(
      rows.flatMap((row) =>
        row.chatId && row.platform ? [[row.id, { platform: row.platform, id: row.chatId }]] : [],
      ),
    );
  };
  return {
    idOf(chatId, key) {
      const at = chatsOf([chatId]).get(chatId);
      return at ? messages.idOf(at, key) : null;
    },
    keysOf(refs) {
      const chats = chatsOf(refs.map((ref) => ref.chatId));
      const chatOf = new Map(refs.map((ref) => [ref.id, chats.get(ref.chatId)?.id]));
      return new Map(
        messages
          .byIds(refs.map((ref) => ref.id))
          .filter((message) => message.place.chat.id === chatOf.get(message.id))
          .map((message) => [message.id, message.key]),
      );
    },
  };
}
