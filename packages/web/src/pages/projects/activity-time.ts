const DAY_MS = 86_400_000;

// How long ago a project or chat was last active, in the dashboard's language:
// "3 hours ago" / "3小时前" within a week, then a short date.
export function activityTime(value: string | null, locale: string, now = Date.now()): string {
  const at = value ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) return "";
  const seconds = Math.min(0, Math.round((at - now) / 1_000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds > -60) return formatter.format(0, "second");
  if (seconds > -3_600) return formatter.format(Math.ceil(seconds / 60), "minute");
  if (seconds > -86_400) return formatter.format(Math.ceil(seconds / 3_600), "hour");
  if (seconds > (-7 * DAY_MS) / 1_000) return formatter.format(Math.ceil(seconds / 86_400), "day");
  const date = new Date(at);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}
