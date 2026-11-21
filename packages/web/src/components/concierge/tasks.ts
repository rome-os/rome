// The Concierge's task list as the dashboard reads it. All pure, so it is
// tested without a DOM.

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
