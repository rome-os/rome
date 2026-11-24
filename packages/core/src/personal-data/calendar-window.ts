// The guardian's calendar events in a window, read from the store for code
// that runs outside any turn, such as the Concierge's patrol. It reads what
// the phone synced and asks no device. Contract: docs/personal-data.md.

import { queryPersonalData } from "./read.js";
import type { PersonalDataRepository } from "./repository.js";
import { APPLE_CALENDAR } from "./sources/apple-calendar.js";

/** One calendar event, as the store holds it. */
export interface CalendarWindowEvent {
  start: string;
  end: string;
  title: string;
  allDay: boolean;
  location?: string;
  status?: string;
}

const MAX_EVENTS = 50;

/**
 * The events that start between `from` and `to`, epoch milliseconds, with
 * times in `timeZone`. Null when no calendar was ever synced, so a caller
 * can tell an empty day from no calendar.
 */
export function calendarWindow(
  repo: PersonalDataRepository,
  from: number,
  to: number,
  timeZone: string,
): CalendarWindowEvent[] | null {
  const answer = queryPersonalData(
    repo,
    APPLE_CALENDAR,
    {
      source: APPLE_CALENDAR.source,
      types: ["events"],
      start: new Date(from).toISOString(),
      end: new Date(to).toISOString(),
      timeZone,
      records: { limit: MAX_EVENTS },
    },
    { tz: timeZone, now: from },
  );
  if ("error" in answer) return null;
  const freshness = answer.freshness.events;
  const listed = answer.results.find(
    (result): result is Extract<typeof result, { records: unknown[] }> => "records" in result,
  );
  const records = (listed?.records ?? []) as Record<string, unknown>[];
  if (records.length === 0 && !freshness?.syncedThrough) return null;
  return records.flatMap((record) => {
    if (record.status === "canceled") return [];
    const { startISO, endISO, title, allDay, location, status } = record;
    if (typeof startISO !== "string" || typeof endISO !== "string") return [];
    return [
      {
        start: startISO,
        end: endISO,
        title: typeof title === "string" ? title : "",
        allDay: allDay === true,
        ...(typeof location === "string" && location ? { location } : {}),
        ...(typeof status === "string" ? { status } : {}),
      },
    ];
  });
}
