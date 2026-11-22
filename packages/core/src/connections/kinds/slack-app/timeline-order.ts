// Slack names a message by its `ts`, `<seconds>.<microseconds>`, unique in its
// chat and ordered as the chat is.

/** Negative when `a` was said before `b`, positive after, 0 when the same. */
export function compareTs(a: string, b: string): number {
  const [aSeconds = "", aMicros = ""] = a.split(".");
  const [bSeconds = "", bMicros = ""] = b.split(".");
  if (aSeconds.length !== bSeconds.length) return aSeconds.length - bSeconds.length;
  if (aSeconds !== bSeconds) return aSeconds < bSeconds ? -1 : 1;
  const micros = aMicros.padEnd(6, "0");
  const other = bMicros.padEnd(6, "0");
  return micros === other ? 0 : micros < other ? -1 : 1;
}

/** The `ts` naming an instant, as Slack's `latest` and `oldest` take it. */
export function tsAt(at: Date): string {
  const ms = at.getTime();
  return `${Math.floor(ms / 1_000)}.${String((ms % 1_000) * 1_000).padStart(6, "0")}`;
}
