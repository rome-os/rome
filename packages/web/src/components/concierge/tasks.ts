// The Concierge's task list as the panel reads it. All pure, so the grouping
// is tested without a DOM.

import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import { CONCIERGE_DONE_DAYS } from "@rome/api-types/concierge";
import { type ConciergeTaskStatus, taskStatusOfDto } from "@rome/api-types/concierge-task-status";

export type TaskGroupKey = "needsYou" | "active" | "later" | "ended";

/** The groups in the order the panel shows them. */
const TASK_GROUP_ORDER: readonly TaskGroupKey[] = ["needsYou", "active", "later", "ended"];

const GROUP_OF_STATUS: Record<ConciergeTaskStatus, TaskGroupKey> = {
  needs_you: "needsYou",
  active: "active",
  later: "later",
  ended: "ended",
};

const DAY_MS = 24 * 60 * 60 * 1000;

const groupOf = (task: ConciergeTaskDto): TaskGroupKey =>
  GROUP_OF_STATUS[taskStatusOfDto(task).status];

/** Missing values sort last. */
const byNullableAsc = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;

const endedAt = (task: ConciergeTaskDto) => task.completedAt ?? task.updatedAt;

const SORTERS: Record<TaskGroupKey, (a: ConciergeTaskDto, b: ConciergeTaskDto) => number> = {
  // The oldest wait first: it ends soonest.
  needsYou: (a, b) =>
    byNullableAsc(a.waitingSince ?? null, b.waitingSince ?? null) || b.updatedAt - a.updatedAt,
  // The newest change first: it is what the guardian has not seen yet.
  active: (a, b) => b.updatedAt - a.updatedAt,
  // The soonest check first.
  later: (a, b) => byNullableAsc(a.laterAt ?? null, b.laterAt ?? null) || b.updatedAt - a.updatedAt,
  ended: (a, b) => endedAt(b) - endedAt(a),
};

export interface TaskGroup {
  key: TaskGroupKey;
  tasks: ConciergeTaskDto[];
  /** Finished rows older than the window, held back behind "show more". */
  hidden: number;
}

/**
 * The four groups, in order, with empty ones left out. Ended rows show for the
 * last `doneDays` days; older ones are counted in `hidden` unless
 * `showAllDone`. An archived row is in no group.
 */
export function groupTasks(
  tasks: readonly ConciergeTaskDto[],
  options: { now: number; showAllDone?: boolean; doneDays?: number },
): TaskGroup[] {
  const since = options.now - (options.doneDays ?? CONCIERGE_DONE_DAYS) * DAY_MS;
  const groups = new Map<TaskGroupKey, ConciergeTaskDto[]>();
  for (const task of tasks) {
    if (task.archivedAt !== null) continue;
    const key = groupOf(task);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  return TASK_GROUP_ORDER.flatMap((key): TaskGroup[] => {
    const sorted = [...(groups.get(key) ?? [])].sort(SORTERS[key]);
    if (sorted.length === 0) return [];
    if (key !== "ended" || options.showAllDone) return [{ key, tasks: sorted, hidden: 0 }];
    const recent = sorted.filter((task) => endedAt(task) >= since);
    // A group of only old rows shows its "show more" and nothing else.
    return [{ key, tasks: recent, hidden: sorted.length - recent.length }];
  });
}

/** The rows of one Concierge chat: the panel and the header show only the chat they are opened in. */
export const tasksOfChat = (tasks: readonly ConciergeTaskDto[], chatId: string | null) =>
  tasks.filter((task) => task.conciergeChat.id === chatId);

/**
 * The list with one row written. A row archived by the Concierge leaves the
 * list. An event older than the row held (a late one) is ignored.
 */
export function applyTaskUpsert(
  tasks: readonly ConciergeTaskDto[],
  task: ConciergeTaskDto,
): ConciergeTaskDto[] {
  const held = tasks.find((candidate) => candidate.id === task.id);
  if (held && held.updatedAt > task.updatedAt) return [...tasks];
  const rest = tasks.filter((candidate) => candidate.id !== task.id);
  return task.archivedAt !== null ? rest : [...rest, task];
}

/**
 * The time that carries meaning on a row: when a later row's check is due,
 * and when an ended one ended. A row that needs the guardian or is at work
 * shows none, since the time it was last written says little.
 */
export function taskTime(task: ConciergeTaskDto): number | null {
  const { status } = taskStatusOfDto(task);
  if (status === "later") return task.laterAt ?? task.dueAt;
  if (status === "ended") return endedAt(task);
  return null;
}

/** "5 minutes ago", "in 2 hours": the time as the panel's rows say it. */
export function formatTaskTime(at: number, now: number, locale: string): string {
  const seconds = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const say = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
    // The short style dots its abbreviations ("in 25 min."), which reads as noise in a row.
    format
      .format(value, unit)
      .replaceAll(".", "");
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return say(Math.round(seconds / size), unit);
  }
  return say(0, "second");
}
