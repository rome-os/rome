// Google Calendar: the connected account's primary calendar, through
// Composio's polling triggers. A follow names no target.

import {
  composioAdapter,
  fromComposio,
  identityOf,
  required,
  text,
} from "../../shared/composio.js";
import type { ComposioTriggerSpec, Watchable } from "../../types.js";
import { normalizeCalendar } from "./normalize.js";

export const CALENDAR_STARTING_SOON: ComposioTriggerSpec = {
  toolkit: "googlecalendar",
  slug: "GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER",
  // Composio fixes the lead time per trigger, and one calendar account is
  // connected at a time, so every follow hears ten minutes ahead.
  config: { calendarId: "primary", minutesBeforeStart: 10, includeAllDay: false },
};
/** Created, updated and deleted events with their attendees, which the narrower triggers lack. */
export const CALENDAR_EVENT_SYNC: ComposioTriggerSpec = {
  toolkit: "googlecalendar",
  slug: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER",
  config: { calendarId: "primary", showDeleted: true },
};
export const CALENDAR_RSVP: ComposioTriggerSpec = {
  toolkit: "googlecalendar",
  slug: "GOOGLECALENDAR_ATTENDEE_RESPONSE_CHANGED_TRIGGER",
  config: { calendarId: "primary" },
};

export const CALENDAR_WATCHABLE: Watchable = {
  source: "googlecalendar",
  label: "Google Calendar",
  target: null,
  // The connected account's primary calendar, so no trigger needs a filter.
  kinds: [
    {
      kind: "meeting_starting_soon",
      label: "Meetings starting soon",
      default: true,
      triggers: [fromComposio(CALENDAR_STARTING_SOON)],
    },
    {
      kind: "invitations_and_changes",
      label: "Invitations and changes to my events",
      default: true,
      triggers: [fromComposio(CALENDAR_EVENT_SYNC)],
    },
    {
      kind: "rsvp_changes",
      label: "Replies to invitations",
      default: false,
      triggers: [fromComposio(CALENDAR_RSVP)],
    },
  ],
  options: [
    {
      key: "events",
      label: "Events to hear about",
      type: "enum",
      values: [
        { value: "with_others", label: "Only meetings with other people" },
        { value: "all", label: "Also my own events without guests" },
      ],
      default: "with_others",
    },
  ],
};

export const calendarAdapter = composioAdapter({
  catalog: CALENDAR_WATCHABLE,
  triggers: [CALENDAR_STARTING_SOON, CALENDAR_EVENT_SYNC, CALENDAR_RSVP],
  // The primary calendar's id, which Google sets to the account's address.
  account: (env, service) =>
    identityOf(env, service, async () => {
      const data = await env.composio.read(service, {
        endpoint: "https://www.googleapis.com/calendar/v3/calendars/primary",
      });
      return required(service, text(data.id)?.toLowerCase());
    }),
  normalize: (_env, { type, payload, account, kinds }) =>
    normalizeCalendar(type, payload, { address: account, kinds }),
});
