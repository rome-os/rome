import { describe, expect, it } from "@rstest/core";
import { CALENDAR_WATCHABLE } from "./index.js";
import { normalizeCalendar, whenOf } from "./normalize.js";

// Payloads shaped as Composio's googlecalendar trigger docs list them
// (docs.composio.dev/toolkits/googlecalendar), with Google's attendee objects.
describe("normalizeCalendar", () => {
  const address = "me@example.com";
  const all = { address, kinds: new Set(CALENDAR_WATCHABLE.kinds.map((k) => k.kind)) };
  const SOON = "googlecalendar_event_starting_soon_trigger";
  const SYNC = "googlecalendar_google_calendar_event_sync_trigger";
  const RSVP = "googlecalendar_attendee_response_changed_trigger";
  const attendees = [
    { email: "ana@x.io", displayName: "Ana", organizer: true, responseStatus: "accepted" },
    { email: "Me@Example.com", self: true, responseStatus: "needsAction" },
    { email: "room-4@resource.calendar.google.com", resource: true, responseStatus: "accepted" },
  ];
  const synced = (extra: Record<string, unknown> = {}) => ({
    calendar_id: "primary",
    event_id: "evt1",
    event_type: "created",
    status: "confirmed",
    summary: "Design review",
    description: "Agenda in the doc",
    location: "Room 4",
    start_time: "2026-11-05T15:00:00+08:00",
    end_time: "2026-11-05T16:00:00+08:00",
    created_at: "2026-11-04T09:00:00Z",
    updated_at: "2026-11-04T09:00:00Z",
    html_link: "https://www.google.com/calendar/event?eid=ZXZ0MQ",
    hangout_link: "https://meet.google.com/abc-defg-hij",
    organizer_email: "ana@x.io",
    organizer_name: "Ana Lima",
    creator_email: "ana@x.io",
    attendees,
    ...extra,
  });

  it("gives an invitation in the common shape, direct and waiting for the guardian's reply", () => {
    expect(normalizeCalendar(SYNC, synced(), all)).toEqual({
      keep: true,
      event: {
        id: "googlecalendar:me@example.com:evt1:invite:2026-11-04T09:00:00Z",
        source: "googlecalendar",
        kind: "invitations_and_changes",
        actor: "Ana Lima",
        subject: "Design review",
        url: "https://www.google.com/calendar/event?eid=ZXZ0MQ",
        excerpt: "2026-11-05 15:00–16:00 (+08:00). At Room 4. Agenda in the doc.",
        byYou: false,
        addressedTo: "direct",
        labels: ["invite", "online", "needs-reply"],
      },
    });
  });

  it("labels a change and a cancellation, and keeps each change apart from a repeat", () => {
    const changed = normalizeCalendar(
      SYNC,
      synced({ event_type: "updated", updated_at: "2026-11-04T10:00:00Z" }),
      all,
    );
    expect(changed).toMatchObject({
      keep: true,
      event: { id: "googlecalendar:me@example.com:evt1:updated:2026-11-04T10:00:00Z" },
    });
    expect(changed.keep && changed.event.labels[0]).toBe("updated");
    const deleted = normalizeCalendar(
      SYNC,
      { calendar_id: "primary", event_id: "evt1", event_type: "deleted" },
      all,
    );
    expect(deleted).toMatchObject({ keep: true, event: { labels: ["canceled", "no-guests"] } });
    const cancelled = normalizeCalendar(
      SYNC,
      synced({ event_type: "updated", status: "cancelled" }),
      all,
    );
    expect(cancelled.keep && cancelled.event.labels[0]).toBe("canceled");
  });

  it("says the guardian did it when they organized or created the event", () => {
    const own = normalizeCalendar(
      SYNC,
      synced({
        organizer_email: address,
        organizer_name: undefined,
        creator_email: address,
        attendees: [{ email: address, self: true, organizer: true, responseStatus: "accepted" }],
      }),
      all,
    );
    expect(own).toMatchObject({
      keep: true,
      event: {
        byYou: true,
        addressedTo: "direct",
        labels: ["created", "organizer", "no-guests", "online"],
      },
    });
  });

  it("marks an optional invitation as a copy, and one the guardian is not on as other", () => {
    const optional = normalizeCalendar(
      SYNC,
      synced({ attendees: [{ email: address, self: true, optional: true }, attendees[0]] }),
      all,
    );
    expect(optional.keep && optional.event.addressedTo).toBe("copy");
    const notOn = normalizeCalendar(SYNC, synced({ attendees: [attendees[0]] }), all);
    expect(notOn.keep && notOn.event.addressedTo).toBe("other");
  });

  it("gives a meeting about to start with its time and the link to join", () => {
    const result = normalizeCalendar(
      SOON,
      {
        calendar_id: "primary",
        countdown_window_minutes: 60,
        event_id: "evt1",
        summary: "Design review",
        start_time: "2026-11-05T07:00:00Z",
        start_timestamp: 1793948400,
        minutes_until_start: 9.6,
        html_link: "https://www.google.com/calendar/event?eid=ZXZ0MQ",
        hangout_link: "https://meet.google.com/abc-defg-hij",
        organizer_email: "ana@x.io",
        attendees: attendees.map((a) => (a.self ? { ...a, responseStatus: "declined" } : a)),
      },
      all,
    );
    expect(result).toEqual({
      keep: true,
      event: {
        id: "googlecalendar:me@example.com:evt1:starting:1793948400",
        source: "googlecalendar",
        kind: "meeting_starting_soon",
        actor: "ana@x.io",
        subject: "Design review",
        url: "https://meet.google.com/abc-defg-hij",
        excerpt: "Starts 2026-11-05 07:00 (UTC), in 10 minutes.",
        byYou: false,
        addressedTo: "direct",
        labels: ["starting-soon", "online", "you-declined"],
      },
    });
  });

  it("gives an attendee's reply, by the guardian when it is their own", () => {
    const reply = {
      attendee_email: "ana@x.io",
      attendee_name: "Ana Lima",
      calendar_id: "primary",
      event_html_link: "https://www.google.com/calendar/event?eid=ZXZ0MQ",
      event_id: "evt1",
      event_summary: "Design review",
      previous_response_status: "needsAction",
      response_status: "declined",
    };
    expect(normalizeCalendar(RSVP, reply, all)).toEqual({
      keep: true,
      event: {
        id: "googlecalendar:me@example.com:evt1:rsvp:ana@x.io:needsaction:declined",
        source: "googlecalendar",
        kind: "rsvp_changes",
        actor: "Ana Lima",
        subject: "Design review",
        url: "https://www.google.com/calendar/event?eid=ZXZ0MQ",
        excerpt: "Ana Lima answered declined.",
        byYou: false,
        addressedTo: "other",
        labels: ["rsvp", "declined"],
      },
    });
    const mine = normalizeCalendar(RSVP, { ...reply, attendee_email: "ME@example.com" }, all);
    expect(mine.keep && mine.event.byYou).toBe(true);
  });

  it("drops only a kind the follow has off, an event with no id, and an unknown trigger", () => {
    const soonOnly = { address, kinds: new Set(["meeting_starting_soon"]) };
    expect(normalizeCalendar(SYNC, synced(), soonOnly)).toEqual({
      keep: false,
      reason: "not a kind this follow has on",
    });
    expect(normalizeCalendar(SYNC, synced({ event_id: undefined }), all)).toEqual({
      keep: false,
      reason: "no event id",
    });
    expect(normalizeCalendar("googlecalendar_event_created_trigger", synced(), all).keep).toBe(
      false,
    );
  });
});

describe("whenOf", () => {
  it("reads an event's time in its own zone, a day-long event, and a span of days", () => {
    expect(whenOf("2026-11-05T15:00:00+08:00", "2026-11-05T16:30:00+08:00")).toBe(
      "2026-11-05 15:00–16:30 (+08:00)",
    );
    expect(whenOf("2026-11-05", "2026-11-06")).toBe("2026-11-05, all day");
    expect(whenOf("2026-11-05T22:00:00Z", "2026-11-06T01:00:00Z")).toBe(
      "2026-11-05 22:00 – 2026-11-06 01:00 (UTC)",
    );
    expect(whenOf(undefined, undefined)).toBeUndefined();
  });
});
