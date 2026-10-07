import type { RunListItem } from "./api";

export const KIND_LABEL: Record<RunListItem["kind"], string> = {
  dream: "Dream",
  skill_review: "Skill review",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One line naming what a run produced, for its row in the list. */
export function outcomeLine(run: RunListItem): string {
  switch (run.status) {
    case "running":
      return run.kind === "dream" ? "Dreaming…" : "Reviewing…";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Stopped before finishing";
    case "completed":
      break;
  }

  const { journal, memoryFiles, skills, otherFiles } = run.outcome;
  if (run.kind === "skill_review") {
    if (skills.length === 0) return "Nothing to save";
    return skills.map((s) => `${s.op === "write" ? "Saved" : "Updated"} ${s.name}`).join(", ");
  }

  const parts: string[] = [];
  if (journal) parts.push("Journal entry");
  if (memoryFiles > 0) parts.push(plural(memoryFiles, "memory file", "memory files"));
  if (otherFiles > 0) parts.push(plural(otherFiles, "other file", "other files"));
  return parts.length > 0 ? parts.join(" · ") : "No changes";
}

export function formatDuration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const seconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** "Today", "Yesterday", or a short date, in the given zone. */
function dayLabel(iso: string, timeZone: string, locale: string, now = new Date()): string {
  const date = new Date(iso);
  const key = dayKey(date, timeZone);
  if (key === dayKey(now, timeZone)) return "Today";
  if (key === dayKey(new Date(now.getTime() - 86_400_000), timeZone)) return "Yesterday";
  const sameYear = key.slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

/** Runs grouped under day headings, newest first, keeping the input order. */
export function groupByDay(
  runs: RunListItem[],
  timeZone: string,
  locale: string,
): Array<{ label: string; runs: RunListItem[] }> {
  const groups: Array<{ label: string; runs: RunListItem[] }> = [];
  for (const run of runs) {
    const label = dayLabel(run.startedAt, timeZone, locale);
    const last = groups.at(-1);
    if (last?.label === label) last.runs.push(run);
    else groups.push({ label, runs: [run] });
  }
  return groups;
}
