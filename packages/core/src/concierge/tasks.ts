// The Concierge's task list as the dashboard reads it: the stored rows with
// their chat's name, each task's status derived from the facts Rome holds,
// and the "not synced" mark the event delivery keeps in memory.

import { CONCIERGE_DONE_DAYS, type ConciergeTaskDto } from "@rome/api-types/concierge";
import {
  CONCIERGE_TASK_WAIT_EXPIRY_MS,
  type ConciergeTaskFacts,
  type ConciergeTaskStatusResult,
  legacyTaskState,
  taskStatus,
} from "@rome/api-types/concierge-task-status";
import type { LiveEventEmit } from "../lib/live-event.js";
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
  /** When each task chat's newest unanswered card or approval began, epoch milliseconds. */
  waitingSince(chatIds: readonly string[]): Promise<Map<string, number>>;
  /** The tasks whose result waits for the Concierge turn that reports it. */
  reportPending(): readonly string[];
}

/** A task's status, with the facts the panel shows beside it. */
export interface TaskStatusView extends ConciergeTaskStatusResult {
  waitingSince: number | null;
  laterAt: number | null;
}

export class ConciergeTasks {
  private notSynced = new Set<string>();
  private facts: TaskFactSources | null = null;
  /** The status each task was last told with, so a fact that changes none tells nothing. */
  private told = new Map<string, string>();

  constructor(
    readonly repo: ConciergeTasksRepository,
    private readonly waitExpiryMs = CONCIERGE_TASK_WAIT_EXPIRY_MS,
  ) {
    // Any write by the Concierge settles the row, so this listener runs first
    // and the event the write sends already reads "synced".
    repo.onChange(({ row }, change) => {
      if (change === "write") this.notSynced.delete(row.id);
    });
  }

  /** Attaches where the facts come from; until then a task reads only its row. */
  attachFacts(facts: TaskFactSources | null): void {
    this.facts = facts;
  }

  /** The facts of each row, read now. */
  private async factsOf(
    rows: readonly ConciergeTaskRow[],
  ): Promise<Map<string, ConciergeTaskFacts>> {
    const facts = this.facts;
    const chats = rows.flatMap((row) => (row.sessionId ? [row.sessionId] : []));
    const since = facts && chats.length > 0 ? await facts.waitingSince(chats) : new Map();
    const pending = new Set(facts?.reportPending() ?? []);
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
          waitingSince: row.sessionId ? (since.get(row.sessionId) ?? null) : null,
          running: row.sessionId ? running(row.sessionId) : false,
          reportPending: pending.has(row.id),
          laterAt: laterOf(row, this.now()),
          lastOutcome: row.lastOutcome ?? null,
        },
      ]),
    );
  }

  private now(): number {
    return this.facts?.now() ?? Date.now();
  }

  /** Each row's status now. */
  async statusOf(rows: readonly ConciergeTaskRow[]): Promise<Map<string, TaskStatusView>> {
    const facts = await this.factsOf(rows);
    const now = this.now();
    return new Map(
      rows.map((row) => {
        const of = facts.get(row.id) as ConciergeTaskFacts;
        return [
          row.id,
          {
            ...taskStatus(of, now, this.waitExpiryMs),
            waitingSince: of.waitingSince,
            laterAt: of.laterAt,
          },
        ];
      }),
    );
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
      laterAt: status.laterAt,
      summary: row.summary,
      waitingOn: row.waitingOn,
      dueAt: row.dueAt?.getTime() ?? null,
      rank: row.rank,
      chat,
      conciergeChat,
      sourceMessageId,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      completedAt: row.completedAt?.getTime() ?? null,
      archivedAt: row.archivedAt?.getTime() ?? null,
      notSynced: this.notSynced.has(row.id),
    };
  }

  /** The rows' DTOs, with their status read now. */
  async toDtos(tasks: readonly ConciergeTaskWithChat[]): Promise<ConciergeTaskDto[]> {
    const status = await this.statusOf(tasks.map((task) => task.row));
    return tasks.map((task) => {
      const of = status.get(task.row.id) as TaskStatusView;
      this.told.set(task.row.id, keyOf(of));
      return this.toDto(task, of);
    });
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

  /** Emits `task_upsert` for every change of one owner's rows. Returns the unsubscribe. */
  subscribe(emit: LiveEventEmit, owner: ConciergeOwner = GUARDIAN_OWNER): () => void {
    return this.repo.onChange((task) => {
      if (task.owner !== owner) return;
      void this.toDtos([task])
        .then(([dto]) => emit("task_upsert", { task: dto }))
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
    const of = (await this.statusOf([row])).get(row.id) as TaskStatusView;
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
 * When a task's next check is due. Until checks link their task, it is the
 * time the row names, while still ahead.
 */
function laterOf(row: ConciergeTaskRow, now: number): number | null {
  const due = row.dueAt?.getTime() ?? null;
  return due !== null && due > now ? due : null;
}

function keyOf(status: TaskStatusView): string {
  return `${status.status}:${status.endReason ?? ""}:${status.waitingSince ?? ""}:${status.laterAt ?? ""}`;
}
