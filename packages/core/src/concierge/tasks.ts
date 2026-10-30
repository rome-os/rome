// The Concierge's task list as the dashboard reads it: the stored rows with
// their chat's name, and the "not synced" mark the event delivery keeps in
// memory.

import { CONCIERGE_DONE_DAYS, type ConciergeTaskDto } from "@rome/api-types/concierge";
import type { LiveEventEmit } from "../lib/live-event.js";
import type {
  ConciergeTasksRepository,
  ConciergeTaskWithChat,
} from "../db/repositories/concierge-tasks.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export class ConciergeTasks {
  private notSynced = new Set<string>();

  constructor(readonly repo: ConciergeTasksRepository) {
    // Any write by the Concierge settles the row, so this listener runs first
    // and the event the write sends already reads "synced".
    repo.onChange(({ row }, change) => {
      if (change === "write") this.notSynced.delete(row.id);
    });
  }

  toDto({ row, chat }: ConciergeTaskWithChat): ConciergeTaskDto {
    return {
      id: row.id,
      title: row.title,
      state: row.state,
      summary: row.summary,
      waitingOn: row.waitingOn,
      dueAt: row.dueAt?.getTime() ?? null,
      rank: row.rank,
      chat,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      completedAt: row.completedAt?.getTime() ?? null,
      archivedAt: row.archivedAt?.getTime() ?? null,
      notSynced: this.notSynced.has(row.id),
    };
  }

  /** The panel's rows: every open row, and the finished ones of the last `doneDays` days. */
  async listForPanel(
    doneDays = CONCIERGE_DONE_DAYS,
    now = Date.now(),
  ): Promise<ConciergeTaskDto[]> {
    const rows = await this.repo.listForPanel(new Date(now - doneDays * DAY_MS));
    return rows.map((row) => this.toDto(row));
  }

  /** Emits `task_upsert` for every write. Returns the unsubscribe. */
  subscribe(emit: LiveEventEmit): () => void {
    return this.repo.onChange((task) => emit("task_upsert", { task: this.toDto(task) }));
  }

  /** Marks a row the Concierge did not pick up events for. A write clears the mark. */
  markNotSynced(taskId: string): void {
    if (this.notSynced.has(taskId)) return;
    this.notSynced.add(taskId);
    void this.repo.reannounce(taskId);
  }
}
