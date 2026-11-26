import { z } from "zod";
import { operation, pageOf, pageParams, pagination, text, token } from "./operation.js";

const calendarId = z
  .string()
  .regex(/^(?!\.{1,2}$)[a-zA-Z0-9_.@-]{1,256}$/)
  .default("primary");
const eventId = z.string().regex(/^[a-zA-Z0-9_@-]{1,256}$/);
const isoTime = z.iso
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
const time = z.union([isoTime, z.string().regex(/^-?[0-9]{1,12}$/)]);
const timeWindow = { startTime: time.optional(), endTime: time.optional() };
const list = { calendarId, ...timeWindow, ...pagination(50) };

function seconds(time: string) {
  return time.includes("T") ? String(Math.floor(Date.parse(time) / 1000)) : time;
}

function orderedWindow({ startTime, endTime }: { startTime?: string; endTime?: string }) {
  return (
    startTime === undefined ||
    endTime === undefined ||
    Number(seconds(startTime)) <= Number(seconds(endTime))
  );
}

function events(calendarId: string) {
  return `/open-apis/calendar/v4/calendars/${calendarId}/events`;
}

const eventTime = z
  .object({ timestamp: text, date: text })
  .transform((t) => t.timestamp ?? t.date)
  .optional();
const event = z.object({
  event_id: eventId,
  summary: text,
  description: text,
  start_time: eventTime,
  end_time: eventTime,
  status: text,
});
function eventInfo(e: z.infer<typeof event>) {
  return {
    eventId: e.event_id,
    summary: e.summary,
    description: e.description,
    startTime: e.start_time,
    endTime: e.end_time,
    status: e.status,
  };
}
const eventDetails = event.extend({
  app_link: text,
  location: z.object({ name: text, address: text }).optional(),
});
const eventListItem = event
  .extend({ organizer_calendar_id: text })
  .transform((e) => ({ ...eventInfo(e), organizerCalendarId: e.organizer_calendar_id }));

export const calendarOperations = [
  operation(
    "calendar.events.list",
    "List events in a calendar.",
    z
      .strictObject({
        ...list,
        anchorTime: time
          .optional()
          .describe("Start pagination at this ISO 8601 time or Unix second."),
        pageSize: z.int().min(50).max(200).default(50),
      })
      .refine(orderedWindow)
      .refine(
        ({ anchorTime, pageToken, startTime, endTime }) =>
          [
            anchorTime !== undefined,
            pageToken !== undefined,
            startTime !== undefined || endTime !== undefined,
          ].filter(Boolean).length <= 1,
        { message: "Use a time window, an anchor time, or a page token." },
      ),
    async (input, request) => {
      const page = await request(
        {
          method: "GET",
          url: events(input.calendarId),
          params: {
            ...pageParams(input),
            anchor_time: input.anchorTime && seconds(input.anchorTime),
            start_time: input.startTime && seconds(input.startTime),
            end_time: input.endTime && seconds(input.endTime),
          },
        },
        pageOf(eventListItem),
      );
      return { calendarId: input.calendarId, ...page };
    },
  ),
  operation(
    "calendar.event.get",
    "Read one calendar event.",
    z.strictObject({ calendarId, eventId }),
    async ({ calendarId, eventId }, request) => {
      const { event } = await request(
        { method: "GET", url: `${events(calendarId)}/${eventId}` },
        z.object({ event: eventDetails }),
      );
      return {
        calendarId,
        ...eventInfo(event),
        location: event.location?.name ?? event.location?.address,
        url: event.app_link,
      };
    },
  ),
  operation(
    "calendar.events.search",
    "Search events in a calendar.",
    z.strictObject({ ...list, query: z.string().min(1).max(200) }).refine(orderedWindow),
    async (input, request) => {
      const page = await request(
        {
          method: "POST",
          url: events(input.calendarId) + "/search",
          params: pageParams(input),
          data: {
            query: input.query,
            filter:
              input.startTime || input.endTime
                ? {
                    start_time: input.startTime && { timestamp: seconds(input.startTime) },
                    end_time: input.endTime && { timestamp: seconds(input.endTime) },
                  }
                : undefined,
          },
        },
        z.object({ items: z.array(event), page_token: text, has_more: z.boolean().optional() }),
      );
      return {
        calendarId: input.calendarId,
        items: page.items.map(eventInfo),
        hasMore: page.has_more ?? Boolean(page.page_token),
        pageToken: page.page_token,
      };
    },
  ),
  operation(
    "calendar.event.create",
    "Create a calendar event. Inviting attendees also requires calendar:calendar.event:update.",
    z
      .strictObject({
        calendarId,
        summary: z.string().min(1).max(200),
        description: z.string().max(4000).optional(),
        startTime: isoTime,
        endTime: isoTime,
        attendeeOpenIds: z
          .array(z.string().regex(/^ou_[a-zA-Z0-9_-]{1,125}$/))
          .max(20)
          .optional(),
      })
      .refine((v) => Number(seconds(v.endTime)) > Number(seconds(v.startTime)), {
        message: "End must follow start.",
      }),
    async (input, request) => {
      const url = events(input.calendarId);
      const { event } = await request(
        {
          method: "POST",
          url,
          data: {
            summary: input.summary,
            description: input.description,
            start_time: { timestamp: seconds(input.startTime) },
            end_time: { timestamp: seconds(input.endTime) },
          },
        },
        z.object({ event: eventDetails }),
      );
      const ids = input.attendeeOpenIds;
      let attendeesAdded: number | undefined;
      if (ids?.length) {
        const result = await request(
          {
            method: "POST",
            url: `${url}/${event.event_id}/attendees`,
            params: { user_id_type: "open_id" },
            data: { attendees: ids.map((id) => ({ type: "user", user_id: id })) },
          },
          z.object({ attendees: z.array(z.object({})).optional() }),
        );
        attendeesAdded = result.attendees?.length ?? ids.length;
      }
      return {
        calendarId: input.calendarId,
        eventId: event.event_id,
        summary: event.summary ?? input.summary,
        startTime: event.start_time ?? seconds(input.startTime),
        endTime: event.end_time ?? seconds(input.endTime),
        url: event.app_link,
        attendeesAdded,
      };
    },
    {
      sideEffects: "write",
      approvalRequired: true,
      approvalPreview: {
        summary: "Create Feishu calendar event",
        fields: [
          { label: "Calendar", inputPointer: "/calendarId" },
          { label: "Summary", inputPointer: "/summary" },
          { label: "Start", inputPointer: "/startTime" },
          { label: "End", inputPointer: "/endTime" },
          { label: "Attendees", inputPointer: "/attendeeOpenIds" },
        ],
      },
    },
  ),
];

const message = z
  .object({
    message_id: z.string(),
    root_id: text,
    parent_id: text,
    msg_type: z.string(),
    create_time: z.string(),
    update_time: text,
    sender: z.object({ id: text, id_type: text, sender_type: text }).optional(),
    body: z.object({ content: z.string() }),
  })
  .transform((m) => ({
    messageId: m.message_id,
    rootId: m.root_id,
    parentId: m.parent_id,
    msgType: m.msg_type,
    createTime: m.create_time,
    updateTime: m.update_time,
    sender: m.sender && {
      id: m.sender.id,
      idType: m.sender.id_type,
      senderType: m.sender.sender_type,
    },
    bodyContent: m.body.content,
  }));

export const messagesList = operation(
  "im.messages.list",
  "List messages in a chat accessible to the bot. Group chats also require im:message.group_msg.",
  z
    .strictObject({
      chatId: token,
      ...timeWindow,
      sortOrder: z.enum(["asc", "desc"]).optional(),
      ...pagination(50),
    })
    .refine(orderedWindow),
  async (input, request) => {
    const page = await request(
      {
        method: "GET",
        url: "/open-apis/im/v1/messages",
        params: {
          container_id_type: "chat",
          container_id: input.chatId,
          ...pageParams(input),
          sort_type:
            input.sortOrder && (input.sortOrder === "asc" ? "ByCreateTimeAsc" : "ByCreateTimeDesc"),
          start_time: input.startTime && seconds(input.startTime),
          end_time: input.endTime && seconds(input.endTime),
        },
      },
      pageOf(message),
    );
    return { chatId: input.chatId, ...page };
  },
);
