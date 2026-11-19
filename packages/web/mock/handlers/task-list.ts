import { http, HttpResponse } from "msw";
import {
  type TaskLinksResponse,
  type TaskListParts,
  type TaskListResponse,
  groupTaskList,
  pageTaskList,
} from "@rome/api-types/task-list";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import { legacyTaskState, taskStatus } from "@rome/api-types/concierge-task-status";
import { CONCIERGE_CHAT_ID } from "@/hooks/use-concierge";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A task row as the server sends it, with the status Rome derived for it. */
function task(
  id: string,
  title: string,
  status: NonNullable<ConciergeTaskDto["status"]>,
  extra: Partial<ConciergeTaskDto> = {},
): ConciergeTaskDto {
  const now = Date.now();
  const endReason = extra.endReason ?? (status === "ended" ? "done" : null);
  return {
    id,
    title,
    state: legacyTaskState({ status, endReason }),
    status,
    endReason,
    waitingSince: null,
    openWait: null,
    laterAt: null,
    chat: { id: `mock-task-chat-${id}`, name: title },
    conciergeChat: { id: CONCIERGE_CHAT_ID, name: "Main chat", main: true },
    sourceMessageId: null,
    createdAt: now - 3 * HOUR,
    updatedAt: now - 10 * MINUTE,
    completedAt: status === "ended" ? now - 2 * HOUR : null,
    archivedAt: null,
    notSynced: false,
    ...extra,
  };
}

/** The main chat's work: a row of every kind, so each group shows. Other chats have none. */
function fixture(): TaskListParts {
  const now = Date.now();
  return {
    tasks: [
      {
        kind: "task",
        task: task("launch-email", "Draft launch email", "needs_you", {
          chat: { id: "mock-task-question", name: "Draft launch email" },
          waitingSince: now - 20 * MINUTE,
          openWait: { kind: "approval", id: "approval-1", since: now - 20 * MINUTE },
        }),
        schedule: null,
        check: null,
      },
      {
        kind: "task",
        task: task("table", "Book a table for Friday", "needs_you", {
          waitingSince: Date.now() - 12 * MINUTE,
          openWait: { kind: "approval", id: "approval-2", since: Date.now() - 12 * MINUTE },
          sourceMessageId: `${CONCIERGE_CHAT_ID}-pm-2`,
        }),
        schedule: null,
        check: null,
      },
      {
        kind: "task",
        task: task("pr-review", "Review the open pull requests", "active"),
        schedule: null,
        check: null,
      },
      {
        kind: "task",
        task: task("visa", "Check the visa appointment", "later", { laterAt: now + 20 * MINUTE }),
        schedule: null,
        check: { id: "check-visa", at: now + 20 * MINUTE, recurring: false },
      },
      {
        kind: "task",
        task: task("morning-brief", "Morning brief", "later", { laterAt: now + 14 * HOUR }),
        schedule: { at: "08:00", days: ["mon", "tue", "wed", "thu", "fri"] },
        check: { id: "run-morning-brief", at: now + 14 * HOUR, recurring: true },
      },
      {
        kind: "task",
        task: task("hotel", "Compare hotels near Alfama", "ended"),
        schedule: null,
        check: null,
      },
      {
        kind: "task",
        task: task("passport", "Renew the passport", "ended", { endReason: "stopped" }),
        schedule: null,
        check: null,
      },
      {
        kind: "task",
        task: task("lease", "Summarize the lease penalties", "ended", { endReason: "failed" }),
        schedule: null,
        check: null,
      },
      {
        kind: "task",
        task: task("refund", "Ask for the train refund", "ended", { endReason: "no_response" }),
        schedule: null,
        check: null,
      },
    ],
    checks: [
      {
        kind: "check",
        check: {
          id: "check-package",
          name: "See if the package shipped",
          at: now + 3 * HOUR,
          waitingFor: null,
          taskId: null,
          taskTitle: null,
        },
      },
    ],
    follows: [
      {
        kind: "follow",
        source: "github",
        label: "GitHub",
        target: "rome-os/rome",
        state: "active",
        digestTimes: ["09:00", "18:00"],
        nextAt: now + 4 * HOUR,
      },
    ],
    routines: [
      {
        kind: "routine",
        id: "routine-daily-summary",
        name: "Daily summary",
        trigger: { type: "schedule", localTime: "21:00", rrule: "FREQ=DAILY", date: null },
        enabled: true,
        nextRunAt: now + 6 * HOUR,
        lastRun: { status: "error", firedAt: now - 18 * HOUR },
      },
      {
        // Made by a task chat's agent before scheduled tasks; its task has ended.
        kind: "routine",
        id: "routine-rome-releases",
        name: "Summarize Rome releases",
        trigger: { type: "schedule", localTime: "10:00", rrule: "FREQ=DAILY", date: null },
        enabled: true,
        nextRunAt: now + 19 * HOUR,
        lastRun: { status: "success", firedAt: now - 5 * HOUR },
        fromTask: { id: "task-rome-releases", title: "Rome releases" },
      },
    ],
  };
}

/** Each chat's work, made on first read and changed by the tab's actions. */
const stores = new Map<string, TaskListParts>();
const partsOf = (chatId: string): TaskListParts => {
  let parts = stores.get(chatId);
  if (!parts) {
    parts =
      chatId === CONCIERGE_CHAT_ID
        ? fixture()
        : { tasks: [], checks: [], follows: [], routines: [] };
    stores.set(chatId, parts);
  }
  return parts;
};

const notFound = (what: string) =>
  HttpResponse.json({ error: `No such ${what} in this chat` }, { status: 404 });

export const taskListHandlers = [
  http.get("/api/chats/:chatId/tasks", ({ params, request }) => {
    const chatId = String(params.chatId);
    return HttpResponse.json({
      chatId,
      groups: pageTaskList(
        groupTaskList(partsOf(chatId)),
        new URL(request.url).searchParams.get("endedBefore") ?? undefined,
      ),
    } satisfies TaskListResponse);
  }),
  // The task chats a message's task links name, by their ids.
  http.get("/api/chats/:chatId/task-links", ({ params, request }) => {
    const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",");
    const tasks = partsOf(String(params.chatId)).tasks.flatMap((item) =>
      ids.includes(item.task.chat.id)
        ? [
            {
              id: item.task.chat.id,
              name: item.task.chat.name,
              status: item.task.status ?? "active",
              endReason: item.task.endReason ?? null,
              from: String(params.chatId),
            },
          ]
        : [],
    );
    return HttpResponse.json({ tasks } satisfies TaskLinksResponse);
  }),
  // Held open without events: the tab reads again after its own actions.
  http.get("/api/chats/:chatId/tasks/events", () => {
    const stream = new ReadableStream({ start() {} });
    return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
  }),
  http.post("/api/chats/:chatId/tasks/:taskId/stop", ({ params }) => {
    const item = partsOf(String(params.chatId)).tasks.find(
      (found) => found.task.id === params.taskId,
    );
    if (!item) return notFound("task");
    const now = Date.now();
    // Stopped is a fact; Rome's own rule says what status it gives.
    const stopped = taskStatus(
      {
        stoppedAt: now,
        waitingSince: null,
        running: false,
        reportPending: false,
        laterAt: null,
        lastOutcome: null,
      },
      now,
    );
    item.task = {
      ...item.task,
      ...stopped,
      state: legacyTaskState(stopped),
      openWait: null,
      completedAt: now,
    };
    item.check = null;
    item.schedule = null;
    return HttpResponse.json({ ok: true });
  }),
];
