// The calendar source: events and reminders from the guardian's iPhone, as
// entries. Data, not logic, like apple-health.ts. Contract: docs/personal-data.md.

import type { SourceSpec } from "../domain/source.js";

/** A year past Rome's clock: the phone sends 30 days, a recurring series no further. */
const AHEAD_DAYS = 400;

export const APPLE_CALENDAR: SourceSpec = {
  source: "apple_calendar",
  title: "Calendar & Reminders",
  note:
    "Pushed from the guardian's iPhone: every calendar on it, whichever account it comes from, " +
    "and Reminders. Events from 7 days ago to 30 days ahead; open reminders and those completed " +
    "in the last 7 days. It syncs when the Rome app opens and a few times a day in the " +
    "background, so it can be hours behind: freshness.syncedThrough is the last sync. Events " +
    "deleted on the phone are removed at the next sync.",
  types: [
    {
      type: "events",
      shape: "entry",
      unit: "event",
      rollup: "sum",
      aheadDays: AHEAD_DAYS,
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
    {
      type: "reminders",
      shape: "entry",
      unit: "reminder",
      rollup: "sum",
      aheadDays: AHEAD_DAYS,
      note:
        "One entry per reminder, at its due time; one with no due date sits at when it was " +
        "made (hasDueDate false), so list open ones over a wide window. title, notes, list, " +
        "completed, completedAt, priority (1 high to 9 low, 0 none), and id for a live change.",
      content: {
        id: { kind: "text" },
        title: { kind: "text" },
        notes: { kind: "text", maxLength: 1000 },
        list: { kind: "text" },
        completed: { kind: "flag" },
        completedAt: { kind: "text" },
        hasDueDate: { kind: "flag" },
        priority: { kind: "number" },
        url: { kind: "text", maxLength: 500 },
      },
    },
  ],
  metadataKeys: [],
};
