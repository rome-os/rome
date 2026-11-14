// The Concierge's task list as the dashboard reads it: the stored rows with
// their chat's name, each task's status derived from the facts Rome holds,
// and the "not synced" mark the event delivery keeps in memory.

import {
  CONCIERGE_DONE_DAYS,
  type ConciergeOpenWait,
  type ConciergeTaskDto,
} from "@rome/api-types/concierge";
import {
  CONCIERGE_TASK_WAIT_EXPIRY_MS,
  type ConciergeTaskFacts,
  type ConciergeTaskStatusResult,
  legacyTaskState,
  taskStatus,
} from "@rome/api-types/concierge-task-status";
import type { LiveEventEmit } from "../lib/live-event.js";
import type { OpenWaitItem } from "../webchat/repository.js";
import { createLogger } from "../logger.js";
import { type ConciergeOwner, GUARDIAN_OWNER } from "../webchat/owner.js";
import type {
  ConciergeTaskRow,
  ConciergeTasksRepository,
  ConciergeTaskWithChat,
} from "../db/repositories/concierge-tasks.js";

const log = createLogger("concierge-tasks");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where a task's facts come from, beyond its row. Attached once the dashboard is up. */
export interface TaskFactSources {
  now(): number;
  /** Whether a turn runs or is queued in the task chat. */
  running(chatId: string): boolean;
  /** What each task chat waits on its owner for: its open cards and pending approvals, oldest first. */
  openWaits(chatIds: readonly string[]): Promise<Map<string, OpenWaitItem[]>>;
  /** The tasks whose result waits for the Concierge turn that reports it. */
  reportPending(): readonly string[];
  /** When each task's soonest pending check is due, epoch milliseconds. */
  laterOf?(taskIds: readonly string[]): Promise<Map<string, number>>;
}

/**
 * The wait a task chat's open items make. All of them are one wait, which
 * began at the oldest. Once Rome ended a wait for no response, every item
 * said by its deadline stays part of it, though a card stays answerable:
 * only an item said after that deadline begins a new wait, at the oldest
 * such item. Null when nothing is open.
 */
export function currentWait(
  items: readonly OpenWaitItem[],
  expiredWaitAt: number | null,
  waitExpiryMs: number,
): { since: number; newest: OpenWaitItem } | null {
  if (items.length === 0) return null;
  const newest = items.reduce((a, b) => (b.since >= a.since ? b : a));
  const oldest = Math.min(...items.map((item) => item.since));
  if (expiredWaitAt === null || oldest > expiredWaitAt + waitExpiryMs) {
    return { since: oldest, newest };
  }
  const deadline = expiredWaitAt + waitExpiryMs;
  const after = items.filter((item) => item.since > deadline);
  return {
    since: after.length > 0 ? Math.min(...after.map((item) => item.since)) : expiredWaitAt,
    newest,
  };
}

/** The newest open item of a wait, as the DTO carries it: `since` is when the wait began. */
function openWaitOf(wait: ReturnType<typeof currentWait>): ConciergeOpenWait | null {
  return wait ? { ...wait.newest, since: wait.since } : null;
}

/** A task's status, with the facts the panel shows beside it. */
export interface TaskStatusView extends ConciergeTaskStatusResult {
  waitingSince: number | null;
  /** What its task chat waits on its owner for now, as the DTO carries it. */
  openWait: ConciergeOpenWait | null;
  laterAt: number | null;
  /** When the wait Rome last ended for no response began, or null. */
  expiredWaitAt: number | null;
}

export class ConciergeTasks {
  private notSynced = new Set<string>();
  private facts: TaskFactSources | null = null;
  /** The status each task was last told with, so a fact that changes none tells nothing. */
  private told = new Map<string, string>();
  private statusListeners = new Set<(taskId: string, status: TaskStatusView) => void>();
  private endListeners = new Set<(row: ConciergeTaskRow) => void>();
  /** Per task, the keeping of when it ended that runs now (`keepEndedOf`). */
  private keeping = new Map<string, Promise<void>>();
  /** Task chats whose turn ended and whose outcome is not written yet. */
  private settling = new Map<string, number>();

  constructor(
    readonly repo: ConciergeTasksRepository,
    private readonly waitExpiryMs = CONCIERGE_TASK_WAIT_EXPIRY_MS,
  ) {
    // Any write by the Concierge settles the row, so this listener runs first
    // and the event the write sends already reads "synced".
    repo.onChange(({ row }, change) => {
      if (change === "write") this.notSynced.delete(row.id);
      // A fact on the row changed: when the task ended is kept from it. The
      // write told its listeners already.
      void this.keepEndedOf(row).catch((error: unknown) =>
        log.warn("failed to read a changed task's status", {
          taskId: row.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  /** Attaches where the facts come from; until then a task reads only its row. */
  attachFacts(facts: TaskFactSources | null): void {
    this.facts = facts;
  }

  /** The facts of each row, read now. */
  private async factsOf(
    rows: readonly ConciergeTaskRow[],
  ): Promise<Map<string, ConciergeTaskFacts & { openWait: ConciergeOpenWait | null }>> {
    const facts = this.facts;
    const chats = rows.flatMap((row) => (row.sessionId ? [row.sessionId] : []));
    const open =
      facts && chats.length > 0 ? await facts.openWaits(chats) : new Map<string, OpenWaitItem[]>();
    const waits = new Map(
      rows.map((row) => [
        row.id,
        row.sessionId
          ? currentWait(
              open.get(row.sessionId) ?? [],
              row.expiredWaitAt?.getTime() ?? null,
              this.waitExpiryMs,
            )
          : null,
      ]),
    );
    const pending = new Set(facts?.reportPending() ?? []);
    const later = (await facts?.laterOf?.(rows.map((row) => row.id))) ?? new Map<string, number>();
    const running = (chatId: string) => {
      try {
        return facts?.running(chatId) ?? false;
      } catch {
        return false;
      }
    };
    return new Map(
      rows.map((row) => [
        row.id,
        {
          stoppedAt: row.stoppedAt?.getTime() ?? null,
          waitingSince: waits.get(row.id)?.since ?? null,
          openWait: openWaitOf(waits.get(row.id) ?? null),
          running: row.sessionId
            ? running(row.sessionId) || this.settling.has(row.sessionId)
            : false,
          // Held in memory while the event waits, and on the row once the
          // chat's work ended, so a restart still knows it was never said.
          reportPending: pending.has(row.id) || row.outcomeUnsaid,
          laterAt: later.get(row.id) ?? legacyLaterOf(row, this.now()),
          lastOutcome: row.lastOutcome ?? null,
          started: row.linkedAt !== null || row.sessionId !== null || row.lastOutcome !== null,
          waitExpired: row.expiredWaitAt !== null,
        },
      ]),
    );
  }

  private now(): number {
    return this.facts?.now() ?? Date.now();
  }

  /**
   * Each row's status now. `asReported` reads it as it stands once its
   * waiting result is reported, as the Concierge is told it.
   */
  async statusOf(
    rows: readonly ConciergeTaskRow[],
    options: { asReported?: boolean } = {},
  ): Promise<Map<string, TaskStatusView>> {
    const facts = await this.factsOf(rows);
    if (options.asReported) for (const of of facts.values()) of.reportPending = false;
    const now = this.now();
    const read = new Map(
      rows.map((row) => {
        const of = facts.get(row.id) as ConciergeTaskFacts & { openWait: ConciergeOpenWait | null };
        return [
          row.id,
          {
            ...taskStatus(of, now, this.waitExpiryMs),
            waitingSince: of.waitingSince,
            openWait: of.openWait,
            laterAt: of.laterAt,
            expiredWaitAt: row.expiredWaitAt?.getTime() ?? null,
          },
        ];
      }),
    );
    // As the task is now, not as a report would leave it.
    if (!options.asReported) {
      for (const [taskId, status] of read) {
        for (const listener of this.statusListeners) listener(taskId, status);
      }
    }
    return read;
  }

  /**
   * Keeps on each row when its status ended, as read now, so the panel and
   * the Concierge's list age it from when it ended. Run where a fact
   * changes, never by a read: a read writes nothing.
   */
  private async keepEnded(
    rows: readonly ConciergeTaskRow[],
    read: Map<string, TaskStatusView>,
  ): Promise<void> {
    const ended = rows.filter((row) => read.get(row.id)?.status === "ended" && !row.endedAt);
    const reopened = rows.filter((row) => read.get(row.id)?.status !== "ended" && row.endedAt);
    if (ended.length === 0 && reopened.length === 0) return;
    const kept = await this.repo
      .keepEnded(
        ended.map((row) => row.id),
        reopened.map((row) => row.id),
        new Date(this.now()),
      )
      .then(
        () => true,
        (error: unknown) => {
          log.warn("failed to keep when tasks ended", {
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        },
      );
    if (!kept) return;
    for (const row of [...ended, ...reopened]) {
      for (const listener of this.endListeners) listener(row);
    }
  }

  /**
   * Keeps when task `row` ended, as its status reads now. One task's are kept
   * in the order its writes came, so an older read never overwrites a newer.
   */
  private keepEndedOf(row: ConciergeTaskRow): Promise<void> {
    const kept = (this.keeping.get(row.id) ?? Promise.resolve())
      .then(async () => {
        const now = (await this.repo.get(row.id)) ?? row;
        await this.keepEnded([now], await this.statusOf([now]));
      })
      .finally(() => {
        if (this.keeping.get(row.id) === kept) this.keeping.delete(row.id);
      });
    this.keeping.set(row.id, kept);
    return kept;
  }

  /**
   * Keeps when every task not archived ended, as at a start: facts held in
   * memory, such as a running turn, did not outlive the restart.
   */
  async keepEndedAll(): Promise<void> {
    const rows = (await this.repo.listForAgent(true)).map((task) => task.row);
    await this.keepEnded(rows, await this.statusOf(rows));
  }

  /**
   * Task chat `chatId`'s turn ended and its outcome is being written: the
   * task reads as running until then. Returns the release.
   */
  holdRunning(chatId: string): () => void {
    this.settling.set(chatId, (this.settling.get(chatId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.settling.get(chatId) ?? 1) - 1;
      if (left > 0) this.settling.set(chatId, left);
      else this.settling.delete(chatId);
    };
  }

  /** How long a wait on the owner keeps a task waiting for them, in milliseconds. */
  get waitExpiry(): number {
    return this.waitExpiryMs;
  }

  /** Calls `listener` with a task once it ended, or started again after it ended. Returns the unsubscribe. */
  onEnded(listener: (row: ConciergeTaskRow) => void): () => void {
    this.endListeners.add(listener);
    return () => {
      this.endListeners.delete(listener);
    };
  }

  /** Calls `listener` with each task's status whenever it is read. Returns the unsubscribe. */
  onStatus(listener: (taskId: string, status: TaskStatusView) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  toDto(
    { row, chat, conciergeChat, sourceMessageId }: ConciergeTaskWithChat,
    status: TaskStatusView,
  ): ConciergeTaskDto {
    return {
      id: row.id,
      title: row.title,
      state: legacyTaskState(status),
      status: status.status,
      endReason: status.endReason,
      waitingSince: status.waitingSince,
      openWait: status.openWait,
      laterAt: finiteOrNull(status.laterAt),
      summary: row.summary,
      waitingOn: row.waitingOn,
      dueAt: row.dueAt?.getTime() ?? null,
      rank: row.rank,
      chat,
      threadRoot: row.threadRoot ?? null,
      conciergeChat,
      sourceMessageId,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      // When it ended, as its status read it; the panel ages ended rows by it.
      completedAt: (row.endedAt ?? row.completedAt)?.getTime() ?? null,
      archivedAt: row.archivedAt?.getTime() ?? null,
      notSynced: this.notSynced.has(row.id),
    };
  }

  /** The rows' DTOs, with their status read now. */
  async toDtos(tasks: readonly ConciergeTaskWithChat[]): Promise<ConciergeTaskDto[]> {
    const status = await this.statusOf(tasks.map((task) => task.row));
    // A read tells no one: only a re-check records what it told, so a read
    // between a fact and its re-check never hides the change from the push.
    return tasks.map((task) => this.toDto(task, status.get(task.row.id) as TaskStatusView));
  }

  /** One owner's panel rows: every open row, and the finished ones of the last `doneDays` days. */
  async listForPanel(
    owner: ConciergeOwner = GUARDIAN_OWNER,
    doneDays = CONCIERGE_DONE_DAYS,
    now = Date.now(),
  ): Promise<ConciergeTaskDto[]> {
    const rows = await this.repo.listForPanel(new Date(now - doneDays * DAY_MS));
    return this.toDtos(rows.filter((row) => row.owner === owner));
  }

  /**
   * The panel rows of one Concierge chat of `owner`, as {@link listForPanel}
   * reads them. A row's status is read only for this chat's rows.
   */
  async listForChatPanel(
    owner: ConciergeOwner,
    chatId: string,
    doneDays = CONCIERGE_DONE_DAYS,
    now = Date.now(),
  ): Promise<ConciergeTaskDto[]> {
    const rows = await this.repo.listForPanel(new Date(now - doneDays * DAY_MS));
    return this.toDtos(
      rows.filter((row) => row.owner === owner && row.conciergeChat.id === chatId),
    );
  }

  /** Emits `task_upsert` for every change of one owner's rows. Returns the unsubscribe. */
  subscribe(emit: LiveEventEmit, owner: ConciergeOwner = GUARDIAN_OWNER): () => void {
    // Each change is told in the order it happened: reading a row's status
    // takes a moment, and a later change must never overtake an earlier one.
    let told: Promise<void> = Promise.resolve();
    return this.repo.onChange((task) => {
      if (task.owner !== owner) return;
      const dto = this.toDtos([task]);
      told = told
        .then(() => dto)
        .then(([read]) => emit("task_upsert", { task: read }))
        .catch((error: unknown) =>
          log.warn("failed to tell a task's change", {
            taskId: task.row.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    });
  }

  /**
   * A fact of task chat `chatId` changed: its turn, a card, an approval. Its
   * task is told again when its status changed.
   */
  async chatChanged(chatId: string): Promise<void> {
    const row = await this.repo.findBySession(chatId);
    if (row) await this.recheck(row);
  }

  /** A fact of task `taskId` changed, such as its result waiting to be reported. */
  async taskChanged(taskId: string): Promise<void> {
    const row = await this.repo.get(taskId);
    if (row) await this.recheck(row);
  }

  private async recheck(row: ConciergeTaskRow): Promise<void> {
    const read = await this.statusOf([row]);
    await this.keepEnded([row], read);
    const of = read.get(row.id) as TaskStatusView;
    if (this.told.get(row.id) === keyOf(of)) return;
    this.told.set(row.id, keyOf(of));
    await this.repo.reannounce(row.id);
  }

  /** Marks a row the Concierge did not pick up events for. A write clears the mark. */
  markNotSynced(taskId: string): void {
    if (this.notSynced.has(taskId)) return;
    this.notSynced.add(taskId);
    void this.repo.reannounce(taskId);
  }
}

/**
 * A row planned or watched before checks named their task, with a time still
 * ahead, is later until then.
 */
function legacyLaterOf(row: ConciergeTaskRow, now: number): number | null {
  const due = row.dueAt?.getTime() ?? null;
  return (row.state === "next" || row.state === "watching") && due !== null && due > now
    ? due
    : null;
}

/**
 * Whether task `row`'s stop still holds over its task chat, so an approval
 * asked for there is the stopped work's: a stop by the Concierge or its
 * owner, which new words in the chat lift, or one by archiving or deleting
 * the chat, while the chat is still archived or gone. A chat unarchived
 * after it, or a row archived with its chat still open, is in use again.
 */
export function stopHolds(row: {
  stoppedAt: Date | null;
  stopReason: string | null;
  archivedAt: Date | null;
}): boolean {
  if (!row.stoppedAt) return false;
  if (row.stopReason === "archived") return row.archivedAt !== null;
  return true;
}

/**
 * A check time as it goes out: an event wait with no deadline is due at
 * Infinity, which has no date, so it goes out as none.
 */
export function finiteOrNull(at: number | null): number | null {
  return at !== null && Number.isFinite(at) ? at : null;
}

function keyOf(status: TaskStatusView): string {
  const wait = status.openWait ? `${status.openWait.kind}/${status.openWait.id}` : "";
  return `${status.status}:${status.endReason ?? ""}:${status.waitingSince ?? ""}:${wait}:${status.laterAt ?? ""}`;
}
