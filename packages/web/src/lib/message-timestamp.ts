// Building an Intl.DateTimeFormat costs far more than formatting with one, and
// a transcript or the search list formats hundreds of timestamps, so each
// format is built once per browser locale.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = typeof navigator === "undefined" ? "" : navigator.language;
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    formatters.set(key, formatter);
  }
  return formatter;
}

// Relative-precision timestamp for a chat message: the closer the message is,
// the more of the date it drops, and it always carries the clock time. Same-day
// shows the time ("6:41 PM"), same-year adds month + day ("Jul 10, 6:41 PM"),
// anything older adds the year ("Dec 29, 2025, 6:41 PM"). The locale and the
// 12 or 24 hour clock come from the browser. Pure over (value, now) so tests
// pin the reference instant.
export function formatMessageTimestamp(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const time = { hour: "numeric", minute: "2-digit" } as const;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return formatterFor(time).format(date);

  return formatterFor({
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    ...time,
  }).format(date);
}
