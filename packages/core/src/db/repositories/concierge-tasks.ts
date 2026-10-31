import { randomUUID } from "node:crypto";
import { CONCIERGE_CHAT_ID } from "@rome/api-types/concierge";
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { DrizzleDb } from "../index.js";
import { MessageRepository } from "../../chats/message-repository.js";
import { conciergeTasks, romeAgentMessages, romeSessions } from "../schema.js";

export type ConciergeTaskRow = typeof conciergeTasks.$inferSelect;
type ConciergeTaskState = ConciergeTaskRow["state"];

/**
 * A row with the name of the task chat it links, which is the chat's own, and
 * the id of its source message when that message still exists in the Concierge chat.
 */
export interface ConciergeTaskWithChat {
  row: ConciergeTaskRow;
  chat: { id: string; name: string } | null;
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
  /** A message of the Concierge chat; the caller has checked it. */
  sourceMessageId?: string | null;
  archived?: boolean;
}

/** `write`: the Concierge wrote the row. `refresh`: the row is the same, but state
 *  kept beside it changed, so its readers should look again. */
type ChangeKind = "write" | "refresh";
type ChangeListener = (task: ConciergeTaskWithChat, change: ChangeKind) => void;

const isFinished = (state: ConciergeTaskState) => state === "done" || state === "dropped";

/**
 * The Concierge's todo list. Only the Concierge's tools write it; every write
 * tells the change listeners, which push the row to the panel and settle the
 * task events the Concierge owed for it.
 */
export class ConciergeTasksRepository {
  private listeners = new Set<ChangeListener>();

  /** Chats' messages, where a task's source message is looked up. */
  private readonly messages: Pick<MessageRepository, "byIds">;

  constructor(private db: DrizzleDb) {
    this.messages = new MessageRepository(db);
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
        const archivedAt =
          write.archived === undefined
            ? (existing?.archivedAt ?? null)
            : write.archived
              ? (existing?.archivedAt ?? now)
              : null;
        const completedAt = isFinished(state) ? (existing?.completedAt ?? now) : null;
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
          sourceMessageId:
            write.sourceMessageId !== undefined
              ? write.sourceMessageId
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
          const [row] = tx
            .insert(conciergeTasks)
            .values({ id: randomUUID(), createdAt: now, ...fields })
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
    const rows = await this.db
      .select({
        task: conciergeTasks,
        chatName: romeSessions.name,
      })
      .from(conciergeTasks)
      .leftJoin(romeSessions, eq(romeSessions.id, conciergeTasks.sessionId))
      .where(where)
      .orderBy(asc(conciergeTasks.createdAt), desc(conciergeTasks.id));
    // Only a message the Concierge chat still holds counts as a source.
    const conciergeChat = this.db
      .select({ chatId: romeSessions.chatId })
      .from(romeSessions)
      .where(eq(romeSessions.id, CONCIERGE_CHAT_ID))
      .get()?.chatId;
    const sources = new Set(
      this.messages
        .byIds(rows.flatMap(({ task }) => (task.sourceMessageId ? [task.sourceMessageId] : [])))
        .filter((message) => message.place.chat.id === conciergeChat)
        .map((message) => message.id),
    );
    return rows.map(({ task, chatName }) => ({
      row: task,
      chat: task.sessionId && chatName !== null ? { id: task.sessionId, name: chatName } : null,
      sourceMessageId:
        task.sourceMessageId && sources.has(task.sourceMessageId) ? task.sourceMessageId : null,
    }));
  }
}
