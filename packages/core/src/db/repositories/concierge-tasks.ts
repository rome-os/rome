import { randomUUID } from "node:crypto";
import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
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
import { createLogger } from "../../logger.js";
import { CHAT_MESSAGES } from "../../chats/storage/messages-sql.js";
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
  archived?: boolean;
}

/** `write`: settles the task events owed for the row. `refresh`: tells readers
 *  without settling those events. */
type ChangeKind = "write" | "refresh";
type ChangeListener = (task: ConciergeTaskWithChat, change: ChangeKind) => void;

const isFinished = (state: ConciergeTaskState) => state === "done" || state === "dropped";

/** A guardian message in a Concierge chat, by its key there. */
export interface MessageTarget {
  chatId: string;
  messageKey: string;
}

/** How a link that a newer message took over over ends: settled, showing nothing. */
export const LINK_SUPERSEDED = "superseded";

/** What {@link ConciergeTasksRepository.linkMessage} changed, to put back. */
export interface LinkUndo {
  /** The message's own link as it stood, or null when it is new. */
  before: { seq: number; endedAs: string | null } | null;
  /** The links it superseded. */
  superseded: MessageTarget[];
}

/** What a guardian message's status is derived from, as stored. */
export interface MessageMarkRow {
  /** Whether the turn that took it answered it; null when no turn took it. */
  answered: boolean | null;
  /** Whether that turn showed it working. */
  working: boolean;
  /** Whether that turn reacted to it. */
  reacted: boolean;
  /** Whether that turn failed, by an error or a crash, before it answered it. */
  turnFailed: boolean;
  /** The tasks it follows: its live links. */
  taskIds: string[];
  /** The tasks made for it that a newer message took over. */
  earlierTaskIds: string[];
  /** How each task made for it ended for it, once it did with its result told. */
  endedAs: string[];
}

/**
 * The Concierge's todo list. Only the Concierge's tools write it; every write
 * tells the change listeners, which push the row to the panel and settle the
 * task events the Concierge owed for it.
 */
export class ConciergeTasksRepository {
  private listeners = new Set<ChangeListener>();
  private messageListeners = new Set<(target: MessageTarget) => void>();

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
   * and read as its owner's main chat's from now on, so none is moved.
   * Answers how many rows are open.
   */
  async leaveChat(
    chatId: string,
    isOpen: (rows: ConciergeTaskRow[]) => Promise<Set<string>>,
  ): Promise<number> {
    const rows = await this.db
      .select()
      .from(conciergeTasks)
      .where(and(eq(conciergeTasks.chatId, chatId), isNull(conciergeTasks.archivedAt)));
    const openIds = await isOpen(rows);
    const open = rows.filter((row) => openIds.has(row.id));
    for (const { id } of open) await this.announce(id, "refresh");
    return open.length;
  }

  /**
   * Task chat `chatId` is archived or deleted: the row of `owner` that links
   * the chat is archived, in the one transaction that `alsoIn` archives or
   * deletes the chat in, and stopped for that reason when `stop` says the
   * task is still open. A task that already ended keeps how it ended.
   * Answers the row, or null when the chat links no row of `owner`; the chat
   * is archived or deleted either way.
   */
  async endWithChat(
    chatId: string,
    owner: string,
    end: "archived" | "deleted",
    alsoIn: (tx: DrizzleTx) => void,
    now = new Date(),
    stop = true,
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
              stoppedAt: own.stoppedAt ?? (stop ? now : null),
              stopReason: own.stopReason ?? (stop ? end : null),
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
   * Task `id` is archived on its own, with no task chat to archive it with:
   * it leaves the task list, and no chat brings it back. An archived row
   * keeps when it was archived.
   */
  async archive(id: string, now = new Date()): Promise<void> {
    const archived = await this.db
      .update(conciergeTasks)
      .set({ archivedAt: now, archivedWithChat: false, updatedAt: now })
      .where(and(eq(conciergeTasks.id, id), isNull(conciergeTasks.archivedAt)))
      .returning({ id: conciergeTasks.id });
    if (archived.length > 0) await this.announce(id, "refresh");
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

  /**
   * Task `id`'s summary, from the result its task chat just gave: Rome keeps
   * a finished task's line current. A summary the Concierge writes after
   * this replaces it, as any write does.
   */
  async setResultSummary(id: string, summary: string, now = new Date()): Promise<void> {
    await this.db
      .update(conciergeTasks)
      .set({ summary, updatedAt: now })
      .where(eq(conciergeTasks.id, id));
    await this.announce(id, "refresh");
  }

  /** How task `id`'s task chat's latest work ended. Rome writes it; the Concierge never does. */
  async setLastOutcome(
    id: string,
    outcome: "succeeded" | "failed" | "stopped",
    now = new Date(),
    options: { reported?: boolean } = {},
  ): Promise<void> {
    await this.db
      .update(conciergeTasks)
      // A result waits for the Concierge's report; a stop has none to give.
      .set({
        lastOutcome: outcome,
        // Only a result the Concierge will be told of waits for its report.
        outcomeUnsaid: outcome !== "stopped" && options.reported !== false,
        reportGivenUp: false,
        updatedAt: now,
      })
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

  /** The rows of `ids` that exist, in one read. */
  async getMany(ids: readonly string[]): Promise<ConciergeTaskRow[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(conciergeTasks)
      .where(inArray(conciergeTasks.id, [...ids]));
  }

  async getWithChat(id: string): Promise<ConciergeTaskWithChat | null> {
    const found = await this.withChat(eq(conciergeTasks.id, id));
    return found[0] ?? null;
  }

  /** The rows of the task chats `sessionIds`, in one read. */
  async findBySessions(sessionIds: readonly string[]): Promise<ConciergeTaskRow[]> {
    if (sessionIds.length === 0) return [];
    return this.db
      .select()
      .from(conciergeTasks)
      .where(inArray(conciergeTasks.sessionId, [...new Set(sessionIds)]));
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
    await this.db
      .update(conciergeTasks)
      .set({ chatId: stored, sourceMessageId: this.sources.idOf(chatId, messageId) })
      .where(eq(conciergeTasks.id, id));
    await this.announce(id, "refresh");
  }

  /**
   * The newest task started in each chat thread of `roots` in Concierge chat
   * `chatId`: the one whose start message is in the thread. The roots are the
   * keys of the threads' first messages; a thread no task started in is left
   * out.
   */
  async threadTasks(
    chatId: string,
    roots: readonly string[],
  ): Promise<Map<string, { id: string; title: string }>> {
    const tasks = new Map<string, { id: string; title: string }>();
    if (roots.length === 0) return tasks;
    const rows = this.db.all<{ root: string; id: string; title: string }>(sql`
      SELECT r.key AS root, t.id, t.title
      FROM ${CHAT_MESSAGES} r
      JOIN ${CHAT_MESSAGES} s ON s.chat_id = r.chat_id
        AND (s.id = r.id OR s.root_message_id = r.id)
      JOIN concierge_tasks t ON t.source_message_id = s.id
      WHERE r.chat_id = (SELECT chat_id FROM rome_sessions WHERE id = ${chatId})
        AND r.key IN (SELECT value FROM json_each(${JSON.stringify([...new Set(roots)])}))
      ORDER BY t.created_at, t.id
    `);
    // Oldest first, so the last one kept is the newest.
    for (const row of rows) tasks.set(row.root, { id: row.id, title: row.title });
    return tasks;
  }

  /**
   * The rows the panel shows: not archived, every state but the finished ones
   * whatever their age, and the finished ones completed at or after `doneSince`.
   */
  async listForPanel(doneSince: Date): Promise<ConciergeTaskWithChat[]> {
    return this.withChat(
      and(
        isNull(conciergeTasks.archivedAt),
        // Open, or ended inside the window, as its derived status read it.
        or(isNull(conciergeTasks.endedAt), gte(conciergeTasks.endedAt, doneSince)),
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
        or(isNull(conciergeTasks.endedAt), gte(romeSessions.activityAt, activeSince)),
      ),
    );
    return rows.filter((task) => task.conciergeChat.id === conciergeChatId);
  }

  /**
   * Which of chats `chatIds` are task chats of `owner`'s Concierge chat
   * `conciergeChatId`, each with its task, ended or archived included. One
   * read by the task chat's index, of the few columns it needs. A row
   * belongs to the chat as the panel reads it, so a row whose topic chat is
   * archived or gone is its main chat's.
   */
  async taskChatsAmong(
    chatIds: readonly string[],
    conciergeChatId: string,
    owner: string,
  ): Promise<Array<{ chatId: string; task: { id: string; title: string } }>> {
    if (chatIds.length === 0) return [];
    const origin = alias(romeSessions, "origin");
    const rows = await this.db
      .select({
        id: conciergeTasks.id,
        title: conciergeTasks.title,
        sessionId: conciergeTasks.sessionId,
        chatId: conciergeTasks.chatId,
        originId: origin.id,
        originArchivedAt: origin.archivedAt,
      })
      .from(conciergeTasks)
      .leftJoin(origin, eq(origin.id, conciergeTasks.chatId))
      .where(
        and(
          isNotNull(conciergeTasks.sessionId),
          inArray(conciergeTasks.sessionId, [...new Set(chatIds)]),
          eq(conciergeTasks.ownerKey, owner),
        ),
      );
    const main = mainChatIdOf(owner);
    return rows.flatMap((row) => {
      const chat =
        row.chatId && row.originId !== null && row.originArchivedAt === null ? row.chatId : main;
      return chat === conciergeChatId && row.sessionId
        ? [{ chatId: row.sessionId, task: { id: row.id, title: row.title } }]
        : [];
    });
  }

  /** The Concierge's own view: not archived, finished rows only on request. */
  async listForAgent(includeDone: boolean): Promise<ConciergeTaskWithChat[]> {
    return this.withChat(
      and(
        isNull(conciergeTasks.archivedAt),
        includeDone ? undefined : isNull(conciergeTasks.endedAt),
      ),
    );
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
    return written;
  }

  /** Listens for a change of the facts a guardian message's status reads. */
  onMessageChange(listener: (target: MessageTarget) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  private messageChanged(targets: Iterable<MessageTarget>): void {
    const seen = new Set<string>();
    for (const target of targets) {
      const key = `${target.chatId}\u0000${target.messageKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const listener of this.messageListeners) listener(target);
    }
  }

  /**
   * Concierge turn `turnId` took guardian message `target`: it works on it
   * until it answers. A message handed on while it shows working keeps
   * showing it, so 👀 does not blink between the two turns.
   */
  async takeMessage(turnId: string, target: MessageTarget, now = new Date()): Promise<void> {
    await this.db
      .insert(conciergeMessageTurns)
      .values({ ...target, turnId, takenAt: now, answeredAt: null })
      .onConflictDoUpdate({
        target: [conciergeMessageTurns.chatId, conciergeMessageTurns.messageKey],
        set: {
          turnId,
          takenAt: now,
          answeredAt: null,
          turnFailed: false,
          // The right side reads the row as it was: a message handed on keeps
          // what its turn showed. Its reaction stays on it either way.
          workingAt: sql`CASE WHEN ${conciergeMessageTurns.answeredAt} IS NULL THEN ${conciergeMessageTurns.workingAt} END`,
        },
      });
    this.messageChanged([target]);
  }

  /**
   * The open messages of Concierge chat `chatId` show working from now: a
   * working tool its turn called ran half a second, or it made a second one.
   * A message the turn reacted
   * to is left out, and so are those of `except`. Answers the ones that
   * changed.
   */
  async markWorking(
    chatId: string,
    options: { except?: readonly string[] } = {},
    now = new Date(),
  ): Promise<MessageTarget[]> {
    const changed = await this.db
      .update(conciergeMessageTurns)
      .set({ workingAt: now })
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          isNull(conciergeMessageTurns.answeredAt),
          isNull(conciergeMessageTurns.workingAt),
          eq(conciergeMessageTurns.reacted, false),
          options.except?.length
            ? notInArray(conciergeMessageTurns.messageKey, [...options.except])
            : undefined,
        ),
      )
      .returning({
        chatId: conciergeMessageTurns.chatId,
        messageKey: conciergeMessageTurns.messageKey,
      });
    this.messageChanged(changed);
    return changed;
  }

  /**
   * The Concierge reacted to guardian message `messageKey` of chat `chatId`,
   * in its turn or later: that is how it handled it, so it never shows
   * working, and an open turn shows it no failed should it fail or be cut
   * off. With `reacted` false the reaction was taken back, so the message is
   * work again.
   */
  async markReacted(chatId: string, messageKey: string, reacted = true): Promise<void> {
    const changed = await this.db
      .update(conciergeMessageTurns)
      .set(
        reacted
          ? {
              reacted: true,
              workingAt: sql`CASE WHEN ${conciergeMessageTurns.answeredAt} IS NULL THEN NULL ELSE ${conciergeMessageTurns.workingAt} END`,
            }
          : { reacted: false },
      )
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          eq(conciergeMessageTurns.messageKey, messageKey),
        ),
      )
      .returning({
        chatId: conciergeMessageTurns.chatId,
        messageKey: conciergeMessageTurns.messageKey,
      });
    this.messageChanged(changed);
  }

  /**
   * Whether guardian message `messageKey` of chat `chatId` ever showed
   * working: its turn showed it so, or a task was made for it.
   */
  async showedWorking(chatId: string, messageKey: string): Promise<boolean> {
    const [turn] = await this.db
      .select({ key: conciergeMessageTurns.messageKey })
      .from(conciergeMessageTurns)
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          eq(conciergeMessageTurns.messageKey, messageKey),
          isNotNull(conciergeMessageTurns.workingAt),
        ),
      )
      .limit(1);
    if (turn) return true;
    const [task] = await this.db
      .select({ key: conciergeMessageTasks.messageKey })
      .from(conciergeMessageTasks)
      .where(
        and(
          eq(conciergeMessageTasks.chatId, chatId),
          eq(conciergeMessageTasks.messageKey, messageKey),
        ),
      )
      .limit(1);
    return task !== undefined;
  }

  /**
   * The open messages of Concierge chat `chatId` that turn `turnId` took and
   * gave no sign: no reaction, no working shown and no task made for them.
   */
  async unansweredOf(chatId: string, turnId: string): Promise<string[]> {
    const rows = await this.db
      .select({ key: conciergeMessageTurns.messageKey })
      .from(conciergeMessageTurns)
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          eq(conciergeMessageTurns.turnId, turnId),
          isNull(conciergeMessageTurns.answeredAt),
        ),
      );
    return this.silentAmong(
      chatId,
      rows.map((row) => row.key),
    );
  }

  /** Which of `messageKeys` of chat `chatId` have no reaction, never showed working and have no task. */
  async silentAmong(chatId: string, messageKeys: readonly string[]): Promise<string[]> {
    if (messageKeys.length === 0) return [];
    const keys = [...messageKeys];
    const quiet = await this.db
      .select({ key: conciergeMessageTurns.messageKey })
      .from(conciergeMessageTurns)
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          inArray(conciergeMessageTurns.messageKey, keys),
          isNull(conciergeMessageTurns.workingAt),
          eq(conciergeMessageTurns.reacted, false),
        ),
      );
    const linked = new Set(
      (
        await this.db
          .select({ key: conciergeMessageTasks.messageKey })
          .from(conciergeMessageTasks)
          .where(
            and(
              eq(conciergeMessageTasks.chatId, chatId),
              inArray(conciergeMessageTasks.messageKey, keys),
            ),
          )
      ).map((row) => row.key),
    );
    return quiet.map((row) => row.key).filter((key) => !linked.has(key));
  }

  /**
   * Whether an open message of Concierge chat `chatId` showed working before
   * the running turn took it: work an earlier turn handed on.
   */
  async anyInheritedWorking(chatId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ key: conciergeMessageTurns.messageKey })
      .from(conciergeMessageTurns)
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          isNull(conciergeMessageTurns.answeredAt),
          isNotNull(conciergeMessageTurns.workingAt),
          sql`${conciergeMessageTurns.workingAt} < ${conciergeMessageTurns.takenAt}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * A turn of Concierge chat `chatId` ended: every message a turn no longer
   * running took is answered. A message handed on to a turn in `running`
   * stays open until that one ends. Answers how many changed.
   */
  async answerTurns(
    chatId: string,
    running: readonly string[],
    now = new Date(),
    options: { stopped?: boolean; failed?: boolean } = {},
  ): Promise<number> {
    const changed = await this.db
      .update(conciergeMessageTurns)
      // A turn its owner stopped answered nothing: the next turn is told so.
      .set({
        answeredAt: now,
        // A message the turn reacted to was handled, so its failure is not the message's.
        turnFailed: options.failed === true ? sql`NOT ${conciergeMessageTurns.reacted}` : false,
        ...(options.stopped ? { stoppedUntold: true } : {}),
      })
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

  /**
   * The guardian messages of Concierge chat `chatId` whose turn their owner
   * stopped before it answered them, and that no turn was told of yet. Told
   * once: answering clears them.
   */
  async takeStoppedRequests(chatId: string): Promise<string[]> {
    const rows = await this.db
      .update(conciergeMessageTurns)
      .set({ stoppedUntold: false })
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          eq(conciergeMessageTurns.stoppedUntold, true),
        ),
      )
      .returning({ messageKey: conciergeMessageTurns.messageKey });
    return rows.map((row) => row.messageKey);
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
   * cleared: every message its failure left, its own and the ones handed on
   * to it, is open again until it ends. A message it answered or reacted to
   * before stays settled.
   */
  async reopenTurn(chatId: string, turnId: string): Promise<number> {
    const changed = await this.db
      .update(conciergeMessageTurns)
      // It runs again for the messages its failure left: they work from now.
      .set({
        answeredAt: null,
        turnFailed: false,
        workingAt: sql`COALESCE(${conciergeMessageTurns.workingAt}, ${Date.now()})`,
      })
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          eq(conciergeMessageTurns.turnId, turnId),
          eq(conciergeMessageTurns.turnFailed, true),
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
   * After a restart, before any turn runs: a stopped process ends no turn, so
   * every message still open is answered, except in `continuing`, the chats
   * whose interrupted turn startup continues, whose turn answers them when it
   * ends, and which show working from now, unless the turn reacted to them.
   * No message stays open past the process that took it. The process died
   * under the turn: it failed, as a crash does, for every message it had not
   * reacted to. Answers how many changed.
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
    // A turn startup continues works from its start.
    const going = open.filter((row) => continuing.has(row.chatId));
    for (const row of going) {
      await this.db
        .update(conciergeMessageTurns)
        .set({
          workingAt: sql`CASE WHEN ${conciergeMessageTurns.reacted} THEN ${conciergeMessageTurns.workingAt} ELSE COALESCE(${conciergeMessageTurns.workingAt}, ${now.getTime()}) END`,
        })
        .where(
          and(
            eq(conciergeMessageTurns.chatId, row.chatId),
            eq(conciergeMessageTurns.messageKey, row.messageKey),
          ),
        );
    }
    this.messageChanged(going);
    for (const row of ending) {
      await this.db
        .update(conciergeMessageTurns)
        .set({ answeredAt: now, turnFailed: sql`NOT ${conciergeMessageTurns.reacted}` })
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

  /**
   * Task `taskId` was made for guardian message `target`: started for it, or
   * given its words. A task has at most one live link, to the message it was
   * made for last: the live link it had to another message settles as
   * superseded, for good, so that message keeps no part in the task's later
   * work or how it ends. Made for a message again, the link is live again.
   * Answers what to put back for {@link unlinkMessage}.
   */
  async linkMessage(taskId: string, target: MessageTarget): Promise<LinkUndo> {
    const own = and(
      eq(conciergeMessageTasks.taskId, taskId),
      eq(conciergeMessageTasks.chatId, target.chatId),
      eq(conciergeMessageTasks.messageKey, target.messageKey),
    );
    // One step, so no other write lands between the read and the writes.
    const undo = this.db.transaction((tx): LinkUndo => {
      const before =
        tx
          .select({ seq: conciergeMessageTasks.seq, endedAs: conciergeMessageTasks.endedAs })
          .from(conciergeMessageTasks)
          .where(own)
          .get() ?? null;
      const superseded = tx
        .update(conciergeMessageTasks)
        .set({ endedAs: LINK_SUPERSEDED })
        .where(
          and(
            eq(conciergeMessageTasks.taskId, taskId),
            isNull(conciergeMessageTasks.endedAs),
            or(
              ne(conciergeMessageTasks.chatId, target.chatId),
              ne(conciergeMessageTasks.messageKey, target.messageKey),
            ),
          ),
        )
        .returning({
          chatId: conciergeMessageTasks.chatId,
          messageKey: conciergeMessageTasks.messageKey,
        })
        .all();
      const seq =
        (tx
          .select({ max: sql<number>`COALESCE(MAX(${conciergeMessageTasks.seq}), 0)` })
          .from(conciergeMessageTasks)
          .get()?.max ?? 0) + 1;
      tx.insert(conciergeMessageTasks)
        .values({ taskId, ...target, seq })
        .onConflictDoUpdate({
          target: [
            conciergeMessageTasks.taskId,
            conciergeMessageTasks.chatId,
            conciergeMessageTasks.messageKey,
          ],
          set: { seq, endedAs: null },
        })
        .run();
      return { before, superseded };
    });
    this.messageChanged([target, ...undo.superseded]);
    return undo;
  }

  /**
   * Takes back {@link linkMessage}, as when the task never heard the message:
   * its link is as it was, a new one goes, and the link it superseded is
   * live again.
   */
  async unlinkMessage(taskId: string, target: MessageTarget, undo: LinkUndo): Promise<void> {
    this.db.transaction((tx) => {
      const own = and(
        eq(conciergeMessageTasks.taskId, taskId),
        eq(conciergeMessageTasks.chatId, target.chatId),
        eq(conciergeMessageTasks.messageKey, target.messageKey),
      );
      if (undo.before === null) tx.delete(conciergeMessageTasks).where(own).run();
      else tx.update(conciergeMessageTasks).set(undo.before).where(own).run();
      for (const other of undo.superseded) {
        tx.update(conciergeMessageTasks)
          .set({ endedAs: null })
          .where(
            and(
              eq(conciergeMessageTasks.taskId, taskId),
              eq(conciergeMessageTasks.chatId, other.chatId),
              eq(conciergeMessageTasks.messageKey, other.messageKey),
              eq(conciergeMessageTasks.endedAs, LINK_SUPERSEDED),
            ),
          )
          .run();
      }
    });
    this.messageChanged([target, ...undo.superseded]);
  }

  /** The order of task `taskId`'s live link, or null when it has none. */
  liveLinkSeq(taskId: string): number | null {
    return (
      this.db
        .select({ seq: conciergeMessageTasks.seq })
        .from(conciergeMessageTasks)
        .where(and(eq(conciergeMessageTasks.taskId, taskId), isNull(conciergeMessageTasks.endedAs)))
        .get()?.seq ?? null
    );
  }

  /**
   * Task `taskId` ended, with its result told, `endedAs`: its live link, when
   * its order is at most `upToSeq`, keeps that and follows the task no more,
   * so the task's later work leaves the message alone. A link made after the
   * caller read the task's state has a higher order and stays live.
   */
  async endLinks(taskId: string, endedAs: string, upToSeq: number): Promise<void> {
    const changed = await this.db
      .update(conciergeMessageTasks)
      .set({ endedAs })
      .where(
        and(
          eq(conciergeMessageTasks.taskId, taskId),
          isNull(conciergeMessageTasks.endedAs),
          lte(conciergeMessageTasks.seq, upToSeq),
        ),
      )
      .returning({
        chatId: conciergeMessageTasks.chatId,
        messageKey: conciergeMessageTasks.messageKey,
      });
    this.messageChanged(changed);
  }

  /** Tells the message listeners about the messages task `taskId` was made for again, for state kept outside them. */
  async retellMessagesOf(taskId: string): Promise<void> {
    this.messageChanged(await this.messagesOfTask(taskId));
  }

  /** The guardian messages task `taskId` was made for. */
  async messagesOfTask(taskId: string): Promise<MessageTarget[]> {
    return this.db
      .select({
        chatId: conciergeMessageTasks.chatId,
        messageKey: conciergeMessageTasks.messageKey,
      })
      .from(conciergeMessageTasks)
      .where(eq(conciergeMessageTasks.taskId, taskId));
  }

  /** Forgets the turns and tasks of Concierge chat `chatId`'s messages, once the chat is deleted. */
  async forgetMessages(chatId: string): Promise<void> {
    await this.db.delete(conciergeMessageTurns).where(eq(conciergeMessageTurns.chatId, chatId));
    await this.db.delete(conciergeMessageTasks).where(eq(conciergeMessageTasks.chatId, chatId));
  }

  /** The stored status facts of each of `messageKeys` in Concierge chat `chatId` that has any. */
  async messageMarks(
    chatId: string,
    messageKeys: readonly string[],
  ): Promise<Map<string, MessageMarkRow>> {
    const out = new Map<string, MessageMarkRow>();
    if (messageKeys.length === 0) return out;
    const keys = [...new Set(messageKeys)];
    const of = (key: string) => {
      const found = out.get(key) ?? {
        answered: null,
        working: false,
        reacted: false,
        turnFailed: false,
        taskIds: [],
        earlierTaskIds: [],
        endedAs: [],
      };
      out.set(key, found);
      return found;
    };
    for (const row of await this.db
      .select({
        messageKey: conciergeMessageTurns.messageKey,
        answeredAt: conciergeMessageTurns.answeredAt,
        workingAt: conciergeMessageTurns.workingAt,
        reacted: conciergeMessageTurns.reacted,
        turnFailed: conciergeMessageTurns.turnFailed,
      })
      .from(conciergeMessageTurns)
      .where(
        and(
          eq(conciergeMessageTurns.chatId, chatId),
          inArray(conciergeMessageTurns.messageKey, keys),
        ),
      )) {
      const mark = of(row.messageKey);
      mark.answered = row.answeredAt !== null;
      mark.working = row.workingAt !== null;
      mark.reacted = row.reacted;
      mark.turnFailed = row.turnFailed;
    }
    for (const row of await this.db
      .select({
        messageKey: conciergeMessageTasks.messageKey,
        taskId: conciergeMessageTasks.taskId,
        endedAs: conciergeMessageTasks.endedAs,
      })
      .from(conciergeMessageTasks)
      .where(
        and(
          eq(conciergeMessageTasks.chatId, chatId),
          inArray(conciergeMessageTasks.messageKey, keys),
        ),
      )) {
      const mark = of(row.messageKey);
      if (row.endedAs === null) mark.taskIds.push(row.taskId);
      else if (row.endedAs === LINK_SUPERSEDED) mark.earlierTaskIds.push(row.taskId);
      else mark.endedAs.push(row.endedAs);
    }
    return out;
  }

  /**
   * Task `id`'s wait that began at `waitingSince` expired: Rome handles it
   * once. Answers false when that wait was handled already.
   */
  async markWaitExpired(id: string, waitingSince: Date): Promise<boolean> {
    const marked = await this.db
      .update(conciergeTasks)
      .set({ expiredWaitAt: waitingSince, noResponseUnlisted: true })
      .where(
        and(
          eq(conciergeTasks.id, id),
          or(isNull(conciergeTasks.expiredWaitAt), ne(conciergeTasks.expiredWaitAt, waitingSince)),
        ),
      )
      .returning({ id: conciergeTasks.id });
    if (marked.length > 0) await this.announce(id, "refresh");
    return marked.length > 0;
  }

  /**
   * Task `id` was written to after its wait ended for no response, and that
   * wait is over: it ends for no response no more.
   */
  async clearWaitExpired(id: string): Promise<void> {
    const cleared = await this.db
      .update(conciergeTasks)
      .set({ expiredWaitAt: null, noResponseUnlisted: false })
      .where(and(eq(conciergeTasks.id, id), isNotNull(conciergeTasks.expiredWaitAt)))
      .returning({ id: conciergeTasks.id });
    if (cleared.length > 0) await this.announce(id, "refresh");
  }

  /** The tasks of `taskIds` that ended for no response and no digest listed yet. */
  async noResponseUnlisted(taskIds: readonly string[]): Promise<string[]> {
    if (taskIds.length === 0) return [];
    const rows = await this.db
      .select({ id: conciergeTasks.id })
      .from(conciergeTasks)
      .where(
        and(inArray(conciergeTasks.id, [...taskIds]), eq(conciergeTasks.noResponseUnlisted, true)),
      );
    return rows.map((row) => row.id);
  }

  /** Tasks `taskIds` were listed in a digest that ran to its end, as ended for no response. */
  async markNoResponseListed(taskIds: readonly string[]): Promise<void> {
    if (taskIds.length === 0) return;
    await this.db
      .update(conciergeTasks)
      .set({ noResponseUnlisted: false })
      .where(inArray(conciergeTasks.id, [...taskIds]));
  }

  /** The task chat of every stopped task, and when it stopped, so nothing approved later runs for one. */
  async stoppedTaskChats(): Promise<{ chatId: string; stoppedAt: number }[]> {
    const rows = await this.db
      .select({
        chatId: conciergeTasks.sessionId,
        stoppedAt: conciergeTasks.stoppedAt,
        stopReason: conciergeTasks.stopReason,
        archivedAt: conciergeTasks.archivedAt,
      })
      .from(conciergeTasks)
      .where(and(isNotNull(conciergeTasks.stoppedAt), isNotNull(conciergeTasks.sessionId)));
    // A chat unarchived after its archive stopped the task is in use again.
    return rows.flatMap((row) =>
      row.chatId && row.stoppedAt && (row.stopReason !== "archived" || row.archivedAt)
        ? [{ chatId: row.chatId, stoppedAt: row.stoppedAt.getTime() }]
        : [],
    );
  }

  /** Rows `taskIds` were listed in a digest that ran to its end, as never started. */
  async markUnstartedListed(taskIds: readonly string[], now = new Date()): Promise<void> {
    if (taskIds.length === 0) return;
    await this.db
      .update(conciergeTasks)
      .set({ unstartedListedAt: now })
      .where(inArray(conciergeTasks.id, [...taskIds]));
  }

  /**
   * Keeps when each task's derived status ended: `ended` ids get the time
   * when they have none, `open` ids lose it. Tells no listener, since it
   * changes nothing a reader sees.
   */
  async keepEnded(
    ended: readonly string[],
    open: readonly string[],
    now = new Date(),
  ): Promise<void> {
    if (ended.length > 0) {
      await this.db
        .update(conciergeTasks)
        .set({ endedAt: now })
        .where(and(inArray(conciergeTasks.id, [...ended]), isNull(conciergeTasks.endedAt)));
    }
    if (open.length > 0) {
      // Its no-response note stays: a turn Rome runs on its own, such as the
      // one after an approval it turned down, opens the task only for a
      // while. Only someone writing to it clears the note (clearWaitExpired).
      await this.db
        .update(conciergeTasks)
        .set({ endedAt: null })
        .where(and(inArray(conciergeTasks.id, [...open]), isNotNull(conciergeTasks.endedAt)));
    }
  }

  /** The tasks whose task chat's result the Concierge has not reported yet. */
  async tasksWithUnsaidOutcome(): Promise<string[]> {
    const rows = await this.db
      .select({ id: conciergeTasks.id })
      .from(conciergeTasks)
      .where(eq(conciergeTasks.outcomeUnsaid, true));
    return rows.map((row) => row.id);
  }

  /**
   * Rome gave up telling the Concierge task `taskId`'s result: it waits for
   * no report any more, and its owner was never told, which its messages show.
   */
  async markGivenUp(taskId: string): Promise<void> {
    await this.db
      .update(conciergeTasks)
      .set({ outcomeUnsaid: false, reportGivenUp: true })
      .where(eq(conciergeTasks.id, taskId));
    await this.announce(taskId, "refresh");
  }

  /** The Concierge reported the results of `taskIds`. */
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
