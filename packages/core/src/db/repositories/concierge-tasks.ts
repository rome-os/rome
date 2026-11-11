import { randomUUID } from "node:crypto";
import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DrizzleDb } from "../index.js";
import type { ChatRef } from "../../chats/storage/place.js";
import { MessageRepository } from "../../chats/storage/message-repository.js";
import { MAIN_CHAT_NAME, mainChatIdOf } from "../../concierge/main-chat.js";
import { GUARDIAN_OWNER, ownerOf } from "../../webchat/owner.js";
import type { ConciergeStatusReaction } from "@rome/api-types/concierge";
import { createLogger } from "../../logger.js";
import { conciergeTaskReactions, conciergeTasks, romeSessions } from "../schema.js";

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

/**
 * How one task's work for a message stands. A stopped task counts toward no
 * reaction (docs/domains/chats.md#status-reaction).
 */
export type TaskReactionState = ConciergeStatusReaction | "stopped";

/** How a task's work for its messages ends. */
export type TaskReactionEnd = Exclude<TaskReactionState, "working">;

/** A message's status reaction changed; null when it has none now. */
export type ReactionListener = (
  target: ReactionTarget,
  reaction: ConciergeStatusReaction | null,
) => void;

/**
 * One reaction for a message from the work of every task it started or was
 * passed on to that was not stopped: working while any of them works, then
 * failed when any failed, else done. None when every one was stopped.
 */
export function reactionOf(states: readonly TaskReactionState[]): ConciergeStatusReaction | null {
  const counted = states.filter((state) => state !== "stopped");
  if (counted.length === 0) return null;
  if (counted.includes("working")) return "working";
  return counted.includes("failed") ? "failed" : "done";
}

/**
 * The Concierge's todo list. Only the Concierge's tools write it; every write
 * tells the change listeners, which push the row to the panel and settle the
 * task events the Concierge owed for it.
 */
export class ConciergeTasksRepository {
  private listeners = new Set<ChangeListener>();
  private reactionListeners = new Set<ReactionListener>();

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
   * Moves the unfinished rows of Concierge chat `from` to its owner's main
   * chat `to` (null for the guardian's), as when that chat is archived or
   * deleted. Finished rows keep their chat, and every row keeps its owner.
   * Every row of the chat loses its chat thread. Answers how many moved.
   */
  async moveToMainChat(from: string, to: string | null = null): Promise<number> {
    // Every row of the chat is its main chat's from now on, the finished ones
    // too, and a chat thread stays in the chat it is in.
    await this.db
      .update(conciergeTasks)
      .set({ threadRoot: null })
      .where(eq(conciergeTasks.chatId, from));
    const moved = await this.db
      .update(conciergeTasks)
      .set({ chatId: to })
      .where(
        and(
          eq(conciergeTasks.chatId, from),
          ne(conciergeTasks.state, "done"),
          ne(conciergeTasks.state, "dropped"),
        ),
      )
      .returning({ id: conciergeTasks.id });
    for (const { id } of moved) await this.announce(id, "refresh");
    return moved.length;
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
  }

  /**
   * The title of the task whose chat thread each of `roots` names in
   * Concierge chat `chatId`, for the roots a task's thread has. A task
   * started from a message in another task's thread shares it, and the
   * thread keeps the name of the task that started it: the oldest.
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

  /** The key of the message that names the row's chat thread, or null. */
  async threadRoot(id: string): Promise<string | null> {
    return (await this.get(id))?.threadRoot ?? null;
  }

  /**
   * Names the row's chat thread by message `root`, unless it already has
   * one: a root is written once. Answers the row's root after.
   */
  async setThreadRoot(id: string, root: string): Promise<string | null> {
    await this.db
      .update(conciergeTasks)
      .set({ threadRoot: root })
      .where(and(eq(conciergeTasks.id, id), isNull(conciergeTasks.threadRoot)));
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
    // Rows the Concierge just marked done or dropped settle the messages
    // still working for them, as a task that ends does. A dropped task was
    // called off, not failed, so it counts as stopped.
    const settled: { taskId: string; state: TaskReactionEnd }[] = [];
    const written = await this.db.transaction((tx) => {
      const out: ConciergeTaskRow[] = [];
      for (const write of writes) {
        const existing = write.id
          ? (tx.select().from(conciergeTasks).where(eq(conciergeTasks.id, write.id)).get() ?? null)
          : null;
        if (write.id && !existing) throw new Error(`No task ${write.id}`);
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
        if (existing && !isFinished(existing.state) && isFinished(state)) {
          settled.push({ taskId: existing.id, state: state === "done" ? "done" : "stopped" });
        }
        const archivedAt =
          write.archived === undefined
            ? (existing?.archivedAt ?? null)
            : write.archived
              ? (existing?.archivedAt ?? now)
              : null;
        const completedAt = isFinished(state) ? (existing?.completedAt ?? now) : null;
        const chatId = write.chatId !== undefined ? write.chatId : (existing?.chatId ?? null);
        const fields = {
          title: write.title ?? existing?.title ?? "",
          state,
          summary: write.summary !== undefined ? write.summary : (existing?.summary ?? null),
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
          // theirs after that chat is archived or deleted.
          const ownerKey = fields.chatId
            ? (tx
                .select({ ownerKey: romeSessions.ownerKey })
                .from(romeSessions)
                .where(eq(romeSessions.id, fields.chatId))
                .get()?.ownerKey ?? GUARDIAN_OWNER)
            : GUARDIAN_OWNER;
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
    // The rows are written; a reaction that fails to settle fails no write.
    for (const { taskId, state } of settled) {
      await this.settleReactions(taskId, state).catch((error: unknown) =>
        log.warn("failed to settle status reactions", {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return written;
  }

  onReaction(listener: ReactionListener): () => void {
    this.reactionListeners.add(listener);
    return () => {
      this.reactionListeners.delete(listener);
    };
  }

  /**
   * Marks guardian message `target` as worked on by task `taskId`, as when the
   * task starts for it or its words are passed on to the task. Marked again,
   * it works again.
   */
  async markWorking(taskId: string, target: ReactionTarget, now = new Date()): Promise<void> {
    await this.db
      .insert(conciergeTaskReactions)
      .values({ taskId, ...target, state: "working", updatedAt: now })
      .onConflictDoUpdate({
        target: [
          conciergeTaskReactions.taskId,
          conciergeTaskReactions.chatId,
          conciergeTaskReactions.messageKey,
        ],
        set: { state: "working", updatedAt: now },
      });
    await this.announceReaction(target);
  }

  /** Takes back a mark whose work never reached the task. */
  async unmark(taskId: string, target: ReactionTarget): Promise<void> {
    await this.db
      .delete(conciergeTaskReactions)
      .where(
        and(
          eq(conciergeTaskReactions.taskId, taskId),
          eq(conciergeTaskReactions.chatId, target.chatId),
          eq(conciergeTaskReactions.messageKey, target.messageKey),
        ),
      );
    await this.announceReaction(target);
  }

  /** Settles every message still working for task `taskId`. Answers how many changed. */
  async settleReactions(taskId: string, state: TaskReactionEnd, now = new Date()): Promise<number> {
    const changed = await this.db
      .update(conciergeTaskReactions)
      .set({ state, updatedAt: now })
      .where(
        and(eq(conciergeTaskReactions.taskId, taskId), eq(conciergeTaskReactions.state, "working")),
      )
      .returning({
        chatId: conciergeTaskReactions.chatId,
        messageKey: conciergeTaskReactions.messageKey,
      });
    for (const target of changed) await this.announceReaction(target);
    return changed.length;
  }

  /** The status reaction of each of `messageKeys` in Concierge chat `chatId` that has one. */
  async reactionsOf(
    chatId: string,
    messageKeys: readonly string[],
  ): Promise<Map<string, ConciergeStatusReaction>> {
    const out = new Map<string, ConciergeStatusReaction>();
    if (messageKeys.length === 0) return out;
    const rows = await this.db
      .select({
        messageKey: conciergeTaskReactions.messageKey,
        state: conciergeTaskReactions.state,
      })
      .from(conciergeTaskReactions)
      .where(
        and(
          eq(conciergeTaskReactions.chatId, chatId),
          inArray(conciergeTaskReactions.messageKey, [...new Set(messageKeys)]),
        ),
      );
    const states = new Map<string, TaskReactionState[]>();
    for (const row of rows) {
      states.set(row.messageKey, [...(states.get(row.messageKey) ?? []), row.state]);
    }
    for (const [key, list] of states) {
      const reaction = reactionOf(list);
      if (reaction) out.set(key, reaction);
    }
    return out;
  }

  private async announceReaction(target: ReactionTarget): Promise<void> {
    if (this.reactionListeners.size === 0) return;
    const reaction =
      (await this.reactionsOf(target.chatId, [target.messageKey])).get(target.messageKey) ?? null;
    for (const listener of this.reactionListeners) listener(target, reaction);
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
