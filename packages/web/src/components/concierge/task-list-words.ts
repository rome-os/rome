// How the task list words its rows' times and schedules. All pure, so the
// wording is tested without a DOM.

import type { TaskListSchedule, TaskListTrigger } from "@rome/api-types/task-list";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The weekdays a schedule names, Monday first, as `Intl` counts them from a known Monday. */
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const RRULE_DAYS: Record<string, (typeof WEEKDAYS)[number]> = {
  MO: "mon",
  TU: "tue",
  WE: "wed",
  TH: "thu",
  FR: "fri",
  SA: "sat",
  SU: "sun",
};

/** "9:00", "21:30": a stored `HH:mm` as the locale writes a time of day. */
export function formatClock(hhmm: string, locale: string): string {
  const [hour, minute] = hhmm.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return hhmm;
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(2024, 0, 1, hour, minute),
  );
}

/** "Mon, Wed": weekdays by short name, in week order. */
function formatDays(days: readonly string[], locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { weekday: "short" });
  // 2024-01-01 was a Monday.
  const names = WEEKDAYS.flatMap((day, index) =>
    days.includes(day) ? [format.format(new Date(2024, 0, 1 + index))] : [],
  );
  return new Intl.ListFormat(locale, { style: "short", type: "unit" }).format(names);
}

/** "Daily at 9:00", "Mon, Wed at 9:00": when a task's schedule runs. */
export function describeTaskSchedule(
  schedule: TaskListSchedule,
  t: Translate,
  locale: string,
): string {
  const time = formatClock(schedule.at, locale);
  if (!schedule.days || schedule.days.length === 7) {
    return t("concierge.taskList.schedule.daily", { time });
  }
  return t("concierge.taskList.schedule.days", { days: formatDays(schedule.days, locale), time });
}

/** When a routine fires, in the words its row shows. */
export function describeRoutineTrigger(
  trigger: TaskListTrigger,
  t: Translate,
  locale: string,
): string {
  if (trigger.type === "manual") return t("concierge.taskList.schedule.manual");
  if (trigger.type === "event-bus") {
    return t("concierge.taskList.schedule.event", { event: trigger.eventName });
  }
  const time = formatClock(trigger.localTime, locale);
  if (trigger.date) {
    const date = new Date(`${trigger.date}T00:00:00`);
    const day = Number.isNaN(date.getTime())
      ? trigger.date
      : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
    return t("concierge.taskList.schedule.once", { date: day, time });
  }
  const rule = Object.fromEntries(
    (trigger.rrule ?? "")
      .toUpperCase()
      .split(";")
      .map((part) => part.split("=") as [string, string]),
  );
  const interval = rule.INTERVAL ? Number(rule.INTERVAL) : 1;
  if (rule.FREQ === "DAILY" && interval === 1)
    return t("concierge.taskList.schedule.daily", { time });
  if (rule.FREQ === "WEEKLY" && rule.BYDAY && interval === 1) {
    const days = rule.BYDAY.split(",").flatMap((day: string) =>
      RRULE_DAYS[day] ? [RRULE_DAYS[day]] : [],
    );
    if (days.length === 7) return t("concierge.taskList.schedule.daily", { time });
    return t("concierge.taskList.schedule.days", { days: formatDays(days, locale), time });
  }
  return t("concierge.taskList.schedule.other");
}
