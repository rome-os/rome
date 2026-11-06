// Session and weekly limits exhaust the subscription. Single-model limits do
// not, and the CLI's temporary server limit explicitly denies usage exhaustion.
export const ANTHROPIC_USAGE_LIMIT_RE =
  /^(?![\s\S]*\bnot your usage limit\b)[\s\S]*\b(?:usage limit|hit your (?:session|weekly) limit)\b/i;

/** Whether a failed Claude turn's error text denotes an exhausted usage limit. */
export function isAnthropicUsageLimitError(message: unknown): boolean {
  return typeof message === "string" && ANTHROPIC_USAGE_LIMIT_RE.test(message);
}

/** Returns a bounded future reset instant for the CLI's session/weekly wording. */
export function anthropicUsageLimitReset(message: string, now = new Date()): string | undefined {
  if (!isAnthropicUsageLimitError(message)) return undefined;
  const match = message.match(
    /hit your (session|weekly) limit\b.*?\bresets\s+(?:([A-Za-z]{3})\s+(\d{1,2}),\s+(?:(\d{4}),\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+\(([^)]+)\)/i,
  );
  if (!match) return undefined;
  const [, kind, month, day, year, hour, minute, period, timeZone] = match;
  if (+hour < 1 || +hour > 12 || +(minute ?? 0) > 59) return undefined;
  try {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const wall = (date: Date) => {
      const parts = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
      return Date.UTC(
        +parts.year,
        +parts.month - 1,
        +parts.day,
        +parts.hour,
        +parts.minute,
        +parts.second,
      );
    };
    const localNow = new Date(wall(now));
    const monthIndex = month
      ? "jan feb mar apr may jun jul aug sep oct nov dec".split(" ").indexOf(month.toLowerCase())
      : localNow.getUTCMonth();
    if (monthIndex < 0) return undefined;
    const target = Date.UTC(
      +(year ?? localNow.getUTCFullYear()),
      monthIndex,
      +(day ?? localNow.getUTCDate()),
      (+hour % 12) + (period.toLowerCase() === "pm" ? 12 : 0),
      +(minute ?? 0),
    );
    if (
      month &&
      (new Date(target).getUTCMonth() !== monthIndex || new Date(target).getUTCDate() !== +day)
    )
      return undefined;
    const resolve = (local: number) => {
      let instant = local;
      // Correct the zone offset, then verify the wall time to reject DST gaps.
      for (let i = 0; i < 3; i++) instant += local - wall(new Date(instant));
      return wall(new Date(instant)) === local ? instant : NaN;
    };
    let reset = resolve(target);
    if (!month && reset <= now.getTime()) reset = resolve(target + 86_400_000);
    const delta = reset - now.getTime();
    return delta > 0 && delta <= (kind.toLowerCase() === "session" ? 5 * 3_600_000 : 7 * 86_400_000)
      ? new Date(reset).toISOString()
      : undefined;
  } catch {
    return undefined;
  }
}
