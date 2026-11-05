// A Google Calendar event in the common shape: a meeting about to start, an
// invitation or a change to an event, or an attendee's reply. The time reads
// in the excerpt, since the common shape has no time field.

import { drop, labelsOf, obj, str } from "../../shared/event.js";
import { excerptOf, subjectOf } from "../../shared/text.js";
import type { AddressedTo, Json, Normalized, WatchEvent } from "../../types.js";

export interface CalendarContext {
  /** The connected account's address, which is its primary calendar's id. */
  address: string;
  /** The kinds the follow has on. */
  kinds: ReadonlySet<string>;
}

interface Attendee {
  email?: string;
  self: boolean;
  organizer: boolean;
  optional: boolean;
  resource: boolean;
  response?: string;
}

/** Google's attendee objects, or bare addresses when Composio flattens them. */
function attendeesOf(value: unknown): Attendee[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const a = typeof item === "string" ? { email: item } : obj(item);
    return {
      email: str(a.email)?.toLowerCase(),
      self: a.self === true,
      organizer: a.organizer === true,
      optional: a.optional === true,
      resource: a.resource === true,
      response: str(a.responseStatus ?? a.response_status),
    };
  });
}

const ISO_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * When an event runs, in the time zone the event carries: `2026-11-04 15:00–16:00
 * (+08:00)`, or `2026-11-04, all day`. The common shape has no time field, so
 * the time reads as text in the excerpt.
 */
export function whenOf(start: string | undefined, end: string | undefined): string | undefined {
  if (!start) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return `${start}, all day`;
  const from = ISO_TIME.exec(start);
  if (!from) return start;
  const [, day, time, zone] = from;
  const to = end ? ISO_TIME.exec(end) : null;
  const until = to ? (to[1] === day ? `–${to[2]}` : ` – ${to[1]} ${to[2]}`) : "";
  const tz = zone === undefined ? "" : zone === "Z" ? " (UTC)" : ` (${zone})`;
  return `${day} ${time}${until}${tz}`;
}

const SYNC = "googlecalendar_google_calendar_event_sync_trigger";

/**
 * A cancellation that names only its id, filled in from the event itself:
 * Google still returns a cancelled event, usually with its title and time.
 * The read is optional. When it fails or finds nothing to show, the bare
 * cancellation goes on as it came, and nothing is retried.
 */
export async function withCancelledEvent(
  type: string,
  payload: Json,
  read: (eventId: string) => Promise<Json>,
): Promise<Json> {
  const eventId = str(payload.event_id);
  const canceled =
    str(payload.event_type)?.toLowerCase() === "deleted" ||
    str(payload.status)?.toLowerCase() === "cancelled";
  if (type !== SYNC || !canceled || !eventId || str(payload.summary)) return payload;
  const found = await read(eventId).catch(() => undefined);
  if (!found) return payload;
  const summary = str(found.summary);
  const start = str(obj(found.start).dateTime) ?? str(obj(found.start).date);
  if (!summary && !start) return payload;
  const end = str(obj(found.end).dateTime) ?? str(obj(found.end).date);
  const fill = (key: string, value: unknown) =>
    payload[key] === undefined && value !== undefined ? { [key]: value } : {};
  return {
    ...payload,
    ...fill("summary", summary),
    ...fill("start_time", start),
    ...fill("end_time", end),
    ...fill("html_link", str(found.htmlLink)),
    ...fill("organizer_email", str(obj(found.organizer).email)),
    ...fill("attendees", Array.isArray(found.attendees) ? found.attendees : undefined),
  };
}

/** Sentences joined into one excerpt, each ending in its own stop. */
export const sentences = (...parts: (string | undefined)[]) =>
  parts
    .filter((part): part is string => Boolean(part))
    .map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`))
    .join(" ");

/** A raw Calendar event of `type` in the common shape, or why it is not one. */
export function normalizeCalendar(type: string, payload: Json, ctx: CalendarContext): Normalized {
  const me = ctx.address.toLowerCase();
  const eventId = str(payload.event_id);
  if (!eventId) return drop("no event id");
  const event = (
    kind: string,
    id: string,
    fields: Omit<WatchEvent, "id" | "source" | "kind" | "labels"> & {
      labels: (string | false | undefined)[];
    },
  ): Normalized => {
    if (!ctx.kinds.has(kind)) return drop("not a kind this follow has on");
    const subject = subjectOf(fields.subject);
    const excerpt = excerptOf(fields.excerpt);
    return {
      keep: true,
      event: {
        id: `googlecalendar:${me}:${eventId}:${id}`,
        source: "googlecalendar",
        kind,
        ...(fields.actor ? { actor: fields.actor } : {}),
        ...(subject ? { subject } : {}),
        ...(fields.url ? { url: fields.url } : {}),
        ...(excerpt ? { excerpt } : {}),
        byYou: fields.byYou,
        addressedTo: fields.addressedTo,
        labels: labelsOf(...fields.labels),
      },
    };
  };

  // What the starting-soon and sync payloads share: the organizer, the
  // attendees, and the guardian's place among them.
  const attendees = attendeesOf(payload.attendees);
  const mine = attendees.find((a) => a.self || a.email === me);
  const organizer = str(payload.organizer_email)?.toLowerCase();
  const organizedByYou =
    (organizer !== undefined ? organizer === me : false) || mine?.organizer === true;
  // An organizer who is not the guardian is another person at the meeting,
  // whether or not Google lists them among the attendees.
  const guests = [
    ...attendees.filter((a) => !a.resource && a !== mine && a.email !== me),
    ...(organizer !== undefined && organizer !== me && !attendees.some((a) => a.email === organizer)
      ? [{ email: organizer }]
      : []),
  ];
  const addressedTo: AddressedTo =
    organizedByYou || (mine !== undefined && !mine.optional)
      ? "direct"
      : mine?.optional
        ? "copy"
        : attendees.length === 0 && (organizer === undefined || organizer === me)
          ? "direct"
          : "other";
  const meeting = {
    actor: str(payload.organizer_name) ?? organizer,
    subject: str(payload.summary),
    addressedTo,
  };
  const shared = [
    organizedByYou && "organizer",
    guests.length === 0 && "no-guests",
    str(payload.recurring_event_id) && "recurring",
    (str(payload.hangout_link) || Object.keys(obj(payload.conference_data)).length > 0) && "online",
    mine?.response === "needsAction" && "needs-reply",
    mine?.response === "declined" && "you-declined",
    mine?.response === "tentative" && "you-tentative",
  ];
  const where = str(payload.location) && `At ${str(payload.location)}`;

  switch (type) {
    case "googlecalendar_event_starting_soon_trigger": {
      const start = str(payload.start_time);
      const left =
        typeof payload.minutes_until_start === "number" ? payload.minutes_until_start : undefined;
      const inMinutes =
        left === undefined ? undefined : `in ${Math.max(0, Math.round(left))} minutes`;
      return event(
        "meeting_starting_soon",
        `starting:${str(payload.start_timestamp) ?? start ?? ""}`,
        {
          ...meeting,
          // The join link is what the guardian needs a few minutes ahead.
          url: str(payload.hangout_link) ?? str(payload.html_link),
          excerpt: sentences(
            [whenOf(start, undefined) && `Starts ${whenOf(start, undefined)}`, inMinutes]
              .filter(Boolean)
              .join(", ") || undefined,
            where,
            str(payload.description),
          ),
          byYou: false,
          labels: ["starting-soon", ...shared],
        },
      );
    }
    case "googlecalendar_google_calendar_event_sync_trigger": {
      const change = str(payload.event_type)?.toLowerCase();
      const canceled = change === "deleted" || str(payload.status)?.toLowerCase() === "cancelled";
      const created = change === "created" && !canceled;
      const createdByYou = str(payload.creator_email)?.toLowerCase() === me;
      const what = canceled
        ? "canceled"
        : created
          ? mine && !organizedByYou && !createdByYou
            ? "invite"
            : "created"
          : "updated";
      return event(
        "invitations_and_changes",
        `${what}:${str(payload.updated_at) ?? str(payload.created_at) ?? ""}`,
        {
          ...meeting,
          url: str(payload.html_link),
          excerpt: sentences(
            whenOf(str(payload.start_time), str(payload.end_time)),
            where,
            str(payload.description),
          ),
          // Only a new event names who did it: its creator. A change or a
          // cancellation names no editor, and a guest may edit too, so it is
          // not said to be the guardian's. Ownership stays in the labels.
          byYou: created && createdByYou,
          labels: [what, ...shared],
        },
      );
    }
    case "googlecalendar_attendee_response_changed_trigger": {
      const who = str(payload.attendee_email)?.toLowerCase();
      const response = str(payload.response_status)?.toLowerCase();
      const name = str(payload.attendee_name) ?? who;
      const before = str(payload.previous_response_status)?.toLowerCase();
      return event("rsvp_changes", `rsvp:${who ?? ""}:${before ?? ""}:${response ?? ""}`, {
        actor: name,
        subject: str(payload.event_summary),
        url: str(payload.event_html_link),
        excerpt: name && response ? sentences(`${name} answered ${response}`) : undefined,
        byYou: who === me,
        // The payload names no organizer, so whether the event is the
        // guardian's own is not known here.
        addressedTo: "other",
        labels: ["rsvp", response && /^[a-z]+$/.test(response) && response],
      });
    }
    default:
      return drop(`Google Calendar ${type} is not a kind follows describe`);
  }
}
