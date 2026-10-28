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
  if (sameDay) return new Intl.DateTimeFormat(undefined, time).format(date);

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    ...time,
  }).format(date);
}
