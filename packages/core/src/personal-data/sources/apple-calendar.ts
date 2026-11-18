// The calendar source: events from the guardian's iPhone, as entries. Data,
// not logic, like apple-health.ts. Contract: docs/personal-data.md.

import type { SourceSpec } from "../domain/source.js";

/** How far ahead of and back from each sync the phone sends events. */
const SYNCED_AHEAD_DAYS = 30;
const SYNCED_BACK_DAYS = 7;
/** A year past Rome's clock, so a skewed phone clock or a long event still
 *  ingests: what the phone sends is bounded by SYNCED_AHEAD_DAYS. */
const AHEAD_DAYS = 400;

export const APPLE_CALENDAR: SourceSpec = {
  source: "apple_calendar",
  title: "Calendar",
  note:
    "Pushed from the guardian's iPhone: every calendar on it, whichever account it comes from, " +
    "from 7 days ago to 30 days ahead. It syncs when the Rome app opens and a few times a day in the " +
    "background, so it can be hours behind: freshness.syncedThrough is the last sync. Events " +
    "deleted on the phone are removed at the next sync.",
  types: [
    {
      type: "events",
      shape: "entry",
      unit: "event",
      rollup: "sum",
      aheadDays: AHEAD_DAYS,
      syncedAheadDays: SYNCED_AHEAD_DAYS,
      syncedBackDays: SYNCED_BACK_DAYS,
      note:
        "One entry per event, each occurrence of a repeating one on its own: title, location, " +
        "notes, calendar, allDay, availability (busy, free, tentative, unavailable), status, " +
        "attendees, and id and occurrence for a live edit. For free or busy, count events whose " +
        "availability is not free and whose status is not canceled.",
      content: {
        id: { kind: "text" },
        occurrence: { kind: "text" },
        title: { kind: "text" },
        location: { kind: "text" },
        notes: { kind: "text", maxLength: 1000 },
        calendar: { kind: "text" },
        allDay: { kind: "flag" },
        availability: { kind: "text" },
        status: { kind: "text" },
        recurring: { kind: "flag" },
        attendees: { kind: "texts", maxLength: 100 },
        url: { kind: "text", maxLength: 500 },
      },
    },
  ],
  metadataKeys: [],
};
