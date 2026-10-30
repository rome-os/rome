// The Concierge's task list as the panel and the header pill read it. All
// pure, so the grouping and the pill's states are tested without a DOM.

import type { ConciergeTaskDto, ConciergeTaskState } from "@rome/api-types/concierge";
import { CONCIERGE_DONE_DAYS } from "@rome/api-types/concierge";

export type TaskGroupKey = "needsYou" | "doing" | "next" | "watching" | "done";

/** The groups in the order the panel shows them. */
const TASK_GROUP_ORDER: readonly TaskGroupKey[] = ["needsYou", "doing", "next", "watching", "done"];

const GROUP_OF_STATE: Record<ConciergeTaskState, TaskGroupKey> = {
  needs_user: "needsYou",
  doing: "doing",
  next: "next",
  watching: "watching",
  done: "done",
  dropped: "done",
};

const DAY_MS = 24 * 60 * 60 * 1000;

const groupOf = (task: Pick<ConciergeTaskDto, "state">): TaskGroupKey => GROUP_OF_STATE[task.state];

/** Missing values sort last. */
const byNullableAsc = (a: number | null, b: number | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;

const SORTERS: Record<TaskGroupKey, (a: ConciergeTaskDto, b: ConciergeTaskDto) => number> = {
  // The newest change first: it is what the guardian has not seen yet.
  needsYou: (a, b) => b.updatedAt - a.updatedAt,
  doing: (a, b) => b.updatedAt - a.updatedAt,
  // The Concierge's own order, then the order it planned them in.
  next: (a, b) => byNullableAsc(a.rank, b.rank) || a.createdAt - b.createdAt,
  // The soonest check first.
  watching: (a, b) => byNullableAsc(a.dueAt, b.dueAt) || b.updatedAt - a.updatedAt,
  done: (a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt),
};

export interface TaskGroup {
  key: TaskGroupKey;
  tasks: ConciergeTaskDto[];
  /** Finished rows older than the window, held back behind "show more". */
  hidden: number;
}

/**
 * The five groups, in order, with empty ones left out. Finished rows (done or
 * dropped) show for the last `doneDays` days by completion; older ones are
 * counted in `hidden` unless `showAllDone`. An archived row is in no group.
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
    if (key !== "done" || options.showAllDone) return [{ key, tasks: sorted, hidden: 0 }];
    const recent = sorted.filter((task) => (task.completedAt ?? task.updatedAt) >= since);
    // A group of only old rows shows its "show more" and nothing else.
    return [{ key, tasks: recent, hidden: sorted.length - recent.length }];
  });
}

export type PillState =
  | { kind: "needsYou"; count: number }
  | { kind: "doing"; count: number }
  | { kind: "idle" };

const countOf = (tasks: readonly ConciergeTaskDto[], state: ConciergeTaskState) =>
  tasks.filter((task) => task.state === state && task.archivedAt === null).length;

/** What the header pill shows: the Needs you count, else the Doing count, else a quiet icon. */
export function pillState(tasks: readonly ConciergeTaskDto[]): PillState {
  const needsYou = countOf(tasks, "needs_user");
  if (needsYou > 0) return { kind: "needsYou", count: needsYou };
  const doing = countOf(tasks, "doing");
  if (doing > 0) return { kind: "doing", count: doing };
  return { kind: "idle" };
}

export const needsYouCount = (tasks: readonly ConciergeTaskDto[]) => countOf(tasks, "needs_user");

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
 * The time that carries meaning on a row: when a watched or planned row is due,
 * and when a finished one finished. A row that needs the guardian or is being
 * worked on shows none, since the time it was last written says little.
 */
export function taskTime(
  task: Pick<ConciergeTaskDto, "state" | "dueAt" | "completedAt" | "updatedAt">,
): number | null {
  if (task.state === "watching" || task.state === "next") return task.dueAt;
  if (task.state === "done" || task.state === "dropped") return task.completedAt ?? task.updatedAt;
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
