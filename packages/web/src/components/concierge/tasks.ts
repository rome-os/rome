// The Concierge's task list as the dashboard reads it. All pure, so it is
// tested without a DOM.

import type { ConciergeTaskDto } from "@rome/api-types/concierge";

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
