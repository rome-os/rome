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
import { ownerOf } from "../../webchat/owner.js";
import {
  conciergeMessageTasks,
  conciergeMessageTurns,
  romeSessions,
  taskChats,
} from "../schema.js";

type TaskChatRow = typeof taskChats.$inferSelect;

/**
 * A task as the Concierge's code reads it: the task chat's side-table row
 * with the facts the chat itself holds (docs/domains/chats.md#task). The task
 * is its task chat, so `id` and `sessionId` are both the chat's id, `title`
 * is the chat's name, `ownerKey` the chat's owner, and `archivedAt` the
 * chat's archive time. Only the facts of `task_chats` are stored on the row.
 */
export interface ConciergeTaskRow {
  /** The task's id: its task chat's id. */
  id: string;
  /** The task chat's id, the same as `id`. */
  sessionId: string;
  /** The task chat's name. */
  title: string;
  ownerKey: string;
  /** The Concierge chat the task reports to, as stored: null is the main chat. */
  chatId: string | null;
  sourceMessageId: number | null;
  note: string | null;
  stoppedAt: Date | null;
  lastOutcome: TaskChatRow["lastOutcome"];
  outcomeUnsaid: boolean;
  expiredWaitAt: Date | null;
  noResponseUnlisted: boolean;
  reportGivenUp: boolean;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

/**
 * A row with the name of its task chat, the Concierge chat it came from, and
 * the id of its source message when that message still exists in that
 * Concierge chat.
 */
export interface ConciergeTaskWithChat {
  row: ConciergeTaskRow;
  chat: { id: string; name: string };
  /** The Concierge chat the row came from: its owner's main chat when the row names none or its chat is gone. */
  conciergeChat: { id: string; name: string; main: boolean };
  /** Whose Concierge the row is, as its chat records it. Never sent to a client. */
  owner: string;
  sourceMessageId: string | null;
}

/** What the Concierge may change on a task: its note, and the message it points to. */
export interface ConciergeTaskWrite {
  /** What the Concierge keeps for its later self. Null clears it. */
  note?: string | null;
  /** The Concierge chat the task reports to. Null is the main chat. */
  chatId?: string | null;
  /** A message of the task's Concierge chat, by its key there; the caller has checked it. */
  sourceMessageId?: string | null;
}

/** `write`: settles the task events owed for the row. `refresh`: tells readers
 *  without settling those events. */
type ChangeKind = "write" | "refresh";
type ChangeListener = (task: ConciergeTaskWithChat, change: ChangeKind) => void;

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

/** A task row as its select returns it, with the chat's own facts beside it. */
interface JoinedTask {
  task: TaskChatRow;
  name: string;
  ownerKey: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

function toRow({ task, name, ownerKey, createdAt, archivedAt }: JoinedTask): ConciergeTaskRow {
  return {
    id: task.sessionId,
    sessionId: task.sessionId,
    title: name,
    ownerKey: ownerOf({ ownerKey }),
    chatId: task.conciergeChatId,
    sourceMessageId: task.sourceMessageId,
    note: task.note,
    stoppedAt: task.stoppedAt,
    lastOutcome: task.lastOutcome,
    outcomeUnsaid: task.outcomeUnsaid,
    expiredWaitAt: task.expiredWaitAt,
    noResponseUnlisted: task.noResponseUnlisted,
    reportGivenUp: task.reportGivenUp,
    endedAt: task.endedAt,
    createdAt,
    updatedAt: task.updatedAt,
    archivedAt,
  };
}

const JOINED = {
  task: taskChats,
  name: romeSessions.name,
  ownerKey: romeSessions.ownerKey,
  createdAt: romeSessions.createdAt,
  archivedAt: romeSessions.archivedAt,
} as const;

/**
 * The Concierge's task chats (docs/domains/chats.md#task): one row of facts
 * per task chat, kept beside what the chat itself holds. Every write tells the
 * change listeners, which push the row to the Tasks view and settle the task
 * events the Concierge owed for it.
 */
/** The task's last outcome with its owner's mark of done taken off: a mark ends only the stop it came with. */
const notMarkedDone = sql<
  TaskChatRow["lastOutcome"]
>`CASE WHEN ${taskChats.lastOutcome} = 'done_by_owner' THEN NULL ELSE ${taskChats.lastOutcome} END`;

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
    const rows = (
      await this.db
        .select(JOINED)
        .from(taskChats)
        .innerJoin(romeSessions, eq(romeSessions.id, taskChats.sessionId))
        .where(and(eq(taskChats.conciergeChatId, chatId), isNull(romeSessions.archivedAt)))
    ).map(toRow);
    const openIds = await isOpen(rows);
    const open = rows.filter((row) => openIds.has(row.id));
    for (const { id } of open) await this.announce(id, "refresh");
    return open.length;
  }

  /**
   * Task chat `chatId` is archived or deleted: the row of `owner` is stopped
   * when `stop` says the task is still open, in the one transaction that
   * `alsoIn` archives or deletes the chat in. A task that already ended keeps
   * how it ended. Deleting the chat deletes the row with it. Answers the row
   * as it stood, or null when the chat is no task chat of `owner`'s; the
   * chat is archived or deleted either way.
   */
  async endWithChat(
    chatId: string,
    owner: string,
    end: "archived" | "deleted",
    alsoIn: (tx: DrizzleTx) => void,
    now = new Date(),
    stop = true,
  ): Promise<ConciergeTaskRow | null> {
    // What a deleted task leaves behind is told once it is gone: its row
    // goes with the chat, and so do the links of its messages.
    const gone =
      end === "deleted"
        ? { task: await this.getWithChat(chatId), messages: await this.messagesOfTask(chatId) }
        : null;
    const ended = this.db.transaction((tx) => {
      const found = tx
        .select(JOINED)
        .from(taskChats)
        .innerJoin(romeSessions, eq(romeSessions.id, taskChats.sessionId))
        .where(eq(taskChats.sessionId, chatId))
        .get();
      const own = found && ownerOf({ ownerKey: found.ownerKey }) === owner ? found : null;
      if (own) {
        tx.update(taskChats)
          .set({
            stoppedAt: own.task.stoppedAt ?? (stop ? now : null),
            // Stopped by the archive here, it ends stopped, never as marked done.
            ...(own.task.stoppedAt === null && stop ? { lastOutcome: notMarkedDone } : {}),
            updatedAt: now,
          })
          .where(eq(taskChats.sessionId, chatId))
          .run();
      }
      alsoIn(tx);
      if (!own) return null;
      // As it stands after the write: archived by the chat's own archive.
      const after = tx
        .select(JOINED)
        .from(taskChats)
        .innerJoin(romeSessions, eq(romeSessions.id, taskChats.sessionId))
        .where(eq(taskChats.sessionId, chatId))
        .get();
      return toRow(
        after ?? {
          ...own,
          task: { ...own.task, stoppedAt: own.task.stoppedAt ?? (stop ? now : null) },
        },
      );
    });
    if (ended && end === "archived") await this.announce(ended.id, "refresh");
    if (ended && gone?.task) {
      for (const listener of this.listeners) listener(gone.task, "refresh");
      this.messageChanged(gone.messages);
    }
    return ended;
  }

  /**
   * How task `id`'s task chat's latest work ended. Rome writes it; the
   * Concierge never does. A task its owner marked done keeps that until it is
   * taken up again: the turn its marking stopped ends after it, and changes
   * nothing.
   */
  async setLastOutcome(
    id: string,
    outcome: "succeeded" | "failed" | "stopped",
    now = new Date(),
    options: { reported?: boolean } = {},
  ): Promise<void> {
    const changed = await this.db
      .update(taskChats)
      // A result waits for the Concierge's report; a stop has none to give.
      .set({
        lastOutcome: outcome,
        // Only a result the Concierge will be told of waits for its report.
        outcomeUnsaid: outcome !== "stopped" && options.reported !== false,
        reportGivenUp: false,
        updatedAt: now,
      })
      .where(
        and(
          eq(taskChats.sessionId, id),
          or(
            isNull(taskChats.stoppedAt),
            isNull(taskChats.lastOutcome),
            ne(taskChats.lastOutcome, "done_by_owner"),
          ),
        ),
      )
      .returning({ id: taskChats.sessionId });
    if (changed.length > 0) await this.announce(id, "refresh");
  }

  /**
   * Its owner marked task `id` done: it is stopped as a stop stops it, and
   * ends done. One already stopped changes nothing. Answers whether it was
   * marked.
   */
  async markDone(id: string, now = new Date()): Promise<boolean> {
    const marked = await this.db
      .update(taskChats)
      .set({
        stoppedAt: now,
        lastOutcome: "done_by_owner",
        outcomeUnsaid: false,
        reportGivenUp: false,
        updatedAt: now,
      })
      .where(and(eq(taskChats.sessionId, id), isNull(taskChats.stoppedAt)))
      .returning({ id: taskChats.sessionId });
    if (marked.length > 0) await this.announce(id, "refresh");
    return marked.length > 0;
  }

  /**
   * Task `id` was stopped by `by`. A stop is kept: a later one changes
   * nothing. A stop is no mark of done, so it never ends one done.
   */
  async stop(id: string, now = new Date()): Promise<void> {
    const stopped = await this.db
      .update(taskChats)
      .set({ stoppedAt: now, lastOutcome: notMarkedDone, updatedAt: now })
      .where(and(eq(taskChats.sessionId, id), isNull(taskChats.stoppedAt)))
      .returning({ id: taskChats.sessionId });
    if (stopped.length > 0) await this.announce(id, "refresh");
  }

  /**
   * Task `id`, stopped, takes new work: it is stopped no more. A task whose
   * chat is archived stays stopped, since nothing runs in an archived chat.
   * One its owner marked done is marked no more: the new work ends as it
   * ends. Answers whether it was resumed.
   */
  async resume(id: string, now = new Date()): Promise<boolean> {
    const resumed = await this.db
      .update(taskChats)
      .set({ stoppedAt: null, lastOutcome: notMarkedDone, updatedAt: now })
      .where(
        and(
          eq(taskChats.sessionId, id),
          isNotNull(taskChats.stoppedAt),
          inArray(
            taskChats.sessionId,
            this.db
              .select({ id: romeSessions.id })
              .from(romeSessions)
              .where(isNull(romeSessions.archivedAt)),
          ),
        ),
      )
      .returning({ id: taskChats.sessionId });
    if (resumed.length > 0) await this.announce(id, "refresh");
    return resumed.length > 0;
  }

  /**
   * Task `id`'s first turn could not start: it is a task chat whose first turn
   * failed, so it ended failed, and its owner reads the error in the chat.
   */
  async markStartFailed(id: string, now = new Date()): Promise<void> {
    await this.setLastOutcome(id, "failed", now, { reported: false });
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private selectRows(where: SQL | undefined) {
    return this.db
      .select(JOINED)
      .from(taskChats)
      .innerJoin(romeSessions, eq(romeSessions.id, taskChats.sessionId))
      .where(where);
  }

  async get(id: string): Promise<ConciergeTaskRow | null> {
    const [found] = await this.selectRows(eq(taskChats.sessionId, id));
    return found ? toRow(found) : null;
  }

  /** The rows of `ids` that exist, in one read. */
  async getMany(ids: readonly string[]): Promise<ConciergeTaskRow[]> {
    if (ids.length === 0) return [];
    return (await this.selectRows(inArray(taskChats.sessionId, [...ids]))).map(toRow);
  }

  async getWithChat(id: string): Promise<ConciergeTaskWithChat | null> {
    const found = await this.withChat(eq(taskChats.sessionId, id));
    return found[0] ?? null;
  }

  /** The rows of the task chats `sessionIds`, in one read. */
  async findBySessions(sessionIds: readonly string[]): Promise<ConciergeTaskRow[]> {
    return this.getMany([...new Set(sessionIds)]);
  }

  async findBySession(sessionId: string): Promise<ConciergeTaskRow | null> {
    return this.get(sessionId);
  }

  /**
   * Moves the source message and its Concierge chat without settling task events.
   * The caller has checked that the message belongs to `chatId`.
   */
  async setSourceMessage(id: string, chatId: string, messageId: string): Promise<void> {
    const stored = chatId === CONCIERGE_CHAT_ID ? null : chatId;
    await this.db
      .update(taskChats)
      .set({ conciergeChatId: stored, sourceMessageId: this.sources.idOf(chatId, messageId) })
      .where(eq(taskChats.sessionId, id));
    await this.announce(id, "refresh");
  }

  /**
   * The rows, not archived, whose start message is the one keyed `messageKey`
   * in Concierge chat `chatId`, oldest first. One filtered read, not the
   * whole list.
   */
  async listStartedAt(chatId: string, messageKey: string): Promise<ConciergeTaskWithChat[]> {
    const message = this.sources.idOf(chatId, messageKey);
    if (message === null) return [];
    return this.withChat(
      and(isNull(romeSessions.archivedAt), eq(taskChats.sourceMessageId, message)),
    );
  }

  /**
   * The rows the panel shows: not archived, every open one whatever its age,
   * and the ended ones that ended at or after `doneSince`.
   */
  async listForPanel(doneSince: Date): Promise<ConciergeTaskWithChat[]> {
    return this.withChat(
      and(
        isNull(romeSessions.archivedAt),
        // Open, or ended inside the window, as its derived status read it.
        or(isNull(taskChats.endedAt), gte(taskChats.endedAt, doneSince)),
      ),
    );
  }

  /**
   * One Concierge chat's rows that can still be doing something: not
   * archived, and either still open or ended with a task chat that was
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
        ? or(
            eq(romeSessions.ownerKey, owner),
            owner === "guardian" ? isNull(romeSessions.ownerKey) : undefined,
          )
        : eq(taskChats.conciergeChatId, conciergeChatId);
    const rows = await this.withChat(
      and(
        ofChat,
        isNull(romeSessions.archivedAt),
        or(isNull(taskChats.endedAt), gte(romeSessions.activityAt, activeSince)),
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
        sessionId: taskChats.sessionId,
        title: romeSessions.name,
        ownerKey: romeSessions.ownerKey,
        chatId: taskChats.conciergeChatId,
        originId: origin.id,
        originArchivedAt: origin.archivedAt,
      })
      .from(taskChats)
      .innerJoin(romeSessions, eq(romeSessions.id, taskChats.sessionId))
      .leftJoin(origin, eq(origin.id, taskChats.conciergeChatId))
      .where(inArray(taskChats.sessionId, [...new Set(chatIds)]));
    const main = mainChatIdOf(owner);
    return rows.flatMap((row) => {
      if (ownerOf({ ownerKey: row.ownerKey }) !== owner) return [];
      const chat =
        row.chatId && row.originId !== null && row.originArchivedAt === null ? row.chatId : main;
      return chat === conciergeChatId
        ? [{ chatId: row.sessionId, task: { id: row.sessionId, title: row.title } }]
        : [];
    });
  }

  /**
   * The task chats `owner`'s Concierge chat `conciergeChatId` started, ended
   * and archived tasks included, each with its chat's name. The main chat
   * started a task that names no chat.
   */
  async taskChatsStartedBy(
    conciergeChatId: string,
    owner: string,
  ): Promise<Array<{ chatId: string; name: string }>> {
    const startedBy =
      conciergeChatId === mainChatIdOf(owner)
        ? or(isNull(taskChats.conciergeChatId), eq(taskChats.conciergeChatId, conciergeChatId))
        : eq(taskChats.conciergeChatId, conciergeChatId);
    const rows = await this.db
      .select({
        chatId: romeSessions.id,
        chatName: romeSessions.name,
        ownerKey: romeSessions.ownerKey,
      })
      .from(taskChats)
      .innerJoin(romeSessions, eq(romeSessions.id, taskChats.sessionId))
      .where(startedBy);
    return rows
      .filter((row) => ownerOf({ ownerKey: row.ownerKey }) === owner)
      .map((row) => ({ chatId: row.chatId, name: row.chatName }));
  }

  /** The Concierge's own view: not archived, ended rows only on request. */
  async listForAgent(includeDone: boolean): Promise<ConciergeTaskWithChat[]> {
    return this.withChat(
      and(isNull(romeSessions.archivedAt), includeDone ? undefined : isNull(taskChats.endedAt)),
    );
  }

  /**
   * Rows whose task chat was active after the row was last written: the
   * changes a restart may have dropped from memory.
   */
  async listBehindTheirChat(): Promise<ConciergeTaskRow[]> {
    const rows = await this.db
      .select(JOINED)
      .from(taskChats)
      .innerJoin(romeSessions, eq(romeSessions.id, taskChats.sessionId))
      .where(
        and(
          isNull(romeSessions.archivedAt),
          sql`cast(${romeSessions.activityAt} as integer) * 1000 > cast(${taskChats.updatedAt} as integer)`,
        ),
      );
    return rows.map(toRow);
  }

  /**
   * Makes the row of task chat `sessionId`, which reports to Concierge chat
   * `write.chatId` (null: the main chat) and points to `write.sourceMessageId`.
   * The chat exists already, and its owner is the task's. Tells the change
   * listeners once it is stored.
   */
  async create(
    sessionId: string,
    write: ConciergeTaskWrite = {},
    now = new Date(),
  ): Promise<ConciergeTaskRow> {
    const chatId = write.chatId ?? null;
    const stored = chatId === CONCIERGE_CHAT_ID ? null : chatId;
    this.db.transaction((tx) => {
      const chat = tx
        .select({ id: romeSessions.id })
        .from(romeSessions)
        .where(eq(romeSessions.id, sessionId))
        .get();
      if (!chat) throw new Error(`No chat ${sessionId}`);
      if (stored) {
        const origin = tx
          .select({ id: romeSessions.id })
          .from(romeSessions)
          .where(eq(romeSessions.id, stored))
          .get();
        if (!origin) throw new Error(`No Concierge chat ${stored}`);
      }
      tx.insert(taskChats)
        .values({
          sessionId,
          conciergeChatId: stored,
          sourceMessageId:
            write.sourceMessageId == null
              ? null
              : this.sources.idOf(chatId ?? CONCIERGE_CHAT_ID, write.sourceMessageId),
          note: write.note ?? null,
          updatedAt: now,
        })
        .run();
    });
    await this.announce(sessionId, "write");
    return (await this.get(sessionId)) as ConciergeTaskRow;
  }

  /**
   * Writes what the Concierge may change on task `id`: its note, and the
   * message it points to, which moves it to that message's Concierge chat.
   * Fields left out stay. Tells the change listeners once it is stored.
   */
  async write(id: string, write: ConciergeTaskWrite, now = new Date()): Promise<ConciergeTaskRow> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`No task ${id}`);
    const chatId = write.chatId !== undefined ? write.chatId : existing.chatId;
    await this.db
      .update(taskChats)
      .set({
        ...(write.note !== undefined ? { note: write.note } : {}),
        ...(write.chatId !== undefined
          ? { conciergeChatId: chatId === CONCIERGE_CHAT_ID ? null : chatId }
          : {}),
        ...(write.sourceMessageId !== undefined
          ? {
              sourceMessageId:
                write.sourceMessageId === null
                  ? null
                  : this.sources.idOf(chatId ?? CONCIERGE_CHAT_ID, write.sourceMessageId),
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(taskChats.sessionId, id));
    await this.announce(id, "write");
    return (await this.get(id)) as ConciergeTaskRow;
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
      eq(conciergeMessageTasks.taskChatId, taskId),
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
            eq(conciergeMessageTasks.taskChatId, taskId),
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
        .values({ taskChatId: taskId, ...target, seq })
        .onConflictDoUpdate({
          target: [
            conciergeMessageTasks.taskChatId,
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
        eq(conciergeMessageTasks.taskChatId, taskId),
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
              eq(conciergeMessageTasks.taskChatId, taskId),
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
        .where(
          and(eq(conciergeMessageTasks.taskChatId, taskId), isNull(conciergeMessageTasks.endedAs)),
        )
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
          eq(conciergeMessageTasks.taskChatId, taskId),
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

  /** The guardian messages task `taskId` was made for. */
  async messagesOfTask(taskId: string): Promise<MessageTarget[]> {
    return this.db
      .select({
        chatId: conciergeMessageTasks.chatId,
        messageKey: conciergeMessageTasks.messageKey,
      })
      .from(conciergeMessageTasks)
      .where(eq(conciergeMessageTasks.taskChatId, taskId));
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
        taskId: conciergeMessageTasks.taskChatId,
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
      .update(taskChats)
      .set({ expiredWaitAt: waitingSince, noResponseUnlisted: true })
      .where(
        and(
          eq(taskChats.sessionId, id),
          or(isNull(taskChats.expiredWaitAt), ne(taskChats.expiredWaitAt, waitingSince)),
        ),
      )
      .returning({ id: taskChats.sessionId });
    if (marked.length > 0) await this.announce(id, "refresh");
    return marked.length > 0;
  }

  /**
   * Task `id` was written to after its wait ended for no response, and that
   * wait is over: it ends for no response no more.
   */
  async clearWaitExpired(id: string): Promise<void> {
    const cleared = await this.db
      .update(taskChats)
      .set({ expiredWaitAt: null, noResponseUnlisted: false })
      .where(and(eq(taskChats.sessionId, id), isNotNull(taskChats.expiredWaitAt)))
      .returning({ id: taskChats.sessionId });
    if (cleared.length > 0) await this.announce(id, "refresh");
  }

  /** The tasks of `taskIds` that ended for no response and no digest listed yet. */
  async noResponseUnlisted(taskIds: readonly string[]): Promise<string[]> {
    if (taskIds.length === 0) return [];
    const rows = await this.db
      .select({ id: taskChats.sessionId })
      .from(taskChats)
      .where(
        and(inArray(taskChats.sessionId, [...taskIds]), eq(taskChats.noResponseUnlisted, true)),
      );
    return rows.map((row) => row.id);
  }

  /** Tasks `taskIds` were listed in a digest that ran to its end, as ended for no response. */
  async markNoResponseListed(taskIds: readonly string[]): Promise<void> {
    if (taskIds.length === 0) return;
    await this.db
      .update(taskChats)
      .set({ noResponseUnlisted: false })
      .where(inArray(taskChats.sessionId, [...taskIds]));
  }

  /** The task chat of every stopped task, and when it stopped, so nothing approved later runs for one. */
  async stoppedTaskChats(): Promise<{ chatId: string; stoppedAt: number }[]> {
    const rows = await this.db
      .select({ chatId: taskChats.sessionId, stoppedAt: taskChats.stoppedAt })
      .from(taskChats)
      .where(isNotNull(taskChats.stoppedAt));
    return rows.flatMap((row) =>
      row.stoppedAt ? [{ chatId: row.chatId, stoppedAt: row.stoppedAt.getTime() }] : [],
    );
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
        .update(taskChats)
        .set({ endedAt: now })
        .where(and(inArray(taskChats.sessionId, [...ended]), isNull(taskChats.endedAt)));
    }
    if (open.length > 0) {
      // Its no-response note stays: a turn Rome runs on its own, such as the
      // one after an approval it turned down, opens the task only for a
      // while. Only someone writing to it clears the note (clearWaitExpired).
      await this.db
        .update(taskChats)
        .set({ endedAt: null })
        .where(and(inArray(taskChats.sessionId, [...open]), isNotNull(taskChats.endedAt)));
    }
  }

  /** The tasks whose task chat's result the Concierge has not reported yet. */
  async tasksWithUnsaidOutcome(): Promise<string[]> {
    const rows = await this.db
      .select({ id: taskChats.sessionId })
      .from(taskChats)
      .where(eq(taskChats.outcomeUnsaid, true));
    return rows.map((row) => row.id);
  }

  /**
   * Rome gave up telling the Concierge task `taskId`'s result: it waits for
   * no report any more, and its owner was never told, which its messages show.
   */
  async markGivenUp(taskId: string): Promise<void> {
    await this.db
      .update(taskChats)
      .set({ outcomeUnsaid: false, reportGivenUp: true })
      .where(eq(taskChats.sessionId, taskId));
    await this.announce(taskId, "refresh");
  }

  /** The Concierge reported the results of `taskIds`. */
  async markReported(taskIds: readonly string[]): Promise<void> {
    if (taskIds.length === 0) return;
    const reported = await this.db
      .update(taskChats)
      .set({ outcomeUnsaid: false })
      .where(and(inArray(taskChats.sessionId, [...taskIds]), eq(taskChats.outcomeUnsaid, true)))
      .returning({ id: taskChats.sessionId });
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
        ...JOINED,
        originName: origin.name,
        originArchivedAt: origin.archivedAt,
      })
      .from(taskChats)
      .innerJoin(romeSessions, eq(romeSessions.id, taskChats.sessionId))
      .leftJoin(origin, eq(origin.id, taskChats.conciergeChatId))
      .where(where)
      .orderBy(asc(romeSessions.createdAt), desc(taskChats.sessionId));
    const tasks = rows.map((found) => ({ found, row: toRow(found) }));
    // A row whose Concierge chat is archived or gone belongs to its owner's
    // main chat, so its buttons and results reach a chat that owner can write
    // in. The owner is the task chat's own.
    const mainIds = [...new Set(tasks.map(({ row }) => mainChatIdOf(row.ownerKey)))];
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
    const conciergeChatOf = ({
      row,
      found,
    }: {
      row: ConciergeTaskRow;
      found: { originName: string | null; originArchivedAt: Date | null };
    }) => {
      const main = mainChatIdOf(row.ownerKey);
      return row.chatId && found.originName !== null && found.originArchivedAt === null
        ? { id: row.chatId, name: found.originName, main: row.chatId === main }
        : { id: main, name: mainNames.get(main) ?? MAIN_CHAT_NAME, main: true };
    };
    // Only a message the row's Concierge chat still holds counts as a source.
    const sources = this.sources.keysOf(
      tasks.flatMap((task) =>
        task.row.sourceMessageId
          ? [{ id: task.row.sourceMessageId, chatId: conciergeChatOf(task).id }]
          : [],
      ),
    );
    return tasks.map((task) => ({
      row: task.row,
      chat: { id: task.row.sessionId, name: task.row.title },
      conciergeChat: conciergeChatOf(task),
      owner: task.row.ownerKey,
      sourceMessageId: (task.row.sourceMessageId && sources.get(task.row.sourceMessageId)) || null,
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
